import { normalizeSlot } from "./domain-data";
import { effectiveSlots } from "./routing-slots";
import { languageFromList, languagePhrase, spokenLanguages, stateLanguages } from "./languages";
import type { Dataset, DialogueState, Json, Language, ReviewedLanguage, RouterOutput, SlotDefinition, SpokenLanguage } from "./types";

// Conversation management only. A greeting plus any other words is a miss, so
// meaningful requests still reach the LLM instead of losing their business intent.
const socialPhrases: Record<ReviewedLanguage, readonly string[]> = {
  ru: ["привет", "здравствуйте", "добрый день", "добрый вечер", "доброе утро", "алло", "вы меня слышите", "ты меня слышишь"],
  kk: ["сәлем", "сәлеметсіз бе", "қайырлы күн", "қайырлы таң", "қайырлы кеш", "естіп тұрсыз ба"],
  tr: ["merhaba", "selam", "günaydın", "iyi günler", "iyi akşamlar", "beni duyuyor musunuz"],
};
function wholePhrase(value: string): string {
  return value.normalize("NFC").trim().toLowerCase().replace(/[.!?…]+$/u, "").trim().replace(/\s+/gu, " ");
}
const socialIndex = new Map<string, ReviewedLanguage>(Object.entries(socialPhrases).flatMap(([language, phrases]) => phrases.map(phrase => [wholePhrase(phrase), language as ReviewedLanguage] as const)));
type CatalogExample = { scenarioId: string; language: "ru" | "kk" };
let catalogExamples: { hash: string; index: Map<string, CatalogExample | null> } | undefined;
function catalogExampleIndex(dataset: Dataset): Map<string, CatalogExample | null> {
  if (catalogExamples?.hash === dataset.hash) return catalogExamples.index;
  const index = new Map<string, CatalogExample | null>();
  // Compare against the entire catalog: any duplicate full example is ambiguous,
  // including a collision with a non-eligible scenario or another language.
  for (const scenario of dataset.scenarios) for (const language of ["ru", "kk"] as const) for (const example of scenario.examples[language]) {
    const key = wholePhrase(example);
    index.set(key, index.has(key) ? null : { scenarioId: scenario.scenario_id, language });
  }
  catalogExamples = { hash: dataset.hash, index };
  return index;
}

function initialFastPath(dataset: Dataset, state: DialogueState, text: string, started: number): RouterOutput | null {
  if (state.activeScenarioId || state.pendingConfirmation || !text || text.length > 180 || /[\d@\r\n]/u.test(text)) return null;
  const phrase = wholePhrase(text);
  const socialLanguage = socialIndex.get(phrase);
  if (socialLanguage && dataset.systemIntents.some(intent => intent.id === "SYS_UNCLEAR")) {
    const reason = languagePhrase([socialLanguage], { ru: "Точная короткая фраза приветствия без делового запроса.", kk: "Іскерлік сұраныссыз нақты қысқа сәлемдесу.", tr: "İş talebi içermeyen tam ve kısa bir selamlama." });
    return { decision: { scenarios: [{ scenarioId: "SYS_UNCLEAR", confidence: 1, reason }], alternatives: [], utteranceKind: "greeting", language: socialLanguage, inputLanguages: [socialLanguage], responseLanguage: socialLanguage, responseLanguages: [socialLanguage], tone: "neutral", slots: {}, isContinuation: false, confirmation: "none", reason, clarification: null }, source: "social", model: "social-fast-path", elapsedMs: Number((performance.now() - started).toFixed(3)), inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
  }
  // SC37 is the only allowed business target: its full examples carry no slots,
  // ask for a human explicitly and require no customer identification. Examples
  // are read from the versioned catalog, never duplicated as phrase routing rules.
  if (state.clientId || state.lastQuestionSlot || state.pendingScenarioIds.length || state.suspendedScenarioIds.length || state.completedScenarioIds.length || Object.keys(state.slots).length || Object.keys(state.slotsByScenario).length) return null;
  const match = catalogExampleIndex(dataset).get(phrase);
  if (!match || match.scenarioId !== "SC37") return null;
  const scenario = dataset.scenarios.find(candidate => candidate.scenario_id === match.scenarioId);
  if (!scenario?.fast_path_eligible || scenario.requires_identification || scenario.requires_confirmation || scenario.slots.required.length || scenario.actions.length !== 1 || scenario.actions[0] !== "transfer_to_operator") return null;
  const reason = languagePhrase([match.language], { ru: "Полная фраза точно совпадает с единственным примером запроса оператора в каталоге.", kk: "Толық сөйлем каталогтағы оператор сұрауының бір ғана мысалына дәл сәйкес келеді.", tr: "Tam ifade katalogdaki tek bir operatör talebi örneğiyle eşleşiyor." });
  return { decision: { scenarios: [{ scenarioId: scenario.scenario_id, confidence: 1, reason }], alternatives: [], utteranceKind: "request", language: match.language, inputLanguages: [match.language], responseLanguage: match.language, responseLanguages: [match.language], tone: "neutral", slots: {}, isContinuation: false, confirmation: "none", reason, clarification: null }, source: "catalog_example", model: "catalog-example-fast-path", elapsedMs: Number((performance.now() - started).toFixed(3)), inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
}

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

/** Exact social/catalog entry points, then atomic continuation of a selected scenario. */
export function tryFastPath({ dataset, state, text, responseLanguage = state.language, responseLanguages }: {
  dataset: Dataset; state: DialogueState; text: string; responseLanguage?: Language; responseLanguages?: SpokenLanguage[];
}): RouterOutput | null {
  const started = performance.now();
  if (state.status !== "active") return null;
  if (!state.activeScenarioId) return initialFastPath(dataset, state, text, started);
  const scenario = dataset.scenarios.find(item => item.scenario_id === state.activeScenarioId);
  if (!scenario) return null;
  const value = text.trim();
  let source: "confirmation" | "slot";
  let confirmation: "confirm" | "reject" | "none" = "none";
  let slots: Record<string, Json> = {};
  let reason: string;
  let inputLanguages = stateLanguages(state);
  const replyLanguages = spokenLanguages(responseLanguage, responseLanguages ?? state.responseLanguages);
  if (state.pendingConfirmation) {
    if (state.pendingConfirmation.scenarioId !== scenario.scenario_id || state.lastQuestionSlot) return null;
    const answer = /^(да|иә|нет|жоқ|evet|hayır|hayir)[.!]?$/iu.exec(value)?.[1].toLocaleLowerCase("tr");
    if (!answer) return null;
    confirmation = answer === "да" || answer === "иә" || answer === "evet" ? "confirm" : "reject";
    inputLanguages = [answer === "да" || answer === "нет" ? "ru" : answer === "иә" || answer === "жоқ" ? "kk" : "tr"];
    source = "confirmation";
    reason = confirmation === "confirm" ? languagePhrase(replyLanguages, {
      ru: "Точное подтверждение показанного действия.", kk: "Көрсетілген әрекет нақты расталды.", tr: "Gösterilen işlem açıkça onaylandı.",
      ru_kk: "Көрсетілген әрекет — точное подтверждение.", ru_tr: "Показанное действие açıkça onaylandı.", kk_tr: "Көрсетілген әрекет açıkça onaylandı.", ru_kk_tr: "Подтверждение: көрсетілген әрекет açıkça onaylandı.",
    }) : languagePhrase(replyLanguages, {
      ru: "Точный отказ от показанного действия.", kk: "Көрсетілген әрекеттен бас тартылды.", tr: "Gösterilen işlem açıkça reddedildi.",
      ru_kk: "Көрсетілген әрекет — точный отказ.", ru_tr: "Показанное действие açıkça reddedildi.", kk_tr: "Көрсетілген әрекет açıkça reddedildi.", ru_kk_tr: "Отказ: көрсетілген әрекет açıkça reddedildi.",
    });
  } else {
    if (!state.lastQuestionSlot) return null;
    const definition = effectiveSlots(dataset).find(slot => slot.name === state.lastQuestionSlot);
    if (!definition) return null;
    const normalized = atomicValue(definition, value, dataset.businessDate);
    if (normalized === undefined) return null;
    slots = { [definition.name]: normalized };
    source = "slot";
    reason = languagePhrase(replyLanguages, { ru: "Значение одного запрошенного поля проверено по правилам каталога.", kk: "Сұралған бір өрістің мәні каталог ережелерімен тексерілді.", tr: "İstenen tek alanın değeri katalog kurallarına göre doğrulandı.",
      ru_kk: "Сұралған өріс проверен по правилам каталога.", ru_tr: "Значение запрошенного поля katalog kurallarına göre doğrulandı.", kk_tr: "Сұралған өрістің мәні katalog kurallarına göre doğrulandı.", ru_kk_tr: "Значение поля: сұралған дерек katalog kurallarına göre doğrulandı." });
  }
  return {
    decision: { scenarios: [{ scenarioId: scenario.scenario_id, confidence: 1, reason }], alternatives: [],
      language: languageFromList(inputLanguages), inputLanguages, responseLanguage: languageFromList(replyLanguages), responseLanguages: replyLanguages, tone: "neutral", slots, isContinuation: true, confirmation, reason, clarification: null },
    source, model: "state-fast-path", elapsedMs: Number((performance.now() - started).toFixed(3)), inputTokens: 0, outputTokens: 0, estimatedUsd: 0,
  };
}
