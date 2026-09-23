import { ApiError, type Viewer } from "./auth";
import { query, transaction } from "./db";
import type { PresencePhase, SessionLive } from "./types";

export type PresenceRow = { live_phase?: PresencePhase | null; live_seen_at?: Date | string | null; live_expires_at?: Date | string | null };

export function asSessionLive(row: PresenceRow): SessionLive | null {
  if (!row.live_phase || !row.live_seen_at || !row.live_expires_at || new Date(row.live_expires_at).getTime() <= Date.now()) return null;
  return { active: true, phase: row.live_phase, lastSeenAt: new Date(row.live_seen_at).toISOString(), expiresAt: new Date(row.live_expires_at).toISOString() };
}

export async function getSessionPresence(sessionId: string): Promise<SessionLive | null> {
  const result = await query<PresenceRow>(`SELECT p.phase AS live_phase,p.last_seen_at AS live_seen_at,p.expires_at AS live_expires_at
    FROM session_presence p JOIN sessions s ON s.id=p.session_id
    WHERE p.session_id=$1 AND p.expires_at>now() AND s.state->>'status'='active'`, [sessionId]);
  return result.rows[0] ? asSessionLive(result.rows[0]) : null;
}

/** A short owner heartbeat, not a turn, microphone recording or operator presence. */
export async function updateSessionPresence(sessionId: string, viewer: Viewer, input: { active: boolean; phase: PresencePhase }): Promise<{ live: SessionLive | null }> {
  if (viewer.role !== "participant") throw new ApiError(403, "Активность звонка может обновить только клиент.");
  return transaction(async sql => {
    // Serialize with takeover/close without changing the conversational version.
    const result = await sql.query<{ owner_id: string; status: string }>("SELECT owner_id,state->>'status' AS status FROM sessions WHERE id=$1 FOR UPDATE", [sessionId]);
    const session = result.rows[0];
    if (!session || session.owner_id !== viewer.id) throw new ApiError(404, "Разговор не найден.");
    const active = input.active && session.status === "active";
    const saved = await sql.query<PresenceRow>(`INSERT INTO session_presence(session_id,phase,last_seen_at,expires_at)
      VALUES($1,$2,now(),now()+$3*interval '1 second')
      ON CONFLICT(session_id) DO UPDATE SET phase=EXCLUDED.phase,last_seen_at=EXCLUDED.last_seen_at,expires_at=EXCLUDED.expires_at
      RETURNING phase AS live_phase,last_seen_at AS live_seen_at,expires_at AS live_expires_at`, [sessionId, input.phase, active ? 15 : 0]);
    return { live: active ? asSessionLive(saved.rows[0]) : null };
  });
}
