import assert from "node:assert/strict";
import test from "node:test";
import { shouldComposeReply, validateRoutingDecision } from "../src/lib/ai";
import type { Dataset, DialogueState, ExecuteOutput, Scenario } from "../src/lib/types";

function scenario(id: string, priority: Scenario["priority"] = "normal"): Scenario {
  return { scenario_id: id, slug: id, name: id, description: id, domain: "general", category: "info", priority, fast_path_eligible: false, requires_identification: false, slots: { required: [], optional: [] }, actions: [], requires_confirmation: false, handoff: null, not_this_if: [], examples: { ru: [], kk: [] }, responses: { ru: { opening: "", closing: "" }, kk: { opening: "", closing: "" } } };
}
const dataset: Dataset = {
  version: "test", hash: "contract-test", businessDate: "2026-10-01", scenarios: [scenario("SC01"), scenario("SC02"), scenario("SC11", "urgent"), scenario("SC15", "urgent")],
  systemIntents: [{ id: "SYS_UNCLEAR", description: "Unclear" }, { id: "SYS_OUT_OF_SCOPE", description: "Out of scope" }, { id: "SYS_GOODBYE", description: "Goodbye" }],
  slots: [
    { name: "phone", type: "string", description: "Phone", prompt: { ru: "", kk: "" } },
    { name: "year", type: "integer", description: "Year", prompt: { ru: "", kk: "" } },
    { name: "drivers", type: "list", description: "Drivers", prompt: { ru: "", kk: "" } },
    { name: "approved", type: "boolean", description: "Approved", prompt: { ru: "", kk: "" } },
  ], actions: [], queues: [], knowledge: {}, backend: {},
};
function state(): DialogueState {
  return { language: "ru", activeScenarioId: null, pendingScenarioIds: [], suspendedScenarioIds: [], completedScenarioIds: [], slots: {}, slotsByScenario: {}, clientId: null, pendingConfirmation: null, unclearCount: 0, lastQuestionSlot: null, lookupFailures: 0, status: "active" };
}
function wire() {
  return { scenarios: [{ scenarioId: "SC01", confidence: 0.91, reason: "A price enquiry" }], alternatives: [], language: "ru", responseLanguage: "ru", slots: [] as { name: string; value: string }[], isContinuation: false, confirmation: "none", reason: "A price enquiry", clarification: null };
}

test("catalog policy orders urgent intents first and preserves other mention order", () => {
  const raw = wire();
  raw.scenarios = ["SC02", "SC11", "SC01", "SC15"].map((scenarioId) => ({ scenarioId, confidence: 0.9, reason: "Requested" }));
  assert.deepEqual(validateRoutingDecision(raw, dataset, state()).scenarios.map((s) => s.scenarioId), ["SC11", "SC15", "SC02", "SC01"]);
});

test("rejects nonexistent, duplicate, and mixed system/business decisions", () => {
  const raw = wire();
  assert.throws(() => validateRoutingDecision({ ...raw, scenarios: [{ ...raw.scenarios[0], scenarioId: "SC99" }] }, dataset, state()));
  assert.throws(() => validateRoutingDecision({ ...raw, scenarios: [raw.scenarios[0], raw.scenarios[0]] }, dataset, state()));
  assert.throws(() => validateRoutingDecision({ ...raw, scenarios: [raw.scenarios[0], { ...raw.scenarios[0], scenarioId: "SYS_UNCLEAR" }] }, dataset, state()));
});

test("a confirmation without the exact pending preview cannot authorize an action", () => {
  const raw = { ...wire(), confirmation: "confirm", isContinuation: true };
  assert.equal(validateRoutingDecision(raw, dataset, state()).confirmation, "none");
  const pending = state();
  pending.activeScenarioId = "SC01";
  pending.pendingConfirmation = { id: "op-one", scenarioId: "SC01", actionNames: ["create_policy"], slots: { phone: "+77010000001" }, summary: "Preview", createdAt: "2026-10-01T00:00:00Z" };
  assert.equal(validateRoutingDecision(raw, dataset, pending).confirmation, "confirm");
  assert.equal(validateRoutingDecision({ ...raw, slots: [{ name: "phone", value: "+77010000002" }] }, dataset, pending).confirmation, "none");
  assert.equal(validateRoutingDecision({ ...raw, scenarios: [{ ...raw.scenarios[0], scenarioId: "SC02" }] }, dataset, pending).confirmation, "none");
});

test("slot normalization preserves identifiers and rejects malformed typed values", () => {
  const raw = wire();
  raw.slots = [{ name: "phone", value: "001234" }, { name: "year", value: "2020" }, { name: "drivers", value: '["001122334455"]' }, { name: "approved", value: "true" }];
  assert.deepEqual(validateRoutingDecision(raw, dataset, state()).slots, { phone: "001234", year: 2020, drivers: ["001122334455"], approved: true });
  assert.throws(() => validateRoutingDecision({ ...raw, slots: [{ name: "year", value: "2020oops" }] }, dataset, state()));
  assert.throws(() => validateRoutingDecision({ ...raw, slots: [{ name: "drivers", value: '{"unexpected":true}' }] }, dataset, state()));
  assert.throws(() => validateRoutingDecision({ ...raw, slots: [raw.slots[0], raw.slots[0]] }, dataset, state()));
});

test("continuation requires the same active scenario and cannot hide a new topic", () => {
  const active = { ...state(), activeScenarioId: "SC02" };
  assert.equal(validateRoutingDecision({ ...wire(), isContinuation: true }, dataset, active).isContinuation, false);
  assert.equal(validateRoutingDecision({ ...wire(), isContinuation: true }, dataset, { ...active, activeScenarioId: "SC01" }).isContinuation, true);
});

test("mixed input keeps its trace language and a distinct Kazakh reply language", () => {
  const decision = validateRoutingDecision({ ...wire(), language: "mixed", responseLanguage: "kk" }, dataset, state());
  assert.equal(decision.language, "mixed");
  assert.equal(decision.responseLanguage, "kk");
});

test("composer cannot rewrite confirmation, slot questions, failures or handoff", () => {
  const execution: ExecuteOutput = { state: state(), actions: [{ name: "kb_lookup", status: "read", data: { fact: "known" } }], reply: "Known fact", facts: { fact: "known" }, warnings: [] };
  assert.equal(shouldComposeReply(execution), true);
  assert.equal(shouldComposeReply({ ...execution, state: { ...state(), lastQuestionSlot: "phone" } }), false);
  assert.equal(shouldComposeReply({ ...execution, handoff: { queue: "operator_general", reason: "requested" } }), false);
  assert.equal(shouldComposeReply({ ...execution, actions: [{ name: "kb_lookup", status: "failed", data: {} }] }), false);
});
