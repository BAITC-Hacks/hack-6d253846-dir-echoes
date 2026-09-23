import { randomUUID } from "node:crypto";
import { query, type Sql } from "./db";
import { ApiError, type Viewer } from "./auth";
import { redactPersonalText } from "./privacy";
import type { DialogueState, EntityStore, Handoff, JsonObject, Session, SessionDetail, Trace, Turn } from "./types";

type SessionRow = { id: string; owner_id: string; title: string; state: DialogueState; version: number; created_at: Date | string; updated_at: Date | string; turn_count?: string | number; busy_token?: string; busy_until?: Date | string };
type TurnRow = { id: string; session_id: string; request_id: string; user_text: string; assistant_text: string; mode: Turn["mode"]; trace: Trace; created_at: Date | string };
type HandoffRow = { id: string; session_id: string; queue: string; reason: string; summary: string; status: Handoff["status"]; created_at: Date | string; updated_at: Date | string };
const iso = (date: Date | string) => new Date(date).toISOString();
export function asSession(row: SessionRow): Session { return { id: row.id, title: row.title, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), state: row.state, version: row.version, turnCount: Number(row.turn_count || 0) }; }
export function asHandoff(row: HandoffRow): Handoff { return { id: row.id, sessionId: row.session_id, queue: row.queue, reason: row.reason, summary: row.summary, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }
export async function sessionRow(id: string, viewer: Viewer, sql: Sql = { query }, forUpdate = false) {
  const result = await sql.query<SessionRow>(`SELECT * FROM sessions WHERE id=$1 ${forUpdate ? "FOR UPDATE" : ""}`, [id]);
  const row = result.rows[0];
  if (!row || viewer.role !== "supervisor" && row.owner_id !== viewer.id) throw new ApiError(404,"Разговор не найден.");
  return row;
}
export async function listSessions(viewer: Viewer) {
  const result = await query<SessionRow>(`SELECT s.*, (SELECT count(*) FROM turns t WHERE t.session_id=s.id AND t.status='completed') AS turn_count
    FROM sessions s WHERE ($1='supervisor' OR s.owner_id=$2) ORDER BY s.updated_at DESC LIMIT 100`, [viewer.role, viewer.id]);
  return result.rows.map(asSession);
}
export async function getSessionDetail(id: string, viewer: Viewer): Promise<SessionDetail> {
  const row = await sessionRow(id,viewer);
  // Recover a durable action/fallback if a server process stopped during wording.
  if(!row.busy_until || new Date(row.busy_until).getTime()<=Date.now()) await query("UPDATE turns SET status='completed' WHERE session_id=$1 AND status='finalizing' AND EXISTS (SELECT 1 FROM sessions WHERE id=$1 AND (busy_until IS NULL OR busy_until<=now()))",[id]);
  const [result,handoffs] = await Promise.all([
    query<TurnRow>("SELECT * FROM turns WHERE session_id=$1 AND status='completed' ORDER BY created_at,id",[id]),
    query<HandoffRow>("SELECT * FROM handoffs WHERE session_id=$1 ORDER BY created_at DESC",[id])
  ]);
  const turns: Turn[] = result.rows.map(t => ({ id:t.id,sessionId:t.session_id,requestId:t.request_id,userText:t.user_text,assistantText:t.assistant_text,trace:t.trace,mode:t.mode,createdAt:iso(t.created_at) }));
  return {session:{...asSession(row),turnCount:turns.length},turns,handoffs:handoffs.rows.map(asHandoff)};
}
export async function listHandoffs(viewer: Viewer) {
  if (viewer.role !== "supervisor") return [];
  return (await query<HandoffRow>("SELECT * FROM handoffs ORDER BY (status='waiting') DESC,created_at DESC LIMIT 100")).rows.map(asHandoff);
}
export function entityStore(sql: Sql): EntityStore { return {
  async list(kind) { return (await sql.query<{data:JsonObject}>("SELECT data FROM entities WHERE kind=$1 ORDER BY id FOR UPDATE",[kind])).rows.map(r=>r.data); },
  async get(kind,id) { return (await sql.query<{data:JsonObject}>("SELECT data FROM entities WHERE kind=$1 AND id=$2 FOR UPDATE",[kind,id])).rows[0]?.data || null; },
  async put(kind,id,data) { await sql.query("INSERT INTO entities(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()",[kind,id,JSON.stringify(data)]); }
}; }
export async function putHandoff(sql: Sql, sessionId: string, queue: string, reason: string, summary: string) {
  await sql.query("INSERT INTO handoffs(id,session_id,queue,reason,summary) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id) WHERE status <> 'closed' DO UPDATE SET queue=EXCLUDED.queue,reason=EXCLUDED.reason,summary=EXCLUDED.summary,updated_at=now()",[randomUUID(),sessionId,queue,reason,summary]);
}
function maskString(value: string) { return redactPersonalText(value); }
export function redact<T>(value: T): T {
  if (typeof value === "string") return maskString(value) as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(item)])) as T;
  return value;
}
export async function stats(viewer: Viewer) {
  const result = await query<{sessions:string;turns:string;handoffs:string;median:string|null}>(`SELECT
    (SELECT count(*) FROM sessions WHERE $1='supervisor' OR owner_id=$2) AS sessions,
    (SELECT count(*) FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='completed' AND ($1='supervisor' OR s.owner_id=$2)) AS turns,
    (SELECT count(*) FROM handoffs h JOIN sessions s ON s.id=h.session_id WHERE h.status<>'closed' AND ($1='supervisor' OR s.owner_id=$2)) AS handoffs,
    (SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY (t.trace->'timings'->>'router')::double precision) FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='completed' AND t.trace->>'source' IN ('llm','slot','confirmation','catalog_example','social') AND ($1='supervisor' OR s.owner_id=$2)) AS median`,[viewer.role,viewer.id]);
  const row=result.rows[0]; return {sessions:Number(row.sessions),turns:Number(row.turns),handoffs:Number(row.handoffs),medianRoutingMs:row.median==null?null:Math.round(Number(row.median))};
}
