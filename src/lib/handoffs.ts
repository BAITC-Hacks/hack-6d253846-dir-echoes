import { createHash, randomUUID } from "node:crypto";
import { ApiError, type Viewer } from "./auth";
import { transaction } from "./db";
import { asHandoff, redact, sessionRow } from "./repository";
import { languagePhrase, stateLanguages } from "./languages";
import type { Handoff, Trace } from "./types";

type OperatorCommand = { status: "active" | "closed"; message?: string; requestId: string };

/** Session lock fences AI execution; a completed company operation is never undone. */
export async function takeoverSession(sessionId: string, viewer: Viewer, requestId: string): Promise<{ handoff: Handoff; sessionId: string }> {
  if (viewer.role !== "supervisor") throw new ApiError(403, "Нужен доступ супервизора.");
  const commandId = `takeover:${requestId}`;
  const requestHash = createHash("sha256").update(JSON.stringify(["takeover", sessionId])).digest("hex");
  return transaction(async sql => {
    const session = await sessionRow(sessionId, viewer, sql, true);
    // Look across closed handoffs too: a retry returns its original receipt.
    const duplicate = await sql.query<{ actor_id: string; request_hash: string; result: Handoff }>(
      "SELECT c.actor_id,c.request_hash,c.result FROM operator_commands c JOIN handoffs h ON h.id=c.handoff_id WHERE h.session_id=$1 AND c.request_id=$2", [sessionId, commandId],
    );
    if (duplicate.rows[0]) {
      const prior = duplicate.rows[0];
      if (prior.actor_id !== viewer.id || prior.request_hash !== requestHash) throw new ApiError(409, "Этот идентификатор перехвата уже использован другим оператором.");
      return { handoff: prior.result, sessionId };
    }
    if (session.state.status === "closed") throw new ApiError(409, "Разговор уже завершён.");
    const existing = await sql.query<Parameters<typeof asHandoff>[0]>("SELECT * FROM handoffs WHERE session_id=$1 AND status<>'closed' FOR UPDATE", [sessionId]);
    let row = existing.rows[0];
    const alreadyActive = session.state.status === "handoff" && row?.status === "active";
    if (!alreadyActive) {
      const languages = stateLanguages(session.state);
      const notice = languagePhrase(languages, {
        ru: "Оператор подключился и продолжит разговор. AI остановлен; уже выполненные действия сохранены.",
        kk: "Оператор қосылып, әңгімені жалғастырады. AI тоқтатылды; орындалған әрекеттер сақталды.",
        tr: "Operatör bağlandı ve görüşmeyi sürdürecek. AI durduruldu; tamamlanan işlemler korundu.",
        ru_kk: "Оператор подключился и продолжит разговор. AI тоқтатылды; орындалған әрекеттер сақталды.",
        ru_tr: "Оператор подключился. AI durduruldu; tamamlanan işlemler korundu.",
        kk_tr: "Оператор қосылды. AI durduruldu; tamamlanan işlemler korundu.",
        other: "The operator has taken over this conversation. AI is stopped; completed operations are preserved.",
      });
      const trace: Trace = {
        scenarios: [], alternatives: [], reason: languagePhrase(languages, { ru: "Супервизор перехватил разговор; дальнейшее выполнение AI остановлено.", kk: "Супервизор әңгімені қабылдады; AI әрекеттері тоқтатылды.", tr: "Süpervizör görüşmeyi devraldı; AI işlemleri durduruldu.", other: "Supervisor took over the conversation and fenced AI execution." }),
        language: session.state.language, responseLanguage: session.state.language, responseLanguages: languages,
        slots: { operatorActorId: viewer.id, takeover: true }, actions: [],
        timings: { stt: null, router: 0, executor: 0, response: 0, serverTotal: 0 }, catalogHash: "", model: "human",
        usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }, source: "operator", warnings: [],
      };
      // Preserve the durable fallback and action trace if execution already committed.
      await sql.query("UPDATE turns SET status='completed' WHERE session_id=$1 AND status='finalizing'", [sessionId]);
      // Retain the client's latest input even if the router is still in flight.
      const inputSaved = languagePhrase(languages, { ru: "Реплика сохранена для оператора.", kk: "Хабарлама операторға сақталды.", tr: "Mesajınız operatör için kaydedildi.", ru_kk: "Реплика операторға сақталды.", ru_tr: "Реплика operatör için kaydedildi.", kk_tr: "Хабарлама operatör için kaydedildi.", other: "Your message was saved for the operator." });
      await sql.query("UPDATE turns SET assistant_text=$2,trace=$3::jsonb,status='completed' WHERE session_id=$1 AND status='processing'", [sessionId, inputSaved, JSON.stringify(trace)]);
      const context = await sql.query<{ user_text: string; assistant_text: string }>("SELECT user_text,assistant_text FROM turns WHERE session_id=$1 AND status='completed' ORDER BY created_at DESC,id DESC LIMIT 8", [sessionId]);
      const summary = redact(context.rows.reverse().map(turn => [turn.user_text ? `Клиент: ${turn.user_text}` : "", turn.assistant_text ? `Ответ: ${turn.assistant_text}` : ""].filter(Boolean).join("\n")).join("\n")).slice(-6000);
      if (row) {
        const updated = await sql.query<Parameters<typeof asHandoff>[0]>("UPDATE handoffs SET status='active',summary=$2,updated_at=now() WHERE id=$1 RETURNING *", [row.id, summary]);
        row = updated.rows[0];
      } else {
        const inserted = await sql.query<Parameters<typeof asHandoff>[0]>("INSERT INTO handoffs(id,session_id,queue,reason,summary,status) VALUES($1,$2,'operator_general','Supervisor takeover',$3,'active') RETURNING *", [randomUUID(), sessionId, summary]);
        row = inserted.rows[0];
      }
      const state = { ...session.state, status: "handoff", pendingConfirmation: null };
      await sql.query("UPDATE sessions SET state=$2::jsonb,busy_until=NULL,busy_token=NULL,version=version+1,updated_at=now() WHERE id=$1", [sessionId, JSON.stringify(state)]);
      trace.slots.handoffId = row.id;
      await sql.query("INSERT INTO turns(id,session_id,request_id,user_text,assistant_text,mode,trace,status) VALUES($1,$2,$3,'',$4,'operator',$5::jsonb,'completed')", [randomUUID(), sessionId, `operator:takeover:${randomUUID()}`, notice, JSON.stringify(trace)]);
    }
    if (!row) throw new ApiError(500, "Не удалось сохранить перехват разговора.");
    const handoff = asHandoff(row);
    await sql.query("INSERT INTO operator_commands(handoff_id,request_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)", [row.id, commandId, viewer.id, requestHash, JSON.stringify(handoff)]);
    return { handoff, sessionId };
  });
}

/** A lost HTTP response must not create a second operator message on retry. */
export async function updateHandoff(id: string, viewer: Viewer, command: OperatorCommand): Promise<Handoff> {
  if (viewer.role !== "supervisor") throw new ApiError(403, "Нужен доступ супервизора.");
  const message = command.message?.trim() || "";
  const requestHash = createHash("sha256").update(JSON.stringify([command.status, message])).digest("hex");
  return transaction(async sql => {
    const reference = await sql.query<{ session_id: string }>("SELECT session_id FROM handoffs WHERE id=$1", [id]);
    if (!reference.rows[0]) throw new ApiError(404, "Обращение не найдено.");
    const sessionId = reference.rows[0].session_id;
    // Keep the same lock order as conversation processing: session, then handoff.
    const session = await sessionRow(sessionId, viewer, sql, true);
    const record = await sql.query<Parameters<typeof asHandoff>[0]>("SELECT * FROM handoffs WHERE id=$1 FOR UPDATE", [id]);
    const row = record.rows[0];
    if (!row) throw new ApiError(404, "Обращение не найдено.");
    const duplicate = await sql.query<{ actor_id: string; request_hash: string; result: Handoff }>(
      "SELECT actor_id,request_hash,result FROM operator_commands WHERE handoff_id=$1 AND request_id=$2", [id, command.requestId],
    );
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].actor_id !== viewer.id || duplicate.rows[0].request_hash !== requestHash) {
        throw new ApiError(409, "Этот идентификатор запроса уже использован для другого действия оператора.");
      }
      return duplicate.rows[0].result;
    }
    if (row.status === "closed") throw new ApiError(409, "Обращение уже закрыто.");
    if (command.status === "closed" && session.busy_until && new Date(session.busy_until).getTime() > Date.now()) {
      throw new ApiError(409, "Сообщение клиента ещё сохраняется. Дождитесь его появления в истории и повторите закрытие.");
    }
    const changed = row.status !== command.status;
    if (command.status === "closed") {
      await sql.query("UPDATE sessions SET state=jsonb_set(state,'{status}','\"closed\"'::jsonb),version=version+1,updated_at=now() WHERE id=$1", [sessionId]);
    }
    const responseLanguages = stateLanguages(session.state);
    const statusMessage = command.status === "closed"
      ? languagePhrase(responseLanguages, { ru: "Оператор завершил обращение.", kk: "Оператор өтінішті аяқтады.", tr: "Operatör talebi tamamladı.", ru_kk: "Оператор обращение аяқтады.", ru_tr: "Оператор talebi tamamladı.", kk_tr: "Оператор өтінішті tamamladı.", other: "[LANGUAGE_TRANSLATION_REQUIRED] The operator closed this request." })
      : languagePhrase(responseLanguages, { ru: "Оператор принял обращение в работу.", kk: "Оператор өтінішті қабылдады.", tr: "Operatör talebi işleme aldı.", ru_kk: "Оператор обращение қабылдады.", ru_tr: "Оператор talebi işleme aldı.", kk_tr: "Оператор өтінішті işleme aldı.", other: "[LANGUAGE_TRANSLATION_REQUIRED] The operator accepted this request." });
    const reply = [changed ? statusMessage : "", message].filter(Boolean).join("\n\n");
    if (reply) {
      const trace: Trace = {
        scenarios: [], alternatives: [], reason: changed
          ? languagePhrase(responseLanguages, { ru: "Изменение статуса обращения оператором", kk: "Оператор өтініш мәртебесін өзгертті", tr: "Operatör talebin durumunu değiştirdi.", ru_tr: "Статус обращения operatör tarafından değiştirildi.", kk_tr: "Өтініш мәртебесі operatör tarafından değiştirildi.", other: "Request status changed by the operator." })
          : languagePhrase(responseLanguages, { ru: "Ответ оператора", kk: "Оператор жауабы", tr: "Operatör yanıtı", ru_tr: "Ответ оператора: operatör yanıtı", kk_tr: "Оператор жауабы: operatör yanıtı", other: "Operator reply." }),
        language: session.state.language, responseLanguage: session.state.language, responseLanguages, slots: { handoffId: id, status: command.status }, actions: [],
        timings: { stt: null, router: 0, executor: 0, response: 0, serverTotal: 0 }, catalogHash: "", model: "human",
        usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }, source: "operator", warnings: [],
      };
      await sql.query("INSERT INTO turns(id,session_id,request_id,user_text,assistant_text,mode,trace,status) VALUES($1,$2,$3,'',$4,'operator',$5::jsonb,'completed')",
        [randomUUID(), sessionId, `operator:${id}:${command.requestId}`, reply, JSON.stringify(trace)]);
      await sql.query("UPDATE sessions SET updated_at=now() WHERE id=$1", [sessionId]);
    }
    const updated = await sql.query<Parameters<typeof asHandoff>[0]>(
      "UPDATE handoffs SET status=$2,summary=CASE WHEN $3='' THEN summary ELSE right(summary || $3,6000) END,updated_at=now() WHERE id=$1 RETURNING *",
      [id, command.status, reply ? redact(`\nОператор: ${reply}`) : ""],
    );
    const result = asHandoff(updated.rows[0]);
    await sql.query("INSERT INTO operator_commands(handoff_id,request_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)",
      [id, command.requestId, viewer.id, requestHash, JSON.stringify(result)]);
    return result;
  });
}
