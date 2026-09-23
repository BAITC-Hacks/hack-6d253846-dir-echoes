import { createHash, randomUUID } from "node:crypto";
import { ApiError, type Viewer } from "./auth";
import { transaction } from "./db";
import { asHandoff, redact, sessionRow } from "./repository";
import { languagePhrase, stateLanguages } from "./languages";
import type { Handoff, Trace } from "./types";

type OperatorCommand = { status: "active" | "closed"; message?: string; requestId: string };

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
