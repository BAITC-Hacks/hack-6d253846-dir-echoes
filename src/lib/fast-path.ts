import { normalizeSlot } from "./domain-data";
import type { Dataset, DialogueState, Json, Language, RouterOutput, SlotDefinition } from "./types";

/** Accept only a complete atomic value. The normalizer still enforces catalog constraints. */
function atomicValue(def: SlotDefinition, text: string, businessDate: string): Json | undefined {
  if (!text || text.length > 100 || /[\r\n?!;,]/u.test(text)) return undefined;
  if (def.type === "integer" || def.values?.every(value => typeof value === "number")) {
    if (!/^\d{1,15}$/u.test(text)) return undefined;
  } else if (def.type === "date") {
    if (!/^(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/u.test(text)) return undefined;
  } else if (def.type === "enum" && def.values?.length) {
    if (!/^[\p{L}\d_-]+(?: [\p{L}\d_-]+){0,2}$/u.test(text)) return undefined;
    // The region normalizer permits substring aliases. Fast execution accepts exact
    // canonical values only, so "Алматы отменить" cannot become a slot answer.
    if (def.name === "region" && !def.values.some(value => String(value).toLowerCase() === text.toLowerCase())) return undefined;
  } else if (def.type === "string" && def.pattern?.startsWith("^") && def.pattern.endsWith("$")) {
    // IDs and phone numbers only; free text, email, lists and yes/no slot questions
    // remain with the LLM. A bare "yes" can answer oppositely worded questions.
    if (!/\d/u.test(text) || !/^[+\p{L}\d() -]+$/u.test(text)) return undefined;
    // Phone normalization strips every non-digit. Reject words before that step,
    // otherwise a topic change followed by a number would silently become a phone.
    if (def.name === "phone" && !/^[+\d() -]+$/u.test(text)) return undefined;
  } else return undefined;
  try { return normalizeSlot(def, text, businessDate); } catch { return undefined; }
}

/** Continue an already selected scenario. This function never selects a new intent. */
export function tryFastPath({ dataset, state, text, responseLanguage = state.language }: {
  dataset: Dataset; state: DialogueState; text: string; responseLanguage?: Language;
}): RouterOutput | null {
  const started = performance.now();
  if (state.status !== "active" || !state.activeScenarioId) return null;
  const scenario = dataset.scenarios.find(item => item.scenario_id === state.activeScenarioId);
  if (!scenario) return null;
  const value = text.trim();
  let source: "confirmation" | "slot";
  let confirmation: "confirm" | "reject" | "none" = "none";
  let slots: Record<string, Json> = {};
  let reason: string;
  if (state.pendingConfirmation) {
    if (state.pendingConfirmation.scenarioId !== scenario.scenario_id || state.lastQuestionSlot) return null;
    const answer = /^(да|иә|нет|жоқ)[.!]?$/iu.exec(value)?.[1].toLowerCase();
    if (!answer) return null;
    confirmation = answer === "да" || answer === "иә" ? "confirm" : "reject";
    source = "confirmation";
    reason = responseLanguage === "kk"
      ? confirmation === "confirm" ? "Көрсетілген әрекет нақты расталды." : "Көрсетілген әрекеттен бас тартылды."
      : confirmation === "confirm" ? "Точное подтверждение показанного действия." : "Точный отказ от показанного действия.";
  } else {
    if (!state.lastQuestionSlot) return null;
    const definition = dataset.slots.find(slot => slot.name === state.lastQuestionSlot);
    if (!definition) return null;
    const normalized = atomicValue(definition, value, dataset.businessDate);
    if (normalized === undefined) return null;
    slots = { [definition.name]: normalized };
    source = "slot";
    reason = responseLanguage === "kk" ? "Сұралған бір өрістің мәні каталог ережелерімен тексерілді." : "Значение одного запрошенного поля проверено по правилам каталога.";
  }
  return {
    decision: { scenarios: [{ scenarioId: scenario.scenario_id, confidence: 1, reason }], alternatives: [],
      language: state.language, responseLanguage, tone: "neutral", slots, isContinuation: true, confirmation, reason, clarification: null },
    source, model: "state-fast-path", elapsedMs: Number((performance.now() - started).toFixed(3)), inputTokens: 0, outputTokens: 0, estimatedUsd: 0,
  };
}
