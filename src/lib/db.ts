import { Pool } from "pg";
import type { PGlite } from "@electric-sql/pglite";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
type Connection = { sql: Sql; transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close():Promise<void> };
const globals = globalThis as unknown as { echoesDb?: Promise<Connection>; echoesSchema?: Promise<void> };

const schema = `
CREATE TABLE IF NOT EXISTS dataset_versions (id text PRIMARY KEY, hash text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL,
  state jsonb NOT NULL, version integer NOT NULL DEFAULT 0,
  busy_until timestamptz, busy_token text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS turns (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), request_id text NOT NULL,
  user_text text NOT NULL, assistant_text text NOT NULL DEFAULT '', mode text NOT NULL,
  trace jsonb, status text NOT NULL DEFAULT 'processing', created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, request_id)
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, created_at);
CREATE TABLE IF NOT EXISTS entities (kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS handoffs (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), queue text NOT NULL,
  reason text NOT NULL, summary text NOT NULL, status text NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_handoff ON handoffs(session_id) WHERE status <> 'closed';
CREATE TABLE IF NOT EXISTS operator_commands (
  handoff_id text NOT NULL REFERENCES handoffs(id), request_id text NOT NULL,
  actor_id text NOT NULL, request_hash text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(handoff_id,request_id)
);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS review_annotations (id text PRIMARY KEY, turn_id text NOT NULL REFERENCES turns(id), reviewer_id text NOT NULL, expected_scenario text NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS speech_audio (turn_id text PRIMARY KEY REFERENCES turns(id), text_hash text NOT NULL, data bytea NOT NULL, mime text NOT NULL, first_byte_ms integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS speech_audio_content ON speech_audio(text_hash);
CREATE TABLE IF NOT EXISTS speech_content_leases (text_hash text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL);
`;

async function connect(): Promise<Connection> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 });
    const wrap = (client: { query: Pool["query"] }): Sql => ({ async query<T>(text: string, params: unknown[] = []) {
      const result = await client.query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } });
    return { sql: wrap(pool), close:()=>pool.end(), async transaction<T>(fn: (sql: Sql) => Promise<T>) {
      const client = await pool.connect();
      try { await client.query("BEGIN"); const result = await fn(wrap(client)); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } };
  }
  if (process.env.VERCEL || process.env.NODE_ENV === "production" && !process.env.LOCAL_DATABASE_PATH) {
    throw new Error("DATABASE_NOT_CONFIGURED: configure persistent PostgreSQL before deployment.");
  }
  const { PGlite: PGliteConstructor } = await import("@electric-sql/pglite");
  const localPath = process.env.LOCAL_DATABASE_PATH || path.join(process.cwd(), ".data", "postgres");
  await mkdir(path.dirname(localPath), { recursive: true });
  const local = new PGliteConstructor(localPath);
  await local.waitReady;
  const wrap = (client: Pick<PGlite, "query">): Sql => ({ async query<T>(text: string, params: unknown[] = []) {
    const result = await client.query<T>(text, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } });
  return { sql: wrap(local), close:()=>local.close(), transaction: fn => local.transaction(tx => fn(wrap(tx))) };
}

async function connection() {
  globals.echoesDb ??= connect().catch(error => { globals.echoesDb = undefined; throw error; });
  return globals.echoesDb;
}
export async function ensureDatabase() {
  const conn = await connection();
  globals.echoesSchema ??= conn.transaction(async sql => {
    // Serialize cold-start migrations across independently running Vercel instances.
    await sql.query("SELECT pg_advisory_xact_lock(684217389)");
    for (const statement of schema.split(";").map(s => s.trim()).filter(Boolean)) await sql.query(statement);
  }).catch(error => { globals.echoesSchema = undefined; throw error; });
  await globals.echoesSchema; return conn;
}
export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []) { return (await ensureDatabase()).sql.query<T>(text, params); }
export async function transaction<T>(fn: (sql: Sql) => Promise<T>) { return (await ensureDatabase()).transaction(fn); }
export async function closeDatabase() { if(globals.echoesDb) { const conn=await globals.echoesDb; globals.echoesDb=undefined;globals.echoesSchema=undefined;await conn.close(); } }

export async function consumeLimit(key: string, max: number, seconds: number) {
  const result = await query<{ count: number }>(`INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count+1 END,
    reset_at=CASE WHEN rate_limits.reset_at < now() THEN now()+$2*interval '1 second' ELSE rate_limits.reset_at END RETURNING count`, [key, seconds]);
  return result.rows[0].count <= max;
}
