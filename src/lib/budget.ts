import { randomUUID } from "node:crypto";
import { query, transaction } from "./db";

export type AiStage = "router" | "response" | "stt" | "tts";
export type BudgetReservation = { id: string; day: string; stage: AiStage; reservedUsd: number };
export class BudgetExceededError extends Error {
  readonly code = "estimated_ai_budget_exceeded";
  constructor() { super("Достигнут дневной лимит оценки расходов AI. Обратитесь к супервизору."); this.name = "BudgetExceededError"; }
}
export class BudgetConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "BudgetConfigurationError"; }
}
const MICROS_PER_USD = 1_000_000;
function micros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0 || usd > 1_000) throw new BudgetConfigurationError("Некорректная оценка стоимости AI.");
  return Math.ceil(usd * MICROS_PER_USD);
}
function capMicros(): number {
  const cap = Number(process.env.MAX_AI_SPEND_USD ?? "5");
  if (!Number.isFinite(cap) || cap < 0.05 || cap > 50) throw new BudgetConfigurationError("MAX_AI_SPEND_USD должен быть от 0.05 до 50 долларов.");
  return micros(cap);
}

let initialized: Promise<void> | undefined;
async function ensureBudget() {
  initialized ??= transaction(async (sql) => {
    // DDL itself is serialized across Vercel processes, independently of in-memory caching.
    await sql.query("SELECT pg_advisory_xact_lock(684217390)");
    await sql.query(`CREATE TABLE IF NOT EXISTS ai_budget_days (
      day date PRIMARY KEY, accounted_microusd bigint NOT NULL DEFAULT 0 CHECK(accounted_microusd >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.query(`CREATE TABLE IF NOT EXISTS ai_budget_ledger (
      id text PRIMARY KEY, day date NOT NULL REFERENCES ai_budget_days(day),
      stage text NOT NULL CHECK(stage IN ('router','response','stt','tts')),
      reserved_microusd bigint NOT NULL CHECK(reserved_microusd > 0),
      settled_microusd bigint CHECK(settled_microusd >= 0),
      status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','settled','unknown')),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.query("CREATE INDEX IF NOT EXISTS ai_budget_ledger_day ON ai_budget_ledger(day,stage)");
  }).catch((error) => { initialized = undefined; throw error; });
  await initialized;
}

/** App-estimated daily cap, not the provider's billing limit. Reserve before every paid call. */
export async function reserveBudget(input: { stage: AiStage; estimatedUsd: number; metadata?: Record<string, unknown> }): Promise<BudgetReservation> {
  const amount = Math.max(1, micros(input.estimatedUsd));
  const cap = capMicros();
  await ensureBudget();
  return transaction(async (sql) => {
    await sql.query("INSERT INTO ai_budget_days(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT(day) DO NOTHING");
    // Conditional increment locks the same daily row for all concurrent processes.
    const updated = await sql.query<{ day: string }>(`UPDATE ai_budget_days SET accounted_microusd=accounted_microusd+$1,updated_at=now()
      WHERE day=(now() AT TIME ZONE 'UTC')::date AND accounted_microusd+$1 <= $2 RETURNING day::text`, [amount, cap]);
    if (!updated.rows[0]) throw new BudgetExceededError();
    const reservation = { id: randomUUID(), day: updated.rows[0].day, stage: input.stage, reservedUsd: amount / MICROS_PER_USD };
    await sql.query("INSERT INTO ai_budget_ledger(id,day,stage,reserved_microusd,metadata) VALUES($1,$2,$3,$4,$5::jsonb)",
      [reservation.id, reservation.day, input.stage, amount, JSON.stringify(input.metadata ?? {})]);
    return reservation;
  });
}

/** Settle once. Missing/unknown provider usage must retain the original reservation. */
export async function settleBudget(reservation: BudgetReservation, result: { estimatedUsd: number; basis: string; usage?: Record<string, unknown> }): Promise<void> {
  const actual = micros(result.estimatedUsd);
  await ensureBudget();
  await transaction(async (sql) => {
    const selected = await sql.query<{ day: string; reserved_microusd: string; status: string }>(
      "SELECT day::text,reserved_microusd,status FROM ai_budget_ledger WHERE id=$1 FOR UPDATE", [reservation.id]);
    const row = selected.rows[0];
    if (!row) throw new Error("Budget reservation does not exist");
    if (row.status === "settled") return;
    const difference = actual - Number(row.reserved_microusd);
    // If a speech estimate was too small, preserve truthful accounting and block later calls.
    await sql.query("UPDATE ai_budget_days SET accounted_microusd=accounted_microusd+$2,updated_at=now() WHERE day=$1", [row.day, difference]);
    await sql.query("UPDATE ai_budget_ledger SET status='settled',settled_microusd=$2,metadata=metadata || $3::jsonb,updated_at=now() WHERE id=$1",
      [reservation.id, actual, JSON.stringify({ basis: result.basis, usage: result.usage ?? {} })]);
  });
}

/** No automatic expiry/release: a timeout or a crashed worker may still have been billed. */
export async function markBudgetUnknown(reservation: BudgetReservation): Promise<void> {
  await ensureBudget();
  await query("UPDATE ai_budget_ledger SET status='unknown',updated_at=now() WHERE id=$1 AND status='reserved'", [reservation.id]);
}

export async function getBudgetStatus() {
  const cap = capMicros();
  await ensureBudget();
  const result = await query<{ accounted: string; pending: string }>(`SELECT
    coalesce((SELECT accounted_microusd FROM ai_budget_days WHERE day=(now() AT TIME ZONE 'UTC')::date),0)::text AS accounted,
    (SELECT count(*) FROM ai_budget_ledger WHERE day=(now() AT TIME ZONE 'UTC')::date AND status<>'settled')::text AS pending`);
  const accounted = Number(result.rows[0].accounted);
  return { dailyLimitUsd: cap / MICROS_PER_USD, accountedUsd: accounted / MICROS_PER_USD, remainingUsd: Math.max(0, cap - accounted) / MICROS_PER_USD, pendingOrUnknownRequests: Number(result.rows[0].pending), accounting: "application_estimate" as const, dayBasis: "UTC" as const };
}
