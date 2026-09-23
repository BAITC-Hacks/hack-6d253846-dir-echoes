import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, checkOrigin, errorResponse, requireViewer, signIn, signOut, viewer } from "@/lib/auth";
import { getDataset } from "@/lib/dataset";
import { consumeLimit, query, transaction } from "@/lib/db";
import { initialState } from "@/lib/domain";
import { processTurn } from "@/lib/conversation";
import { transcribeAudio, synthesizeSpeech } from "@/lib/ai";
import { asHandoff, getSessionDetail, listHandoffs, listSessions, redact, sessionRow, stats } from "@/lib/repository";
import type { Trace } from "@/lib/types";

export const runtime="nodejs";
export const maxDuration=60;
export const dynamic="force-dynamic";
type Context={params:Promise<{path:string[]}>};
const noStore={"Cache-Control":"no-store"};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:noStore});
async function body<T>(request:Request,schema:z.ZodType<T>):Promise<T>{
  if(Number(request.headers.get("content-length")||0)>20_000) throw new ApiError(413,"Слишком большой запрос.");
  const text=await request.text(); if(text.length>20_000) throw new ApiError(413,"Слишком большой запрос.");
  try { return schema.parse(JSON.parse(text)); } catch { throw new ApiError(400,"Проверьте поля запроса."); }
}
async function handle(request:Request,context:Context):Promise<Response>{
  const {path}=await context.params; const method=request.method;
  if(method!=="GET") checkOrigin(request);
  if(path.join("/")==="health" && method==="GET") return json({status:"ok",service:"DIR ECHOES Voice Router",version:"0.1.0"});
  if(path[0]==="auth"){
    if(method==="GET"){const user=await viewer();return json({authenticated:Boolean(user),role:user?.role??null});}
    if(method==="DELETE"){await signOut();return json({ok:true});}
    if(method==="POST"){
      const remote=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"local";
      const ipKey=createHash("sha256").update(remote).digest("hex").slice(0,24);
      if(!await consumeLimit(`login:${ipKey}`,12,900)) throw new ApiError(429,"Слишком много попыток входа. Повторите через 15 минут.");
      const data=await body(request,z.object({code:z.string().min(1).max(200),role:z.enum(["participant","supervisor"])}));
      const user=await signIn(data.code,data.role); return json({ok:true,role:user.role});
    }
  }
  const user=await requireViewer();
  if(path[0]==="bootstrap" && method==="GET"){
    const dataset=await getDataset();
    const [sessions,handoffs,metrics]=await Promise.all([listSessions(user),listHandoffs(user),stats(user)]);
    return json(redact({viewer:{role:user.role},stats:metrics,catalog:dataset.scenarios,sessions,handoffs,businessDate:dataset.businessDate,configured:{database:true,ai:Boolean(process.env.OPENAI_API_KEY)},datasetHash:dataset.hash}));
  }
  if(path[0]==="sessions"){
    const id=path[1];
    if(!id && method==="GET") return json(redact(await listSessions(user)));
    if(!id && method==="POST"){
      await getDataset();
      if(!await consumeLimit(`sessions:${user.id}`,20,3600)) throw new ApiError(429,"Достигнут часовой лимит новых разговоров.");
      const newId=randomUUID(); await query("INSERT INTO sessions(id,owner_id,title,state) VALUES($1,$2,'Новый разговор',$3::jsonb)",[newId,user.id,JSON.stringify(initialState())]);
      return json(await getSessionDetail(newId,user),201);
    }
    if(id && path.length===2 && method==="GET") return json(redact(await getSessionDetail(id,user)));
    if(id && path[2]==="export" && method==="GET"){
      const detail=redact(await getSessionDetail(id,user));
      return new Response(JSON.stringify({exportedAt:new Date().toISOString(),...detail},null,2),{headers:{...noStore,"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="echoes-${id}.json"`}});
    }
    if(id && path[2]==="turn" && method==="POST"){
      const data=await body(request,z.object({text:z.string().trim().min(1).max(3000),requestId:z.string().min(8).max(100),mode:z.enum(["text","voice"]).default("text"),sttMs:z.number().finite().min(0).max(120000).optional()}));
      return json(redact(await processTurn(id,user,data)));
    }
    if(id && path[2]==="metrics" && method==="POST"){
      await sessionRow(id,user);
      const data=await body(request,z.object({turnId:z.string(),playbackMs:z.number().finite().min(0).max(300000),ttsFirstByteMs:z.number().finite().min(0).max(120000).optional()}));
      await query("UPDATE turns SET trace=jsonb_set(trace,'{timings}',(trace->'timings') || $3::jsonb) WHERE session_id=$1 AND id=$2 AND status='completed'",[id,data.turnId,JSON.stringify({playback:data.playbackMs})]);
      return json({ok:true});
    }
  }
  if(path[0]==="transcribe" && method==="POST"){
    if(!await consumeLimit(`voice:${user.id}`,20,300)) throw new ApiError(429,"Слишком много голосовых запросов. Подождите немного.");
    if(Number(request.headers.get("content-length")||0)>3_500_000) throw new ApiError(413,"Запись слишком большая. Говорите не дольше 45 секунд.");
    const form=await request.formData(); const audio=form.get("audio");
    if(!(audio instanceof File)||audio.size<100||audio.size>3_000_000) throw new ApiError(400,"Нужна аудиозапись размером до 3 МБ.");
    if(!/^(audio\/(webm|mp4|mpeg|wav|x-wav|ogg)|video\/webm)/i.test(audio.type)) throw new ApiError(400,"Этот аудиоформат не поддерживается.");
    return json(await transcribeAudio(audio));
  }
  if(path[0]==="speech" && method==="POST"){
    const data=await body(request,z.object({sessionId:z.string(),turnId:z.string()}));
    const detail=await getSessionDetail(data.sessionId,user); const turn=detail.turns.find(t=>t.id===data.turnId);
    if(!turn) throw new ApiError(404,"Ответ не найден.");
    const speechText=redact(turn.assistantText);
    const textHash=createHash("sha256").update(speechText).update(process.env.TTS_MODEL||"gpt-4o-mini-tts").digest("hex");
    const readCached=()=>query<{data:Buffer;mime:string;first_byte_ms:number}>("SELECT data,mime,first_byte_ms FROM speech_audio WHERE turn_id=$1 AND text_hash=$2",[turn.id,textHash]);
    const audioResponse=(cached:{data:Buffer;mime:string;first_byte_ms:number})=>new Response(new Uint8Array(cached.data),{headers:{...noStore,"Content-Type":cached.mime,"X-TTS-First-Byte-Ms":String(cached.first_byte_ms),"X-Audio-Cached":"true"}});
    const cached=await readCached(); if(cached.rows[0]) return audioResponse(cached.rows[0]);
    if(!await consumeLimit(`tts:${user.id}`,30,300)) throw new ApiError(429,"Слишком много запросов озвучивания.");
    const leaseToken=randomUUID();
    const lease=await query("INSERT INTO speech_leases(turn_id,token,expires_at) VALUES($1,$2,now()+interval '60 seconds') ON CONFLICT(turn_id) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE speech_leases.expires_at<now() RETURNING token",[turn.id,leaseToken]);
    if(!lease.rows.length) throw new ApiError(409,"Этот ответ уже озвучивается. Попробуйте воспроизвести его через несколько секунд.");
    try {
      const fresh=await readCached(); if(fresh.rows[0]) return audioResponse(fresh.rows[0]);
      const speech=await synthesizeSpeech(speechText,turn.trace.responseLanguage || turn.trace.language);
      const bytes=new Uint8Array(await speech.response.arrayBuffer());
      const mime=speech.response.headers.get("content-type")||"audio/mpeg";
      if(bytes.length>4_000_000) throw new ApiError(502,"Ответ аудиосервиса слишком большой.");
      await query("INSERT INTO speech_audio(turn_id,text_hash,data,mime,first_byte_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(turn_id) DO UPDATE SET text_hash=EXCLUDED.text_hash,data=EXCLUDED.data,mime=EXCLUDED.mime,first_byte_ms=EXCLUDED.first_byte_ms",[turn.id,textHash,Buffer.from(bytes),mime,Math.round(speech.firstByteMs)]);
      await query("UPDATE turns SET trace=jsonb_set(trace,'{timings}',(trace->'timings') || $2::jsonb) WHERE id=$1",[turn.id,JSON.stringify({ttsFirstByte:Math.round(speech.firstByteMs)})]);
      return new Response(bytes,{headers:{...noStore,"Content-Type":mime,"X-TTS-First-Byte-Ms":String(Math.round(speech.firstByteMs))}});
    } finally { await query("DELETE FROM speech_leases WHERE turn_id=$1 AND token=$2",[turn.id,leaseToken]); }
  }
  if(path[0]==="handoffs" && path[1] && method==="PATCH"){
    await requireViewer("supervisor");
    const data=await body(request,z.object({status:z.enum(["active","closed"]),message:z.string().trim().max(2000).optional()}));
    const handoff=await transaction(async sql=>{
      const record=await sql.query<Record<string,unknown>>("SELECT * FROM handoffs WHERE id=$1 FOR UPDATE",[path[1]]);
      if(!record.rows[0]) throw new ApiError(404,"Обращение не найдено.");
      const row=record.rows[0]; const sessionId=String(row.session_id);
      const session=await sessionRow(sessionId,user,sql,true);
      if(row.status==="closed") throw new ApiError(409,"Обращение уже закрыто.");
      if(data.status==="closed") await sql.query("UPDATE sessions SET state=jsonb_set(state,'{status}','\"closed\"'::jsonb),version=version+1,updated_at=now() WHERE id=$1",[sessionId]);
      if(data.message){
        const trace:Trace={scenarios:[],alternatives:[],reason:"Ответ оператора",language:session.state.language,slots:{},actions:[],timings:{stt:null,router:0,executor:0,response:0,serverTotal:0},catalogHash:"",model:"human",usage:{inputTokens:0,outputTokens:0,estimatedUsd:0},source:"operator",warnings:[]};
        await sql.query("INSERT INTO turns(id,session_id,request_id,user_text,assistant_text,mode,trace,status) VALUES($1,$2,$3,'',$4,'operator',$5::jsonb,'completed')",[randomUUID(),sessionId,randomUUID(),data.message,JSON.stringify(trace)]);
        await sql.query("UPDATE sessions SET updated_at=now() WHERE id=$1",[sessionId]);
      }
      const updated=await sql.query("UPDATE handoffs SET status=$2,updated_at=now() WHERE id=$1 RETURNING *",[path[1],data.status]);
      return asHandoff(updated.rows[0] as Parameters<typeof asHandoff>[0]);
    });return json({handoff:redact(handoff)});
  }
  throw new ApiError(404,"Маршрут не найден.");
}
async function guarded(request:Request,context:Context){try{return await handle(request,context);}catch(error){return errorResponse(error);}}
export {guarded as GET,guarded as POST,guarded as PATCH,guarded as DELETE};
