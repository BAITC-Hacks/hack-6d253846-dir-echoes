import type { Dataset, Json, JsonObject, Language, SlotDefinition } from "./types";

export const object = (value: Json | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const array = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
export const string = (value: Json | undefined): string => value == null ? "" : String(value);
// Mixed wording is supplied explicitly for reviewed short prompts; this helper
// does not attempt automatic translation or alter dynamic amounts and conditions.
export const localized = (language: Language, ru: string, kk: string, mixed?: string): string => language === "kk" ? kk : language === "mixed" ? mixed ?? ru : ru;
export const present = (value: Json | undefined): boolean => value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);

export class DomainError extends Error {
  constructor(public code: string, public ru: string, public kk: string, public slot?: string, public escalate = false) { super(ru); }
}

export function mask(value: string): string {
  return value.replace(/([\w.+-])[\w.+-]*@([\w.-]+)/g, "$1***@$2")
    .replace(/\+?7\d{10}|\b\d{12}\b/g, value => `${value.slice(0, 2)}••••${value.slice(-4)}`);
}

const cityAliases: Record<string, string> = {
  "алматы": "Almaty", "алмата": "Almaty", "астана": "Astana", "шымкент": "Shymkent", "чимкент": "Shymkent",
  "караганда": "Karaganda", "қарағанды": "Karaganda", "актобе": "Aktobe", "ақтөбе": "Aktobe", "атырау": "Atyrau",
  "павлодар": "Pavlodar", "усть-каменогорск": "Oskemen", "өскемен": "Oskemen", "оскемен": "Oskemen",
};
const enumAliases: Record<string, Record<string, Json>> = {
  vehicle_type: { "легковая": "car", "легковой": "car", "автомобиль": "car", "жеңіл": "car", "грузовик": "truck", "жүк": "truck", "мотоцикл": "motorcycle" },
  product_type: { "огпо": "ogpo", "каско": "casco", "дмс": "dms", "путешествие": "travel", "туризм": "travel", "имущество": "property", "несчастный случай": "accident" },
  property_type: { "квартира": "apartment", "пәтер": "apartment", "дом": "house", "үй": "house" },
  contact_field: { "телефон": "phone", "почта": "email", "пошта": "email", "адрес": "address", "мекенжай": "address" },
  document_type: { "дубликат": "policy_duplicate", "копия договора": "contract_copy", "для посольства": "embassy_certificate", "справка об оплате": "payment_certificate" },
};

export function addDays(date: string, days: number): string { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, end)); return d.toISOString().slice(0, 10);
}

export function normalizeSlot(def: SlotDefinition, raw: Json, today: string): Json {
  let value: Json = raw;
  if (typeof value === "string") value = value.trim().slice(0, 3000);
  const text = string(value), lower = text.toLowerCase();
  if (def.name === "phone") {
    let digits = text.replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
    if (digits.length === 10) digits = `7${digits}`;
    value = `+${digits}`;
  } else if (["iin", "new_driver_iin"].includes(def.name)) value = text.replace(/[\s-]/g, "");
  else if (["policy_number", "claim_number", "vehicle_plate", "culprit_vehicle_plate"].includes(def.name)) {
    value = text.toUpperCase().replace(/\s/g, "");
    if (def.name.endsWith("vehicle_plate")) value = value.replace(/[АВЕКМНОРСТУХ]/g, c => ({ А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" } as Record<string, string>)[c]);
  }
  else if (def.name === "city") value = cityAliases[lower] ?? value;
  else if (def.name === "region") value = /алмат|almat/.test(lower) ? "almaty" : /астан|astan/.test(lower) ? "astana" : /other|друг|басқа/.test(lower) ? "other" : value;
  else if (def.name === "doctor_specialty") {
    const specialties: Record<string, string> = { "терапевт": "therapist", "терапевту": "therapist", "лор": "ENT", "отоларинголог": "ENT", "стоматолог": "dentist", "тіс дәрігері": "dentist", "гинеколог": "gynecologist", "кардиолог": "cardiologist", "педиатр": "pediatrician", "анализы": "lab", "талдау": "lab", "узи": "ultrasound", "удз": "ultrasound" };
    value = specialties[lower] ?? value;
  }
  else if (def.type === "date") {
    const shifts: Record<string, number> = { "сегодня": 0, "бүгін": 0, "today": 0, "завтра": 1, "ертең": 1, "tomorrow": 1, "вчера": -1, "кеше": -1, "yesterday": -1, "послезавтра": 2, "бүрсігүні": 2 };
    if (lower in shifts) value = addDays(today, shifts[lower]);
    else if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) value = text.split(".").reverse().join("-");
  } else if (def.type === "boolean" && typeof value === "string") {
    if (/^(true|да|есть|иә|бар)$/.test(lower)) value = true;
    if (/^(false|нет|жоқ)$/.test(lower)) value = false;
  } else if (def.type === "integer" || def.values?.every(v => typeof v === "number")) {
    if (typeof value === "string" && /^\d[\d\s,]*$/.test(text)) value = Number(text.replace(/[\s,]/g, ""));
  } else if (def.type === "list" && typeof value === "string") value = text.split(/[,;\s]+/).filter(Boolean);
  if (enumAliases[def.name]?.[lower] !== undefined) value = enumAliases[def.name][lower];
  if (def.values && typeof value === "string") value = def.values.find(v => string(v).toLowerCase() === string(value).toLowerCase()) ?? value;
  const invalid = () => { throw new DomainError("invalid_input", `Не удалось проверить значение: ${def.description}.`, `Мәнді тексеру мүмкін болмады: ${def.description}.`, def.name); };
  if (!present(value)) invalid();
  if (def.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) invalid();
  if (def.type === "boolean" && typeof value !== "boolean") invalid();
  if (["string", "text", "date"].includes(def.type) && typeof value !== "string") invalid();
  if (def.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(string(value)) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) invalid();
  if (def.values && !def.values.includes(value)) invalid();
  if (def.type === "list") {
    if (!Array.isArray(value) || value.length > 20 || (def.pattern && value.some(v => typeof v !== "string" || !new RegExp(def.pattern!).test(v)))) invalid();
  } else if (def.pattern && !new RegExp(def.pattern).test(string(value))) invalid();
  if (["car_value", "travelers_count", "employees_count"].includes(def.name) && Number(value) < 1) invalid();
  if (def.name === "car_year" && (Number(value) < 1900 || Number(value) > Number(today.slice(0, 4)) + 1)) invalid();
  if (def.name === "traveler_max_age" && Number(value) > 120) invalid();
  return value;
}

export function policyStatus(policy: JsonObject, date: string): string {
  if (policy.status === "cancelled") return "cancelled";
  if (policy.status === "pending_payment") return "pending_payment";
  if (string(policy.start_date) > date) return "not_yet_active";
  return string(policy.end_date) < date ? "expired" : "active";
}

export function requireActive(policy: JsonObject, date: string): void {
  if (policyStatus(policy, date) !== "active") throw new DomainError("policy_inactive", "Полис не действует на указанную дату; передам вопрос специалисту.", "Полис көрсетілген күні жарамсыз; сұрақты маманға беремін.", undefined, true);
}

export function productForScenario(id: string): string | undefined {
  return ({ SC01: "ogpo", SC02: "ogpo", SC03: "casco", SC06: "travel", SC07: "property", SC08: "accident", SC09: "dms", SC12: "ogpo", SC13: "casco", SC14: "property", SC15: "travel", SC16: "accident", SC21: "dms", SC22: "dms", SC24: "dms" } as Record<string, string>)[id];
}

export function regionFromPlate(dataset: Dataset, plate: string): string {
  const pricing = object(object(object(dataset.knowledge.products).ogpo).pricing);
  const map = object(pricing.region_by_plate_code); return string(map[plate.slice(-2)] ?? map.default);
}

export function countryZone(country: string): string | null {
  const v = country.toLowerCase().trim();
  if (/^(usa|us|united states|сша|ақш|america|америка|canada|канада)$/.test(v)) return "D";
  if (/^(russia|россия|ресей|belarus|беларусь|белоруссия|uzbekistan|узбекистан|өзбекстан|kyrgyzstan|киргизия|кыргызстан|қырғызстан|tajikistan|таджикистан|армения|armenia|azerbaijan|азербайджан|moldova|молдова|georgia|грузия|грузияға|kazakhstan|казахстан|қазақстан)$/.test(v)) return "A";
  if (/^(schengen|шенген|germany|германия|france|франция|italy|италия|spain|испания|portugal|португалия|poland|польша|greece|греция|austria|австрия|switzerland|швейцария|netherlands|нидерланды|belgium|бельгия|sweden|швеция|norway|норвегия|finland|финляндия|denmark|дания|czechia|czech republic|чехия|hungary|венгрия|croatia|хорватия|bulgaria|болгария|romania|румыния|latvia|латвия|lithuania|литва|estonia|эстония|slovakia|словакия|slovenia|словения|malta|мальта|iceland|исландия|luxembourg|люксембург|liechtenstein|лихтенштейн|uk|united kingdom|great britain|британия|великобритания|ұлыбритания|англия|england)$/.test(v)) return "B";
  if (/^(turkey|türkiye|турция|түркия|uae|united arab emirates|оаэ|баә|эмираты|дубай|dubai|thailand|таиланд|тайланд|egypt|египет|мысыр|china|китай|қытай|japan|япония|жапония|south korea|корея|india|индия|үндістан|vietnam|вьетнам|indonesia|индонезия|malaysia|малайзия|australia|австралия|brazil|бразилия|mexico|мексика|saudi arabia|саудовская аравия)$/.test(v)) return "C";
  return null;
}

export function calculatePrice(dataset: Dataset, product: string, slots: JsonObject, clients: JsonObject[]): JsonObject {
  const source = object(object(dataset.knowledge.products)[product]);
  const pricing = object(source.pricing);
  if (product === "ogpo") {
    const drivers = array(slots.drivers_iin);
    const coefficients = object(pricing.bm_coef);
    const classes = drivers.map(iin => string(clients.find(c => c.iin === iin)?.bm_class ?? object(dataset.backend.defaults).unknown_iin_bm_class ?? "3"));
    const worst = Math.max(...classes.map(c => Number(coefficients[c])));
    const region = string(slots.region), type = string(slots.vehicle_type), term = String(slots.term_months ?? 12);
    const price = Number(object(pricing.base_by_region_kzt)[region]) * Number(object(pricing.vehicle_type_coef)[type]) * worst * Number(object(pricing.term_coef)[term]);
    if (!Number.isFinite(price) || price <= 0) throw new DomainError("invalid_input", "Для расчёта нужны регион, тип автомобиля и ИИН водителей.", "Есептеу үшін өңір, көлік түрі және жүргізушілердің ЖСН-і қажет.", "drivers_iin");
    return { price: Math.round(price), currency: "KZT", term_months: Number(term), bm_classes: classes, source: "products.ogpo.pricing" };
  }
  if (product === "casco") {
    const age = Number(dataset.businessDate.slice(0, 4)) - Number(slots.car_year), pkg = string(slots.package ?? "Standard");
    if (age < 0 || age > Number(object(pricing.max_car_age)[pkg])) throw new DomainError("not_eligible", "Возраст автомобиля не подходит для этой программы КАСКО.", "Көліктің жасы осы КАСКО бағдарламасына сәйкес келмейді.", undefined, true);
    const range = age <= 3 ? "0-3" : age <= 7 ? "4-7" : age <= 10 ? "8-10" : "unknown";
    const rate = object(pricing.rate_by_car_age)[range];
    if (!rate) throw new DomainError("not_eligible", "В каталоге нет тарифа для этого возраста автомобиля; нужен специалист.", "Каталогта осы жастағы көлікке тариф жоқ; маман қажет.", undefined, true);
    const price = Number(slots.car_value) * Number(rate) * Number(object(pricing.franchise_coef)[string(slots.franchise ?? 0)]) * Number(object(pricing.package_coef)[pkg]);
    if (!Number.isFinite(price) || price <= 0) throw new DomainError("invalid_input", "Уточните стоимость автомобиля.", "Көлік құнын нақтылаңыз.", "car_value");
    return { price: Math.round(price), currency: "KZT", package: pkg, franchise: slots.franchise ?? 0, source: "products.casco.pricing" };
  }
  if (product === "travel") {
    const start = string(slots.trip_start), end = string(slots.trip_end), age = Number(slots.traveler_max_age), count = Number(slots.travelers_count);
    if (start < dataset.businessDate || end < start) throw new DomainError("invalid_input", "Проверьте даты: поездка должна начинаться не раньше даты кейса и заканчиваться после начала.", "Күндерді тексеріңіз: сапар кейс күнінен бұрын басталмауы және басталғаннан кейін аяқталуы керек.", "trip_start");
    if (age > 75) throw new DomainError("not_eligible", "Для путешественника старше семидесяти пяти лет оформление доступно через специалиста.", "Жетпіс бес жастан асқан саяхатшы үшін маман арқылы рәсімдеу қажет.", undefined, true);
    const zone = countryZone(string(slots.trip_country));
    if (!zone) throw new DomainError("not_eligible", "Не могу уверенно определить тарифную зону этой страны; передам специалисту.", "Бұл елдің тарифтік аймағын сенімді анықтай алмаймын; маманға беремін.", undefined, true);
    const z = object(object(source.zones)[zone]);
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    const price = Number(z.rate_per_day_kzt) * days * count * (age >= 65 ? 2 : 1);
    if (!Number.isFinite(price) || days <= 0 || count < 1) throw new DomainError("invalid_input", "Проверьте даты и число путешественников.", "Күндер мен саяхатшылар санын тексеріңіз.", "trip_end");
    return { price: Math.round(price), currency: "KZT", zone, coverage: z.coverage ?? null, days, source: "products.travel.pricing" };
  }
  if (product === "property" || product === "accident") {
    const base = object(source.price_per_year_kzt)[string(slots.sum_insured)];
    if (!base) throw new DomainError("invalid_input", "Для этой страховой суммы в программе нет тарифа.", "Бұл сақтандыру сомасына бағдарламада тариф жоқ.", "sum_insured");
    return { price: Math.round(Number(base) * (product === "property" && slots.property_type === "house" ? Number(source.house_coef) : 1)), currency: "KZT", source: `products.${product}.price_per_year_kzt` };
  }
  throw new DomainError("not_eligible", "Для расчёта этого продукта требуется специалист.", "Бұл өнімді есептеу үшін маман қажет.", undefined, true);
}

export function lookupKnowledge(dataset: Dataset, scenarioId: string, slots: JsonObject): JsonObject {
  const kb = dataset.knowledge, product = string(slots.product_type || productForScenario(scenarioId)), products = object(kb.products);
  const paths: Record<string, string[]> = {
    SC03: ["products.casco"], SC07: ["products.property"], SC08: ["products.accident"], SC09: ["products.dms"],
    SC11: ["claims.road_accident_now"], SC15: ["products.travel.notes", "company.contact_center"], SC19: ["claims.dispute"],
    SC24: ["products.dms.e_card"], SC28: ["cancellation"], SC31: ["payments"], SC32: ["bonus_malus"], SC34: ["app_help"], SC35: ["complaints"], SC38: ["fraud_policy"], SC39: ["documents_available"],
  };
  if (scenarioId === "SC18") return { source: "claims.documents", documents: object(object(kb.claims).documents)[product === "ogpo" ? "ogpo_victim" : product] ?? null, submission: object(kb.claims).submission ?? null };
  if (scenarioId === "SC40") {
    const topic = string(slots.topic).toLowerCase();
    const selected = /исключ|exclus|өтелм|қамтылма/.test(topic) ? object(products[product]).exclusions : products[product];
    return { source: product ? `products.${product}` : "company", topic: slots.topic ?? null, content: selected ?? (product ? products[product] : kb.company) ?? null };
  }
  const selected: JsonObject = {};
  for (const path of paths[scenarioId] ?? []) { let v: Json = kb; for (const key of path.split(".")) v = object(v)[key] ?? null; selected[path] = v; }
  return { sources: Object.keys(selected), content: selected };
}
