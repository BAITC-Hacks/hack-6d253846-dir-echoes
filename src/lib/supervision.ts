import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError, type Viewer } from "./auth";
import { query, transaction } from "./db";
import { redact } from "./repository";
import type { Dataset, Scenario, Trace } from "./types";

const fixedIds = Array.from({ length: 40 }, (_, i) => `SC${String(i + 1).padStart(2, "0")}`);
const examplesSchema = z.array(z.string().trim().min(3).max(300)).min(1).max(8);
export const catalogPatchSchema = z.object({
  name: z.string().trim().min(3).max(100).optional(),
  description: z.string().trim().min(10).max(1000).optional(),
  examples: z.object({ ru: examplesSchema.optional(), kk: examplesSchema.optional() }).strict().refine(value => Object.keys(value).length > 0, "Укажите примеры на одном из языков.").optional(),
  not_this_if: z.array(z.object({ condition: z.string().trim().min(3).max(300), use_instead: z.enum(fixedIds as [string, ...string[]]) }).strict()).max(8).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Изменения не указаны.");
export type CatalogPatch = z.infer<typeof catalogPatchSchema>;

type RevisionRow = { id: string; hash: string; base_hash: string; parent_hash: string; scenario_id: string; editor_id: string; scenarios: Scenario[]; patch: CatalogPatch; created_at: Date | string };
type ReviewRow = { id: string; turn_id: string; reviewer_id: string; expected_scenario: string; note: string; created_at: Date | string; session_id?: string; user_text?: string; actual_scenario?: string | null };
const dateString = (value: Date | string) => new Date(value).toISOString();
const assertSupervisor = (viewer: Viewer) => { if (viewer.role !== "supervisor") throw new ApiError(403, "Доступно только супервизору."); };
let schemaReady: Promise<void> | undefined;

export async function ensureSupervision() {
  schemaReady ??= transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(684217393)");
    await sql.query("CREATE UNIQUE INDEX IF NOT EXISTS one_review_per_reviewer_turn ON review_annotations(reviewer_id,turn_id)");
    await sql.query(`CREATE TABLE IF NOT EXISTS catalog_revisions (
      id text PRIMARY KEY, hash text NOT NULL UNIQUE, base_hash text NOT NULL, parent_hash text NOT NULL,
      scenario_id text NOT NULL, editor_id text NOT NULL, scenarios jsonb NOT NULL, patch jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), revision_number bigserial NOT NULL
    )`);
    await sql.query("ALTER TABLE catalog_revisions ADD COLUMN IF NOT EXISTS revision_number bigserial");
    await sql.query("CREATE INDEX IF NOT EXISTS catalog_revisions_latest ON catalog_revisions(base_hash,created_at DESC,id DESC)");
  }).catch(error => { schemaReady = undefined; throw error; });
  await schemaReady;
}

/** Reads only the overlay for the currently imported seed; the organizer seed is never edited. */
export async function readCatalogRevision(): Promise<{ hash: string; baseHash: string; scenarios: Scenario[] } | null> {
  await ensureSupervision();
  const result = await query<RevisionRow>(`SELECT r.* FROM catalog_revisions r JOIN dataset_versions d ON d.id='current' AND d.hash=r.base_hash
    ORDER BY r.revision_number DESC LIMIT 1`);
  const row = result.rows[0];
  return row ? { hash: row.hash, baseHash: row.base_hash, scenarios: row.scenarios } : null;
}

function revisionSummary(row: RevisionRow) {
  return { id: row.id, hash: row.hash, baseHash: row.base_hash, parentHash: row.parent_hash, scenarioId: row.scenario_id, editorId: row.editor_id, fields: Object.keys(row.patch), createdAt: dateString(row.created_at) };
}

export async function saveCatalogRevision(input: { dataset: Dataset; expectedHash: string; scenarioId: string; patch: unknown; viewer: Viewer }) {
  assertSupervisor(input.viewer);
  if (!fixedIds.includes(input.scenarioId)) throw new ApiError(400, "Редактировать можно только один из 40 сценариев каталога.");
  const parsed = catalogPatchSchema.safeParse(input.patch);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || "Проверьте поля изменения сценария.");
  const patch = parsed.data;
  if (patch.not_this_if?.some(rule => rule.use_instead === input.scenarioId)) throw new ApiError(400, "Правило исключения должно ссылаться на другой сценарий.");
  if (!/^[a-f0-9]{64}$/.test(input.expectedHash)) throw new ApiError(400, "Укажите текущую версию каталога.");
  await ensureSupervision();
  return transaction(async sql => {
    // Serialize optimistic version checks across independent server instances.
    await sql.query("SELECT pg_advisory_xact_lock(684217394)");
    const seed = await sql.query<{ hash: string }>("SELECT hash FROM dataset_versions WHERE id='current' FOR SHARE");
    const baseHash = seed.rows[0]?.hash;
    if (!baseHash) throw new ApiError(503, "Исходный каталог ещё не импортирован.");
    const previous = await sql.query<RevisionRow>("SELECT * FROM catalog_revisions WHERE base_hash=$1 ORDER BY revision_number DESC LIMIT 1", [baseHash]);
    const latest = previous.rows[0];
    const parentHash = latest?.hash ?? baseHash;
    if (input.expectedHash !== parentHash) throw new ApiError(409, "Каталог изменён другим супервизором. Обновите каталог и повторите изменение.");
    const scenarios = structuredClone(latest?.scenarios ?? input.dataset.scenarios);
    if (scenarios.length !== 40 || new Set(scenarios.map(s => s.scenario_id)).size !== 40 || scenarios.some(s => !fixedIds.includes(s.scenario_id))) throw new ApiError(409, "Состав каталога не соответствует исходным 40 сценариям.");
    const index = scenarios.findIndex(s => s.scenario_id === input.scenarioId);
    const before = scenarios[index];
    const after: Scenario = {
      ...before,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.examples ? { examples: { ...before.examples, ...patch.examples } } : {}),
      ...(patch.not_this_if !== undefined ? { not_this_if: patch.not_this_if } : {}),
    };
    if (JSON.stringify(before) === JSON.stringify(after)) throw new ApiError(400, "Сценарий не изменился.");
    scenarios[index] = after;
    if (Buffer.byteLength(JSON.stringify(scenarios), "utf8") > 100_000) throw new ApiError(400, "Каталог стал слишком большим для маршрутизации. Сократите описания или примеры.");
    const hash = createHash("sha256").update(baseHash).update(parentHash).update(JSON.stringify(scenarios)).digest("hex");
    const inserted = await sql.query<RevisionRow>(`INSERT INTO catalog_revisions(id,hash,base_hash,parent_hash,scenario_id,editor_id,scenarios,patch)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`, [randomUUID(), hash, baseHash, parentHash, input.scenarioId, input.viewer.id, JSON.stringify(scenarios), JSON.stringify(patch)]);
    return revisionSummary(inserted.rows[0]);
  });
}

function reviewResult(row: ReviewRow) {
  return { id: row.id, turnId: row.turn_id, sessionId: row.session_id ?? null, reviewerId: row.reviewer_id, expectedScenario: row.expected_scenario, actualScenario: row.actual_scenario ?? null, matchesPrimary: row.actual_scenario === row.expected_scenario, note: row.note, userText: row.user_text ?? "", createdAt: dateString(row.created_at) };
}

export async function saveReview(input: { turnId: string; expectedScenario: string; note?: string; viewer: Viewer; dataset: Dataset }) {
  assertSupervisor(input.viewer);
  const parsed = z.object({ turnId: z.string().min(1).max(100), expectedScenario: z.string().min(1).max(50), note: z.string().trim().max(1500).default("") }).safeParse(input);
  if (!parsed.success) throw new ApiError(400, "Проверьте сценарий и комментарий к оценке.");
  const allowed = new Set([...input.dataset.scenarios.map(s => s.scenario_id), ...input.dataset.systemIntents.map(s => String(s.id))]);
  if (!allowed.has(parsed.data.expectedScenario)) throw new ApiError(400, "Ожидаемый сценарий отсутствует в каталоге.");
  await ensureSupervision();
  return transaction(async sql => {
    const selected = await sql.query<{ id: string; session_id: string; user_text: string; trace: Trace; status: string }>("SELECT id,session_id,user_text,trace,status FROM turns WHERE id=$1 FOR SHARE", [parsed.data.turnId]);
    const turn = selected.rows[0];
    if (!turn || turn.status !== "completed") throw new ApiError(404, "Завершённая реплика не найдена.");
    if (turn.trace?.source !== "llm" || !turn.trace.scenarios.length) throw new ApiError(400, "Ручная оценка доступна для решений LLM-маршрутизатора.");
    const saved = await sql.query<ReviewRow>(`INSERT INTO review_annotations(id,turn_id,reviewer_id,expected_scenario,note)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(reviewer_id,turn_id)
      DO UPDATE SET expected_scenario=EXCLUDED.expected_scenario,note=EXCLUDED.note,created_at=now() RETURNING *`,
      [randomUUID(), turn.id, input.viewer.id, parsed.data.expectedScenario, parsed.data.note]);
    return redact(reviewResult({ ...saved.rows[0], session_id: turn.session_id, user_text: turn.user_text, actual_scenario: turn.trace.scenarios[0].scenarioId }));
  });
}

export async function getSupervision(viewer: Viewer, dataset: Dataset) {
  assertSupervisor(viewer);
  await ensureSupervision();
  const [totals, reviewCounts, failures, recent, revisions, latency] = await Promise.all([
    query<{ llm_turns: string; failed_turns: string; validation_turns: string }>(`SELECT
      count(*) FILTER(WHERE status='completed' AND trace->>'source'='llm')::text AS llm_turns,
      count(*) FILTER(WHERE status='failed')::text AS failed_turns,
      count(*) FILTER(WHERE status='completed' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(trace->'actions','[]'::jsonb)) a WHERE a->>'status'='failed'))::text AS validation_turns
      FROM turns`),
    query<{ reviewed: string; matched: string }>(`WITH latest AS (
      SELECT DISTINCT ON(turn_id) turn_id,expected_scenario FROM review_annotations ORDER BY turn_id,created_at DESC,id DESC
    ) SELECT count(*)::text AS reviewed,count(*) FILTER(WHERE l.expected_scenario=t.trace->'scenarios'->0->>'scenarioId')::text AS matched
      FROM latest l JOIN turns t ON t.id=l.turn_id WHERE t.status='completed' AND t.trace->>'source'='llm'`),
    query<{ code: string; count: string }>(`SELECT coalesce(a->'error'->>'code','unknown') AS code,count(*)::text AS count
      FROM turns t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.trace->'actions','[]'::jsonb)) a
      WHERE t.status='completed' AND a->>'status'='failed' GROUP BY code ORDER BY count(*) DESC,code LIMIT 20`),
    query<ReviewRow>(`SELECT r.*,t.session_id,t.user_text,t.trace->'scenarios'->0->>'scenarioId' AS actual_scenario
      FROM review_annotations r JOIN turns t ON t.id=r.turn_id ORDER BY r.created_at DESC,r.id DESC LIMIT 50`),
    query<RevisionRow>(`SELECT r.* FROM catalog_revisions r JOIN dataset_versions d ON d.id='current' AND d.hash=r.base_hash
      ORDER BY r.revision_number DESC LIMIT 20`),
    query<{ source: string; count: string; server_p50: number | null; server_p95: number | null; router_p50: number | null; router_p95: number | null }>(`SELECT trace->>'source' AS source,count(*)::text AS count,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY (trace->'timings'->>'serverTotal')::double precision) AS server_p50,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY (trace->'timings'->>'serverTotal')::double precision) AS server_p95,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY (trace->'timings'->>'router')::double precision) AS router_p50,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY (trace->'timings'->>'router')::double precision) AS router_p95
      FROM turns WHERE status='completed' AND trace->>'source' IN ('llm','slot','confirmation')
      GROUP BY trace->>'source' ORDER BY source`),
  ]);
  const llmTurns = Number(totals.rows[0].llm_turns), reviewedTurns = Number(reviewCounts.rows[0].reviewed), matches = Number(reviewCounts.rows[0].matched);
  return redact({
    stats: {
      llmTurns, storedFailedTurns: Number(totals.rows[0].failed_turns), validationFailedTurns: Number(totals.rows[0].validation_turns),
      reviewedTurns, matchedPrimary: matches, correctedPrimary: reviewedTurns - matches,
      primaryAgreementRate: reviewedTurns ? matches / reviewedTurns : null,
      reviewCoverageRate: llmTurns ? reviewedTurns / llmTurns : null,
    },
    errorCodes: failures.rows.map(row => ({ code: row.code, count: Number(row.count) })),
    reviews: recent.rows.map(reviewResult), revisions: revisions.rows.map(revisionSummary),
    latencyBySource: latency.rows.map(row => ({ source: row.source, count: Number(row.count), p50ServerMs: row.server_p50, p95ServerMs: row.server_p95, p50RoutingMs: row.router_p50, p95RoutingMs: row.router_p95 })),
    currentCatalogHash: dataset.hash,
    methodology: "Для каждой реплики учитывается последняя ручная оценка основного маршрута. Это согласие с оценкой супервизора на проверенных репликах, а не точность на всём датасете. Неуспешные реплики считаются по текущим сохранённым статусам; повторная успешная попытка может заменить неуспешную.",
  });
}
