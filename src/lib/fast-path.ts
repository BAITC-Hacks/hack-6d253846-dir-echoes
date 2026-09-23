import { normalizeSlot } from "./domain-data";
import type { Dataset, DialogueState, Json, Language, RouterOutput, SlotDefinition } from "./types";

// Complete slot labels, never utterance-to-scenario rules. All targets must also
// exist in the current catalog's values before this path can accept them.
const enumLabels: Record<string, Record<string, string>> = {
  vehicle_type: {
    "легковая": "car", "легковой": "car", "автомобиль": "car", "легковой автомобиль": "car", "легковая машина": "car",
    "жеңіл": "car", "жеңіл көлік": "car", "жеңіл автокөлік": "car",
    "грузовик": "truck", "грузовой автомобиль": "truck", "грузовая машина": "truck", "жүк": "truck", "жүк көлігі": "truck", "жүк автокөлігі": "truck",
    "мотоцикл": "motorcycle",
  },
  region: { "другой": "other", "другое": "other", "другой город": "other", "другой регион": "other", "басқа": "other", "басқа қала": "other", "басқа өңір": "other" },
  product_type: {
    "огпо": "ogpo", "каско": "casco", "дмс": "dms", "добровольное медицинское страхование": "dms", "ерікті медициналық сақтандыру": "dms",
    "путешествие": "travel", "туризм": "travel", "страхование путешествий": "travel", "туристік сақтандыру": "travel",
    "имущество": "property", "страхование имущества": "property", "мүлік": "property", "мүлікті сақтандыру": "property",
    "несчастный случай": "accident", "страхование от несчастного случая": "accident", "жазатайым оқиға": "accident", "жазатайым оқиғадан сақтандыру": "accident",
  },
  property_type: { "квартира": "apartment", "пәтер": "apartment", "дом": "house", "частный дом": "house", "үй": "house", "жеке үй": "house" },
  contact_field: {
    "телефон": "phone", "номер телефона": "phone", "телефон нөмірі": "phone",
    "почта": "email", "электронная почта": "email", "пошта": "email", "электрондық пошта": "email",
    "адрес": "address", "мекенжай": "address",
  },
  document_type: {
    "дубликат": "policy_duplicate", "дубликат полиса": "policy_duplicate", "полис көшірмесі": "policy_duplicate",
    "копия договора": "contract_copy", "шарт көшірмесі": "contract_copy", "келісімшарт көшірмесі": "contract_copy",
    "для посольства": "embassy_certificate", "справка для посольства": "embassy_certificate", "елшілікке арналған анықтама": "embassy_certificate",
    "справка об оплате": "payment_certificate", "төлем туралы анықтама": "payment_certificate",
  },
};
const cityNames: Record<string, readonly string[]> = {
  Almaty: ["алматы", "алмата"], Astana: ["астана"], Shymkent: ["шымкент", "чимкент"],
  Karaganda: ["караганда", "қарағанды"], Aktobe: ["актобе", "ақтөбе"], Atyrau: ["атырау"],
  Pavlodar: ["павлодар"], Oskemen: ["усть-каменогорск", "өскемен", "оскемен"],
};
const cityLabels = new Map<string, string>();
for (const [canonical, names] of Object.entries(cityNames)) {
  for (const name of [canonical.toLowerCase(), ...names]) {
    cityLabels.set(name, canonical);
    cityLabels.set(`город ${name}`, canonical);
    cityLabels.set(`${name} қаласы`, canonical);
  }
}

function exactEnumValue(def: SlotDefinition, text: string): Json | undefined {
  const key = text.normalize("NFC").toLowerCase();
  const canonical = def.values?.find(value => typeof value === "string" && value.toLowerCase() === key);
  if (canonical !== undefined) return canonical;
  let value: string | undefined;
  if (def.name === "city" || def.name === "region") {
    const city = cityLabels.get(key);
    // The organizer's tariff has two named cities and one "other" region.
    if (city) value = def.name === "city" ? city : city === "Almaty" ? "almaty" : city === "Astana" ? "astana" : "other";
  }
  const labels = enumLabels[def.name];
  if (value === undefined && labels && Object.hasOwn(labels, key)) value = labels[key];
  return value !== undefined && def.values?.includes(value) ? value : undefined;
}

/** Accept only a complete atomic value. The normalizer still enforces catalog constraints. */
function atomicValue(def: SlotDefinition, text: string, businessDate: string): Json | undefined {
  if (!text || text.length > 100 || /[\r\n?!;,]/u.test(text)) return undefined;
  let candidate: Json = text;
  if (def.type === "integer" || def.values?.every(value => typeof value === "number")) {
    if (!/^\d{1,15}$/u.test(text)) return undefined;
  } else if (def.type === "date") {
    if (!/^(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})$/u.test(text)) return undefined;
  } else if (def.type === "enum" && def.values?.length) {
    // STT may punctuate a plain slot answer. Remove only one final full stop;
    // questions, internal punctuation, extra clauses and words are not removed.
    const label = text.endsWith(".") ? text.slice(0, -1) : text;
    if (!/^[\p{L}\d_-]+(?: [\p{L}\d_-]+)*$/u.test(label)) return undefined;
    // Resolve a full dictionary key before normalizeSlot: its permissive region
    // aliases must never turn modifiers or a new intent into an accepted answer.
    const exact = exactEnumValue(def, label);
    if (exact === undefined) return undefined;
    candidate = exact;
  } else if (def.type === "string" && def.pattern?.startsWith("^") && def.pattern.endsWith("$")) {
    // IDs and phone numbers only; free text, email, lists and yes/no slot questions
    // remain with the LLM. A bare "yes" can answer oppositely worded questions.
    if (!/\d/u.test(text) || !/^[+\p{L}\d() -]+$/u.test(text)) return undefined;
    // Phone normalization strips every non-digit. Reject words before that step,
    // otherwise a topic change followed by a number would silently become a phone.
    if (def.name === "phone" && !/^[+\d() -]+$/u.test(text)) return undefined;
  } else return undefined;
  try { return normalizeSlot(def, candidate, businessDate); } catch { return undefined; }
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
