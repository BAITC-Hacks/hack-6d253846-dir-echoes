import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, type Viewer } from "./auth";
import { consumeLimit, transaction, type Sql } from "./db";
import { recordErrorEvent } from "./error-events";
import { sessionRow } from "./repository";

const description = <T extends "offer" | "answer">(type: T) => z.object({
  type: z.literal(type),
  sdp: z.string().min(1).max(20_000).refine(value => Buffer.byteLength(value, "utf8") <= 20_000 && /^v=0\r?\n/.test(value) && /(?:^|\r?\n)m=audio /.test(value) && !/(?:^|\r?\n)m=(?:video|application) /.test(value), "Нужен SDP аудиосоединения до 20 КБ."),
}).strict();
export const operatorVoiceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("offer"), callId: z.string().uuid(), description: description("offer") }).strict(),
  z.object({ action: z.literal("answer"), callId: z.string().uuid(), description: description("answer") }).strict(),
  z.object({ action: z.literal("end"), callId: z.string().uuid() }).strict(),
]);
export type OperatorVoiceCommand = z.infer<typeof operatorVoiceCommandSchema>;
type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type OperatorVoiceState = {
  callId: string | null; status: "waiting" | "offered" | "connected" | "ended";
  offer?: { type: "offer"; sdp: string }; answer?: { type: "answer"; sdp: string };
  iceServers: IceServer[]; canOffer: boolean; canEnd: boolean;
};
type CallRow = {
  session_id: string; call_id: string; operator_id: string; status: "offered" | "connected" | "ended";
  offer_sdp: string | null; answer_sdp: string | null; offer_hash: string; answer_hash: string | null;
  offer_expires_at: Date | string; sdp_expires_at: Date | string;
};
const hash = (sdp: string) => createHash("sha256").update(sdp).digest("hex");

function iceServers(): IceServer[] {
  // Public STUN endpoint: https://developers.cloudflare.com/realtime/turn/
  const servers: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  const urls = (process.env.OPERATOR_TURN_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const username = process.env.OPERATOR_TURN_USERNAME;
  const credential = process.env.OPERATOR_TURN_CREDENTIAL;
  if (urls.length && username && credential && urls.length <= 4 && urls.every(value => /^turns?:[^\s/@]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(value) && value.length <= 300)) {
    // Only authenticated call members receive optional relay credentials.
    servers.push({ urls, username, credential });
  }
  return servers;
}

async function currentCall(sql: Sql, sessionId: string): Promise<CallRow | null> {
  await sql.query(`UPDATE operator_voice_calls SET
    status=CASE WHEN status='offered' AND offer_expires_at<=now() THEN 'ended' ELSE status END,
    offer_sdp=NULL,answer_sdp=NULL,updated_at=now()
    WHERE session_id=$1 AND ((status='offered' AND offer_expires_at<=now()) OR
      (sdp_expires_at<=now() AND (offer_sdp IS NOT NULL OR answer_sdp IS NOT NULL)))`, [sessionId]);
  const result = await sql.query<CallRow>("SELECT * FROM operator_voice_calls WHERE session_id=$1 FOR UPDATE", [sessionId]);
  return result.rows[0] ?? null;
}

async function activeHandoff(sql: Sql, sessionId: string, sessionStatus: string) {
  if (sessionStatus !== "handoff") return false;
  const result = await sql.query<{ id: string }>("SELECT id FROM handoffs WHERE session_id=$1 AND status='active' FOR SHARE", [sessionId]);
  return Boolean(result.rows[0]);
}

async function endCall(sql: Sql, sessionId: string) {
  await sql.query("UPDATE operator_voice_calls SET status='ended',offer_sdp=NULL,answer_sdp=NULL,updated_at=now() WHERE session_id=$1", [sessionId]);
}

function publicState(call: CallRow | null, viewer: Viewer, active: boolean): OperatorVoiceState {
  const status = !active ? "ended" : call?.status ?? "waiting";
  const isOperator = viewer.role === "supervisor" && call?.operator_id === viewer.id;
  const canOffer = viewer.role === "supervisor" && active && (!call || call.status === "ended");
  const result: OperatorVoiceState = { callId: call?.call_id ?? null, status, iceServers: active ? iceServers() : [], canOffer, canEnd: Boolean(call && call.status !== "ended" && (viewer.role === "participant" || isOperator)) };
  if (active && call && call.status !== "ended" && new Date(call.sdp_expires_at).getTime() > Date.now()) {
    if (viewer.role === "participant" && call.offer_sdp) result.offer = { type: "offer", sdp: call.offer_sdp };
    if (isOperator && call.answer_sdp) result.answer = { type: "answer", sdp: call.answer_sdp };
  }
  return result;
}

/** Durable signaling only; connected means an answer exists, not that audio is flowing. */
export async function getOperatorVoice(sessionId: string, viewer: Viewer): Promise<OperatorVoiceState> {
  try {
    return await transaction(async sql => {
      const session = await sessionRow(sessionId, viewer, sql, true);
      const active = await activeHandoff(sql, sessionId, session.state.status);
      let call = await currentCall(sql, sessionId);
      if (!active && call?.status !== "ended" && call) {
        await endCall(sql, sessionId);
        call = { ...call, status: "ended", offer_sdp: null, answer_sdp: null };
      }
      return publicState(call, viewer, active);
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status < 500)) await recordErrorEvent({ stage: "handoff", error, sessionId });
    throw error;
  }
}

export async function updateOperatorVoice(sessionId: string, viewer: Viewer, input: unknown): Promise<OperatorVoiceState> {
  try {
    const parsed = operatorVoiceCommandSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "Проверьте параметры аудиосоединения.");
    const command = parsed.data;
    if (!await consumeLimit(`operator-voice:${viewer.id}`, 60, 300)) throw new ApiError(429, "Слишком много попыток аудиосоединения. Подождите немного.");
    return await transaction(async sql => {
      // Same session -> handoff -> signaling order for reads and mutations.
      const session = await sessionRow(sessionId, viewer, sql, true);
      const active = await activeHandoff(sql, sessionId, session.state.status);
      let call = await currentCall(sql, sessionId);
      if (command.action === "end") {
        if (!call || call.call_id !== command.callId) throw new ApiError(409, "Это аудиосоединение уже заменено.");
        if (viewer.role === "supervisor" && call.operator_id !== viewer.id) throw new ApiError(403, "Аудиосоединение начато другим оператором.");
        await endCall(sql, sessionId);
        return publicState({ ...call, status: "ended", offer_sdp: null, answer_sdp: null }, viewer, active);
      }
      if (!active) throw new ApiError(409, "Сначала оператор должен принять активное обращение.");
      if (command.action === "offer") {
        if (viewer.role !== "supervisor") throw new ApiError(403, "Звонок начинает оператор.");
        const offerHash = hash(command.description.sdp);
        if (call?.call_id === command.callId) {
          if (call.operator_id !== viewer.id || call.offer_hash !== offerHash || call.status === "ended") throw new ApiError(409, "Идентификатор звонка уже использован. Начните новый звонок.");
          return publicState(call, viewer, active);
        }
        if (call && call.status !== "ended") throw new ApiError(409, "Аудиосоединение уже предложено или установлено. Сначала завершите его.");
        const saved = await sql.query<CallRow>(`INSERT INTO operator_voice_calls
          (session_id,call_id,operator_id,status,offer_sdp,offer_hash,offer_expires_at,sdp_expires_at)
          VALUES($1,$2,$3,'offered',$4,$5,now()+interval '2 minutes',now()+interval '2 minutes')
          ON CONFLICT(session_id) DO UPDATE SET call_id=EXCLUDED.call_id,operator_id=EXCLUDED.operator_id,
            status='offered',offer_sdp=EXCLUDED.offer_sdp,offer_hash=EXCLUDED.offer_hash,answer_sdp=NULL,answer_hash=NULL,
            offer_expires_at=EXCLUDED.offer_expires_at,sdp_expires_at=EXCLUDED.sdp_expires_at,updated_at=now()
          RETURNING *`, [sessionId, command.callId, viewer.id, command.description.sdp, offerHash]);
        return publicState(saved.rows[0], viewer, active);
      }
      if (viewer.role !== "participant") throw new ApiError(403, "На звонок отвечает участник разговора.");
      if (!call || call.call_id !== command.callId || call.status === "ended") throw new ApiError(409, "Предложение звонка истекло или заменено.");
      const answerHash = hash(command.description.sdp);
      if (call.status === "connected") {
        if (call.answer_hash !== answerHash) throw new ApiError(409, "Ответ на это предложение уже сохранён.");
        return publicState(call, viewer, active);
      }
      const saved = await sql.query<CallRow>(`UPDATE operator_voice_calls SET status='connected',answer_sdp=$2,answer_hash=$3,
        sdp_expires_at=now()+interval '2 minutes',updated_at=now() WHERE session_id=$1 RETURNING *`, [sessionId, command.description.sdp, answerHash]);
      call = saved.rows[0];
      return publicState(call, viewer, active);
    });
  } catch (error) {
    await recordErrorEvent({ stage: "handoff", error, sessionId });
    throw error;
  }
}
