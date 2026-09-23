import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import type { Dataset, DialogueState, ExecuteOutput, RoutingDecision } from "../src/lib/types";

// Always use a new file database outside the checkout and never the running application's DB.
process.env.LOCAL_DATABASE_PATH = path.resolve(process.cwd(), "..", "budget-tests", randomUUID());
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
process.env.MAX_AI_SPEND_USD = "0.10";

test("durable estimated budget reservations and settlement", async (t) => {
  const { reserveBudget, settleBudget, markBudgetUnknown, getBudgetStatus, BudgetExceededError } = await import("../src/lib/budget");
  const { query, closeDatabase } = await import("../src/lib/db");
  t.after(closeDatabase);
  await getBudgetStatus();
  const reset = async () => { await query("DELETE FROM ai_budget_ledger"); await query("DELETE FROM ai_budget_days"); };

  await t.test("concurrent reservations cannot all spend the same remaining amount", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => reserveBudget({ stage: "router", estimatedUsd: 0.03 })));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 3);
    assert.equal(outcomes.filter((o) => o.status === "rejected" && o.reason instanceof BudgetExceededError).length, 5);
    assert.equal((await getBudgetStatus()).accountedUsd, 0.09);
    const rows = await query<{ count: string }>("SELECT count(*)::text AS count FROM ai_budget_ledger");
    assert.equal(rows.rows[0].count, "3", "rejected reservations must roll back their ledger insert");
  });
  await reset();

  await t.test("settling measured usage frees only the unused reservation, once", async () => {
    const reservation = await reserveBudget({ stage: "router", estimatedUsd: 0.08 });
    await settleBudget(reservation, { estimatedUsd: 0.02, basis: "measured_tokens" });
    await settleBudget(reservation, { estimatedUsd: 0.02, basis: "measured_tokens" });
    assert.equal((await getBudgetStatus()).accountedUsd, 0.02);
    await reserveBudget({ stage: "tts", estimatedUsd: 0.08 });
    await assert.rejects(reserveBudget({ stage: "stt", estimatedUsd: 0.001 }), BudgetExceededError);
    assert.equal((await getBudgetStatus()).accountedUsd, 0.1);
  });
  await reset();

  await t.test("unknown or failed calls retain the reservation across all stages", async () => {
    for (const stage of ["router", "response", "stt", "tts"] as const) {
      const reservation = await reserveBudget({ stage, estimatedUsd: 0.025 });
      await markBudgetUnknown(reservation);
    }
    assert.equal((await getBudgetStatus()).pendingOrUnknownRequests, 4);
    assert.equal((await getBudgetStatus()).accountedUsd, 0.1);
    await assert.rejects(reserveBudget({ stage: "response", estimatedUsd: 0.001 }), BudgetExceededError);
  });
  await reset();

  await t.test("settlement larger than its estimate is recorded and prevents future calls", async () => {
    const reservation = await reserveBudget({ stage: "stt", estimatedUsd: 0.05 });
    await settleBudget(reservation, { estimatedUsd: 0.11, basis: "measured_duration" });
    const status = await getBudgetStatus();
    assert.equal(status.accountedUsd, 0.11);
    assert.equal(status.remainingUsd, 0);
    await assert.rejects(reserveBudget({ stage: "router", estimatedUsd: 0.001 }), BudgetExceededError);
  });
  await reset();

  await t.test("invalid environment values fail closed", async () => {
    process.env.MAX_AI_SPEND_USD = "NaN";
    await assert.rejects(reserveBudget({ stage: "router", estimatedUsd: 0.001 }));
    process.env.MAX_AI_SPEND_USD = "5000";
    await assert.rejects(reserveBudget({ stage: "router", estimatedUsd: 0.001 }));
    process.env.MAX_AI_SPEND_USD = "0.10";
    assert.equal((await getBudgetStatus()).accountedUsd, 0);
  });
  await reset();

  await t.test("all four paid entrypoints stop before network when the budget is exhausted", async () => {
    await reserveBudget({ stage: "router", estimatedUsd: 0.1 });
    const { routeUtterance, composeReply, transcribeAudio, synthesizeSpeech, AiServiceError } = await import("../src/lib/ai");
    const savedKey = process.env.OPENAI_API_KEY;
    const savedFetch = globalThis.fetch;
    let networkCalls = 0;
    process.env.OPENAI_API_KEY = "unit-test-placeholder-never-sent";
    globalThis.fetch = async () => { networkCalls++; throw new Error("Network forbidden in budget tests"); };
    const state: DialogueState = { language: "ru", activeScenarioId: null, pendingScenarioIds: [], suspendedScenarioIds: [], completedScenarioIds: [], slots: {}, slotsByScenario: {}, clientId: null, pendingConfirmation: null, unclearCount: 0, lastQuestionSlot: null, lookupFailures: 0, status: "active" };
    const dataset: Dataset = { version: "contract", hash: "contract", businessDate: "2026-10-01", scenarios: [], systemIntents: [{ id: "SYS_UNCLEAR", description: "Unknown intent" }], slots: [{ name: "phone", type: "string", description: "Phone", prompt: { ru: "", kk: "" } }], actions: [], queues: [], knowledge: {}, backend: {} };
    const decision: RoutingDecision = { scenarios: [{ scenarioId: "SYS_UNCLEAR", confidence: 0.1, reason: "Unclear" }], alternatives: [], language: "ru", slots: {}, isContinuation: false, confirmation: "none", reason: "Unclear", clarification: null };
    const execution: ExecuteOutput = { state, actions: [{ name: "kb_lookup", status: "read", data: { result: "known" } }], facts: { result: "known" }, reply: "Известный факт.", warnings: [] };
    try {
      for (const call of [
        () => routeUtterance({ dataset, state, history: [], text: "Здравствуйте" }),
        () => composeReply({ dataset, state, decision, execution, history: [] }),
        () => transcribeAudio(new File([new Uint8Array(100)], "speech.wav", { type: "audio/wav" })),
        () => synthesizeSpeech("Здравствуйте", "ru"),
      ]) {
        await assert.rejects(call, (error: unknown) => error instanceof AiServiceError && error.status === 429 && error.code === "estimated_ai_budget_exceeded");
      }
      assert.equal(networkCalls, 0);
      assert.equal((await getBudgetStatus()).accountedUsd, 0.1);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
    }
  });
});
