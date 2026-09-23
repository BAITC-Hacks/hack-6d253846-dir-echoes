import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeTurn, initialState } from "../src/lib/domain";
import { calculatePrice, normalizeSlot } from "../src/lib/domain-data";
import type { Dataset, DialogueState, EntityStore, JsonObject, RoutingDecision } from "../src/lib/types";

const datasetPath = process.env.DATASET_PATH ?? process.env.DATASET_DIR;
const file = (name: string) => JSON.parse(readFileSync(path.join(datasetPath!, name), "utf8"));
const scenarios = datasetPath ? file("scenarios.json") : null, actions = datasetPath ? file("actions.json") : null;
const dataset: Dataset = datasetPath ? { version: "1.0", hash: "test-organizer-fixture", businessDate: scenarios.meta.as_of_date, scenarios: scenarios.scenarios, systemIntents: scenarios.system_intents, slots: file("slots.json").slots, actions: actions.actions, queues: actions.queues, knowledge: file("knowledge_base.json"), backend: file("mock_backend.json") } : undefined!;
const organizerTest = (name: string, fn: () => void | Promise<void>) => test(name, { skip: datasetPath ? false : "Set DATASET_PATH to the organizer corpus to run these tests." }, fn);

class MemoryStore implements EntityStore {
  records = new Map<string, Map<string, JsonObject>>();
  writes = 0;
  constructor() {
    for (const [kind, id] of Object.entries({ clients: "client_id", policies: "policy_number", claims: "claim_number", payments: "payment_id" })) {
      const records = dataset.backend[kind] as JsonObject[];
      this.records.set(kind, new Map(records.map(record => [String(record[id]), structuredClone(record)])));
    }
  }
  async list(kind: string) { return structuredClone([...(this.records.get(kind)?.values() ?? [])]); }
  async get(kind: string, id: string) { return structuredClone(this.records.get(kind)?.get(id) ?? null); }
  async put(kind: string, id: string, value: JsonObject) { this.writes++; if (!this.records.has(kind)) this.records.set(kind, new Map()); this.records.get(kind)!.set(id, structuredClone(value)); }
}
const decision = (scenarioId: string, slots: JsonObject = {}, extra: Partial<RoutingDecision> = {}): RoutingDecision => ({ scenarios: [{ scenarioId, confidence: 0.97, reason: "test" }], alternatives: [], language: "ru", slots, isContinuation: false, confirmation: "none", reason: "test", clarification: null, ...extra });
const run = (store: MemoryStore, route: RoutingDecision, state = initialState(), requestId = crypto.randomUUID()) => executeTurn({ dataset, store, state, decision: route, text: "Organizer fixture execution", sessionId: "domain-test-session", requestId });

organizerTest("organizer OGPO tariff uses worst bonus-malus coefficient from all drivers", () => {
  const result = calculatePrice(dataset, "ogpo", { region: "almaty", vehicle_type: "car", drivers_iin: ["850314300121", "920607400233"] }, dataset.backend.clients as JsonObject[]);
  assert.equal(result.price, 38000);
  assert.deepEqual(result.bm_classes, ["7", "3"]);
});

organizerTest("source cancellation example computes seven full months and requires saved confirmation", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC28", { phone: "+77010000010", policy_number: "SQ-CASCO-204350", cancel_reason: "Продажа автомобиля" }));
  assert.ok(preview.state.pendingConfirmation);
  assert.equal(store.writes, 0);
  assert.equal(preview.actions.find(a => a.name === "cancel_policy")?.data.refund_amount, 163800);
  const completed = await run(store, decision("SC28", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  assert.equal((await store.get("policies", "SQ-CASCO-204350"))?.status, "cancelled");
  assert.equal(completed.state.pendingConfirmation, null);
  const writeCount = store.writes;
  const retried = await run(store, decision("SC28", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  assert.equal(store.writes, writeCount);
  assert.equal(retried.reply, completed.reply);
  assert.ok(retried.warnings.some(w => w.includes("already applied")));
});

organizerTest("confirmation rejection leaves policy unchanged", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC28", { phone: "+77010000010", cancel_reason: "Продажа автомобиля" }));
  const result = await run(store, decision("SC28", {}, { confirmation: "reject", isContinuation: true }), preview.state);
  assert.equal(result.state.pendingConfirmation, null); assert.equal(store.writes, 0);
  assert.equal((await store.get("policies", "SQ-CASCO-204350"))?.status, undefined);
});

organizerTest("foreign policy cannot be read or cancelled after another client is identified", async () => {
  const store = new MemoryStore(), state = initialState(); state.clientId = "C001";
  const result = await run(store, decision("SC28", { policy_number: "SQ-CASCO-204350", cancel_reason: "Продажа автомобиля" }), state);
  assert.equal(result.actions[0]?.error?.code, "not_found"); assert.equal(store.writes, 0);
  assert.equal(result.state.pendingConfirmation, null);
  assert.ok(!JSON.stringify(result.facts).includes("312000"));
});

organizerTest("claim is durably created only after explicit confirmation and is owned by identified client", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC14", { phone: "+77010000004", incident_date: "2026-09-12", incident_description: "Затопление квартиры" }));
  assert.equal((await store.list("claims")).length, 4); assert.equal(store.writes, 0);
  assert.ok(preview.state.pendingConfirmation);
  const complete = await run(store, decision("SC14", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  const number = String(complete.actions.find(a => a.name === "create_claim")?.data.claim_number);
  const saved = await store.get("claims", number);
  assert.equal(saved?.client_id, "C004"); assert.equal(saved?.policy_number, "SQ-PROP-404077");
  assert.equal((await store.list("claims")).length, 5);
});

organizerTest("a changed operation argument invalidates the old confirmation", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC29", { phone: "+77010000002", contact_field: "email", new_value: "aigerim.b@mail.example" }));
  const changed = await run(store, decision("SC29", { contact_field: "address", new_value: "Astana, Kabanbay Batyr Ave 11, apt 8" }, { confirmation: "confirm", isContinuation: true }), preview.state);
  assert.ok(changed.state.pendingConfirmation); assert.equal(store.writes, 0);
  assert.notEqual(changed.state.pendingConfirmation?.id, preview.state.pendingConfirmation?.id);
});

organizerTest("topic switch saves appointment context and restores it without city slot poisoning", async () => {
  const store = new MemoryStore();
  const first = await run(store, decision("SC21", { phone: "+77010000002", doctor_specialty: "therapist" }));
  assert.equal(first.state.lastQuestionSlot, "preferred_date"); assert.equal(first.state.slots.city, "Astana");
  const detour = await run(store, decision("SC33", { city: "Almaty" }), first.state);
  assert.equal(detour.state.activeScenarioId, "SC21"); assert.equal(detour.state.slots.city, "Astana");
  assert.equal(detour.state.slots.doctor_specialty, "therapist");
  assert.equal(detour.state.lastQuestionSlot, "preferred_date");
  assert.equal((await store.list("appointments")).length, 0);
});

organizerTest("appointment records honest pending request instead of inventing availability", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC21", { phone: "+77010000002", doctor_specialty: "therapist", preferred_date: "2026-10-02" }));
  assert.ok(preview.state.pendingConfirmation); assert.equal(store.writes, 0);
  const complete = await run(store, decision("SC21", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  const result = complete.actions.find(a => a.name === "book_appointment");
  assert.equal(result?.data.slot_datetime, null); assert.equal(result?.data.status, "request_pending");
  assert.equal((await store.list("appointments")).length, 1);
});

organizerTest("invalid calendar dates are rejected before actions", () => {
  assert.throws(() => normalizeSlot(dataset.slots.find(s => s.name === "preferred_date")!, "2026-02-30", dataset.businessDate));
  assert.equal(normalizeSlot(dataset.slots.find(s => s.name === "preferred_date")!, "ертең", dataset.businessDate), "2026-10-02");
});

organizerTest("urgent scenario precedes ordinary intent and preserves the latter", async () => {
  const store = new MemoryStore();
  const result = await run(store, decision("SC33", { city: "Almaty" }, { scenarios: [{ scenarioId: "SC33", confidence: 0.97, reason: "office" }, { scenarioId: "SC11", confidence: 0.96, reason: "accident now" }] }));
  assert.equal(result.state.activeScenarioId, "SC11"); assert.deepEqual(result.state.pendingScenarioIds, ["SC33"]);
  assert.equal(result.state.lastQuestionSlot, "injured"); assert.match(result.reply, /сто двенадцать/);
});

organizerTest("two unresolved low-confidence turns queue human handoff", async () => {
  const store = new MemoryStore(), d = decision("SYS_UNCLEAR", {}, { scenarios: [{ scenarioId: "SYS_UNCLEAR", confidence: 0.2, reason: "unclear" }] });
  const first = await run(store, d), second = await run(store, d, first.state);
  assert.equal(first.handoff, undefined); assert.equal(second.handoff?.queue, "operator_general"); assert.equal(second.state.status, "handoff");
});

organizerTest("unsupported source tariff is handed off rather than fabricated", async () => {
  const store = new MemoryStore();
  const result = await run(store, decision("SC03", { car_value: 7800000, car_year: 2013, package: "Lite" }));
  assert.ok(result.handoff); assert.equal(result.actions[0]?.error?.code, "not_eligible"); assert.equal(store.writes, 0);
});

organizerTest("changed persisted refund conditions require a fresh confirmation", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC28", { phone: "+77010000010", cancel_reason: "Продажа автомобиля" }));
  const policy = (await store.get("policies", "SQ-CASCO-204350"))!;
  // A concurrent authorized correction uses another supplied source premium to exercise stale-preview protection.
  policy.premium = (await store.get("policies", "SQ-CASCO-204118"))!.premium;
  await store.put("policies", "SQ-CASCO-204350", policy);
  const beforeConfirmationWrites = store.writes;
  const result = await run(store, decision("SC28", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  assert.equal(store.writes, beforeConfirmationWrites);
  assert.ok(result.state.pendingConfirmation);
  assert.notEqual(result.state.pendingConfirmation.id, preview.state.pendingConfirmation?.id);
  assert.match(result.reply, /Условия изменились/);
});

organizerTest("paid claim source rule prevents a positive cancellation refund", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC28", { phone: "+77010000001", policy_number: "SQ-CASCO-204118", cancel_reason: "Продажа автомобиля" }));
  assert.equal(preview.actions.find(a => a.name === "cancel_policy")?.data.refund_amount, 0);
  assert.equal(preview.actions.find(a => a.name === "cancel_policy")?.data.refund_status, "not_payable");
  assert.ok(preview.state.pendingConfirmation); assert.equal(store.writes, 0);
});

organizerTest("an issuance request stays pending payment and never invents a payment URL", async () => {
  const store = new MemoryStore();
  const preview = await run(store, decision("SC02", { phone: "+77010000001", vehicle_plate: "777ABC02", vehicle_type: "car", drivers_iin: ["850314300121"] }));
  assert.ok(preview.state.pendingConfirmation); assert.equal(store.writes, 0);
  const result = await run(store, decision("SC02", {}, { confirmation: "confirm", isContinuation: true }), preview.state);
  const action = result.actions.find(a => a.name === "create_policy")!;
  assert.equal(action.data.status, "pending_payment"); assert.equal(action.data.payment_link, null);
  assert.equal((await store.get("policies", String(action.data.policy_number)))?.client_id, "C001");
  assert.equal(result.actions.find(a => a.name === "send_sms")?.data.delivery_status, "provider_not_configured");
});

organizerTest("document resend creates an outbox record without claiming delivery", async () => {
  const store = new MemoryStore();
  const result = await run(store, decision("SC26", { phone: "+77010000009" }));
  const action = result.actions.find(a => a.name === "resend_documents")!;
  assert.equal(action.status, "queued"); assert.equal(action.data.sent_to, null);
  assert.equal((await store.list("outbox")).length, 1);
  assert.ok(!JSON.stringify(result.facts).includes("rustem.i@mail.example"));
});

organizerTest("culprit policy lookup exposes coverage status without policyholder data", async () => {
  const store = new MemoryStore();
  const result = await run(store, decision("SC12", { culprit_vehicle_plate: "777ABC02", incident_date: "2026-09-30", incident_description: "ДТП", phone: "+77010000005" }));
  const lookup = result.actions.find(a => a.name === "get_policy")!;
  assert.equal(lookup.data.policy_number, "SQ-OGPO-104501");
  assert.equal(lookup.data.client_id, undefined); assert.equal(lookup.data.premium, undefined);
  assert.ok(result.state.pendingConfirmation); assert.equal(store.writes, 0);
});

organizerTest("Kazakh response language survives mixed-language routing", async () => {
  const store = new MemoryStore();
  const result = await run(store, decision("SC21", { phone: "+77010000002", doctor_specialty: "терапевт" }, { language: "mixed", responseLanguage: "kk" }));
  assert.equal(result.state.language, "kk"); assert.equal(result.state.slots.doctor_specialty, "therapist");
  assert.equal(result.reply, dataset.slots.find(s => s.name === "preferred_date")!.prompt.kk);
});

organizerTest("medium-confidence clarification does not count as a low-confidence failure", async () => {
  const store = new MemoryStore();
  const medium = await run(store, decision("SC25", {}, { scenarios: [{ scenarioId: "SC25", confidence: 0.6, reason: "ambiguous" }] }));
  const low = await run(store, decision("SYS_UNCLEAR", {}, { scenarios: [{ scenarioId: "SYS_UNCLEAR", confidence: 0.2, reason: "unclear" }] }), medium.state);
  assert.equal(low.handoff, undefined); assert.equal(low.state.unclearCount, 1);
});

