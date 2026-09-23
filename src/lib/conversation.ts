import { randomUUID } from "node:crypto";
import { ApiError, type Viewer } from "./auth";
import { query, transaction, consumeLimit } from "./db";
import { getDataset } from "./dataset";
import { routeUtterance, composeReply, shouldComposeReply } from "./ai";
import { executeTurn } from "./domain";
import { entityStore, getSessionDetail, sessionRow, putHandoff, redact } from "./repository";
import type { ChatEntry, ExecuteOutput, Trace } from "./types";

export async function processTurn(sessionId: string, viewer: Viewer, input: {text:string;requestId:string;mode:"text"|"voice";sttMs?:number}) {
  const started=performance.now();
  const dataset=await getDataset();
  let prior=await getSessionDetail(sessionId,viewer);
  if (!await consumeLimit(`turn:${viewer.id}`,30,300)) throw new ApiError(429,"Слишком много запросов. Подождите немного.");
  const turnId=randomUUID();
  const replay=await transaction(async sql=>{
    const row=await sessionRow(sessionId,viewer,sql,true);
    if(!row.busy_until || new Date(row.busy_until).getTime()<=Date.now()) await sql.query("UPDATE turns SET status='completed' WHERE session_id=$1 AND status='finalizing'",[sessionId]);
    const duplicate=await sql.query<{status:string;user_text:string;mode:string}>("SELECT status,user_text,mode FROM turns WHERE session_id=$1 AND request_id=$2",[sessionId,input.requestId]);
    if(duplicate.rows[0] && (duplicate.rows[0].user_text!==input.text || duplicate.rows[0].mode!==input.mode)) throw new ApiError(409,"Этот идентификатор запроса уже использован для другой реплики.");
    if(duplicate.rows[0]?.status==="completed") return true;
    if(row.busy_until && new Date(row.busy_until).getTime()>Date.now()) throw new ApiError(409,"Предыдущая реплика ещё обрабатывается.");
    if(row.state.status==="closed") throw new ApiError(409,"Разговор завершён. Начните новый разговор.");
    if(prior.turns.length>=60) throw new ApiError(409,"В разговоре достигнут лимит реплик. Начните новый разговор.");
    await sql.query("DELETE FROM turns WHERE session_id=$1 AND request_id=$2 AND status IN ('processing','failed')",[sessionId,input.requestId]);
    await sql.query("INSERT INTO turns(id,session_id,request_id,user_text,mode) VALUES($1,$2,$3,$4,$5)",[turnId,sessionId,input.requestId,input.text,input.mode]);
    await sql.query("UPDATE sessions SET busy_until=now()+interval '100 seconds',busy_token=$2 WHERE id=$1",[sessionId,turnId]);
    return false;
  });
  if(replay) return getSessionDetail(sessionId,viewer);
  prior=await getSessionDetail(sessionId,viewer);
  const history:ChatEntry[]=prior.turns.slice(-10).flatMap(turn=>[{role:"user" as const,content:turn.userText},{role:"assistant" as const,content:turn.assistantText}]);
  let committed=false;
  try {
    if(prior.session.state.status==="handoff") {
      const trace:Trace={scenarios:[],alternatives:[],reason:"Сообщение клиента сохранено в обращении для оператора",language:prior.session.state.language,slots:{},actions:[],timings:{stt:input.sttMs??null,router:0,executor:0,response:0,serverTotal:Math.round(performance.now()-started)},catalogHash:dataset.hash,model:"operator_queue",usage:{inputTokens:0,outputTokens:0,estimatedUsd:0},source:"operator",warnings:[]};
      await transaction(async sql=>{
        await sessionRow(sessionId,viewer,sql,true);
        await sql.query("UPDATE turns SET assistant_text=$2,trace=$3::jsonb,status='completed' WHERE id=$1",[turnId,"Сообщение сохранено в обращении. Оператор увидит его в истории.",JSON.stringify(trace)]);
        await sql.query("UPDATE sessions SET version=version+1,updated_at=now() WHERE id=$1",[sessionId]);
        await sql.query("UPDATE handoffs SET summary=right(summary || $2,6000),updated_at=now() WHERE session_id=$1 AND status<>'closed'",[sessionId,redact(`\nКлиент: ${input.text}`)]);
      });
      committed=true; return getSessionDetail(sessionId,viewer);
    }
    const routed=await routeUtterance({dataset,state:prior.session.state,history,text:input.text});
    const executionStart=performance.now();
    let execution:ExecuteOutput;
    let trace:Trace;
    await transaction(async sql=>{
      const current=await sessionRow(sessionId,viewer,sql,true);
      if(current.busy_token!==turnId || current.version!==prior.session.version) throw new ApiError(409,"Разговор изменился. Обновите историю перед следующей репликой.");
      execution=await executeTurn({dataset,state:structuredClone(current.state),decision:routed.decision,text:input.text,store:entityStore(sql),sessionId,requestId:input.requestId});
      trace={scenarios:routed.decision.scenarios,alternatives:routed.decision.alternatives,reason:routed.decision.reason,language:routed.decision.language,responseLanguage:routed.decision.responseLanguage,slots:routed.decision.slots,actions:execution.actions,
        timings:{stt:input.mode==="voice"?input.sttMs??null:null,router:routed.elapsedMs,executor:Math.round(performance.now()-executionStart),response:0,serverTotal:Math.round(performance.now()-started)},
        catalogHash:dataset.hash,model:routed.model,usage:{inputTokens:routed.inputTokens,outputTokens:routed.outputTokens,estimatedUsd:routed.estimatedUsd},source:"llm",warnings:execution.warnings};
      if(execution.handoff) await putHandoff(sql,sessionId,execution.handoff.queue,execution.handoff.reason,redact([...history.slice(-6).map(t=>`${t.role}: ${t.content}`),`user: ${input.text}`,`assistant: ${execution.reply}`].join("\n")).slice(0,6000));
      await sql.query("UPDATE sessions SET state=$2::jsonb,version=version+1,title=CASE WHEN title='Новый разговор' THEN $3 ELSE title END,updated_at=now() WHERE id=$1",[sessionId,JSON.stringify(execution.state),redact(input.text).slice(0,70)]);
      await sql.query("UPDATE turns SET assistant_text=$2,trace=$3::jsonb,status='finalizing' WHERE id=$1",[turnId,execution.reply,JSON.stringify(trace)]);
    });
    committed=true;
    // The action and a grounded fallback response are durable before optional wording.
    let reply=execution!.reply;
    if(shouldComposeReply(execution!)) {
      try {
        const composed=await composeReply({dataset,state:execution!.state,decision:routed.decision,execution:execution!,history});
        reply=composed.text;
        trace!.timings.response=composed.elapsedMs;
        trace!.usage.inputTokens+=composed.inputTokens; trace!.usage.outputTokens+=composed.outputTokens; trace!.usage.estimatedUsd+=composed.estimatedUsd;
      } catch { trace!.warnings.push("Формулировка ответа не улучшена из-за ошибки API; показан сохранённый ответ исполнителя."); }
    }
    trace!.timings.serverTotal=Math.round(performance.now()-started);
    await query("UPDATE turns SET assistant_text=$2,trace=$3::jsonb,status='completed' WHERE id=$1",[turnId,reply,JSON.stringify(trace!)]);
    return await getSessionDetail(sessionId,viewer);
  } catch(error) {
    if(committed) { await query("UPDATE turns SET status='completed' WHERE id=$1 AND status='finalizing'",[turnId]); return await getSessionDetail(sessionId,viewer); }
    await query("UPDATE turns SET status='failed' WHERE id=$1",[turnId]);
    throw error;
  } finally { await query("UPDATE sessions SET busy_until=NULL,busy_token=NULL WHERE id=$1 AND busy_token=$2",[sessionId,turnId]); }
}
