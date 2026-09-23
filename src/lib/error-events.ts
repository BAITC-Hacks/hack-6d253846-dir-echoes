import { randomUUID } from "node:crypto";
import { query } from "./db";
import type { Viewer } from "./auth";

const stages = ["router", "executor", "reply", "stt", "tts", "api", "handoff", "catalog"] as const;
export type ErrorStage = typeof stages[number];
const messages = {
  invalid_input: "Запрос отклонён проверкой входных данных.",
  unauthorized: "Для запроса требуется вход в приложение.",
  forbidden: "Недостаточно прав для выполнения запроса.",
  not_found: "Запрошенная запись не найдена или недоступна.",
  conflict: "Состояние изменилось во время выполнения запроса.",
  rate_limited: "Достигнут лимит запросов или расходов.",
  timeout: "Превышено время ожидания операции.",
  provider_unavailable: "AI-сервис не завершил запрос.",
  storage_unavailable: "Операция с хранилищем не завершена.",
  stream_failed: "Передача аудио прервалась до завершения.",
  unexpected: "Операция завершилась технической ошибкой.",
} as const;
export type ErrorEventCode = keyof typeof messages;
export type ErrorEvent = {
  id: string; sessionId: string | null; turnId: string | null;
  stage: ErrorStage; code: ErrorEventCode; message: string; httpStatus: number | null;
  createdAt: string; sessionAvailable: boolean; turnAvailable: boolean;
};
type Input = {
  stage: ErrorStage; code?: ErrorEventCode; error?: unknown;
  sessionId?: string | null; turnId?: string | null; httpStatus?: number;
};
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
const status = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;

function classify(error: unknown, httpStatus: number | null, stage: ErrorStage): ErrorEventCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError" || httpStatus === 408 || httpStatus === 504) return "timeout";
  if (httpStatus === 401) return "unauthorized";
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 409) return "conflict";
  if (httpStatus === 429) return "rate_limited";
  if (httpStatus != null && httpStatus < 500) return "invalid_input";
  if (["router", "reply", "stt", "tts"].includes(stage)) return "provider_unavailable";
  return "unexpected";
}

/** Append a safe event; never replace the original failure if the journal is unavailable. */
export async function recordErrorEvent(input: Input): Promise<string | null> {
  try {
    const stage = stages.includes(input.stage) ? input.stage : "api";
    const errorStatus = input.error && typeof input.error === "object" && "status" in input.error ? input.error.status : undefined;
    const httpStatus = status(input.httpStatus) ?? status(errorStatus);
    const code = input.code && Object.hasOwn(messages, input.code) ? input.code : classify(input.error, httpStatus, stage);
    const id = randomUUID();
    // Only generated messages and validated internal identifiers are persisted.
    // No error.message, provider body, request text, audio, stack or secret is read.
    await query(`INSERT INTO error_events(id,session_id,turn_id,stage,code,safe_message,http_status)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, uuid(input.sessionId), uuid(input.turnId), stage, code, messages[code], httpStatus]);
    return id;
  } catch {
    console.warn("Error event journal unavailable");
    return null;
  }
}

/** Attempts remain visible even when their failed turn is replaced on retry. */
export async function listErrorEvents(viewer: Viewer): Promise<ErrorEvent[]> {
  if (viewer.role !== "supervisor") throw new Error("Supervisor access required");
  const result = await query<{
    id: string; session_id: string | null; turn_id: string | null; stage: ErrorStage;
    code: ErrorEventCode; safe_message: string; http_status: number | null;
    created_at: Date | string; session_available: boolean; turn_available: boolean;
  }>(`SELECT e.*,EXISTS(SELECT 1 FROM sessions s WHERE s.id=e.session_id) AS session_available,
    EXISTS(SELECT 1 FROM turns t WHERE t.id=e.turn_id AND t.session_id=e.session_id AND t.status='completed') AS turn_available
    FROM error_events e ORDER BY e.created_at DESC,e.id DESC LIMIT 50`);
  return result.rows.map(row => ({
    id: row.id, sessionId: row.session_id, turnId: row.turn_id, stage: row.stage,
    code: row.code, message: row.safe_message, httpStatus: row.http_status,
    createdAt: new Date(row.created_at).toISOString(), sessionAvailable: row.session_available, turnAvailable: row.turn_available,
  }));
}
