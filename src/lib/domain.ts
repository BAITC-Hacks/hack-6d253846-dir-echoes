import { createHash, randomUUID } from "node:crypto";
import type { ActionResult, DialogueState, ExecuteInput, ExecuteOutput, Json, JsonObject, Scenario } from "./types";
import { appHelpFailed, MUTATING_ACTIONS, planActions, statusLabel, type ActionPlan } from "./domain-actions";
import { array, DomainError, localized, lookupKnowledge, mask, normalizeSlot, object, policyStatus, present, productForScenario, regionFromPlate, string } from "./domain-data";
import { effectiveSlots } from "./routing-slots";
import { languageFromList, spokenLanguages, stateLanguages } from "./languages";
import { domainErrorText, domainPhrase, turkishConfirmation, turkishFallback, turkishScenarioName, turkishSlotPrompt } from "./domain-language";

export function initialState(): DialogueState {
  return { language: "ru", responseLanguages: ["ru"], activeScenarioId: null, pendingScenarioIds: [], suspendedScenarioIds: [], completedScenarioIds: [], slots: {}, slotsByScenario: {}, clientId: null, pendingConfirmation: null, unclearCount: 0, lastQuestionSlot: null, lookupFailures: 0, status: "active" };
}

const identitySlots = ["phone", "iin", "policy_number", "claim_number"];
const actionDependencies: Record<string, string[]> = { SC01: ["term_months"], SC02: ["region", "vehicle_type", "term_months"], SC03: ["package"], SC06: ["phone"], SC12: ["policy_number"], SC26: ["policy_number"], SC27: ["product_type"] };
const prices = ["calc_ogpo_price", "calc_casco_price", "calc_travel_price", "calc_property_price", "calc_accident_price"];
const mixedSlotQuestions: Record<string, string> = {
  region: "Көлік қай қалада зарегистрирован?",
  vehicle_type: "Бұл легковой автомобиль ме?",
  phone: "Телефон нөміріңізді подскажите, пожалуйста.",
  iin: "ЖСН-іңізді назовите, пожалуйста.",
  policy_number: "Номер полиса қолыңызда болса, айтып жіберіңізші.",
  claim_number: "Номер заявления айтып жіберіңізші.",
  drivers_iin: "Кім жүргізеді? Назовите ЖСН каждого водителя.",
  city: "Подскажите, қай қаладасыз?",
  package: "Қай бағдарламаны таңдайсыз: Standard или Lite?",
  term_months: "Қай срок керек: 6 или 12 месяцев?",
};

function allowedSlots(scenario: Scenario): Set<string> { return new Set([...scenario.slots.required, ...scenario.slots.optional, ...identitySlots, "product_type", ...(actionDependencies[scenario.scenario_id] ?? [])]); }

function defaultQuestion(input: ExecuteInput, state: DialogueState, slot: string): string {
  const def = effectiveSlots(input.dataset).find(s => s.name === slot);
  if (stateLanguages(state).includes("tr")) {
    const options = def?.values?.length && def.values.every(value => typeof value === "number") ? ` Seçenekler: ${def.values.join(", ")}${slot === "term_months" ? " ay" : " tenge"}.` : "";
    return turkishSlotPrompt(state, slot, def?.prompt.ru ?? "Уточните недостающие данные.", def?.prompt.kk ?? "Жетіспейтін деректерді нақтылаңыз.", mixedSlotQuestions[slot], options);
  }
  if (def && state.language === "mixed" && mixedSlotQuestions[slot]) return mixedSlotQuestions[slot];
  return def?.prompt[state.language === "kk" ? "kk" : "ru"] ?? localized(state.language, "Уточните недостающие данные.", "Жетіспейтін деректерді нақтылаңыз.", "Уточните, пожалуйста, жетіспейтін деректерді.");
}

function safeSlots(slots: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(slots)) if (!key.startsWith("__")) result[key] = typeof value === "string" ? mask(value) : Array.isArray(value) ? value.map(v => typeof v === "string" ? mask(v) : v) : value;
  return result;
}

function reviewSignature(plan: ActionPlan): string {
  // Every planned write is covered. Random IDs are represented by their stable plan position;
  // timestamps and HTTP request IDs never force an otherwise identical second preview.
  const identifiers = new Map(plan.writes.map((write, index) => [write.id, `planned:${write.kind}:${index}`]));
  const ignored = new Set(["created_at", "updated_at", "applied_at", "createdAt", "session_id", "request_id", "outbox_id", "ticket_id"]);
  const normalize = (value: Json): Json => {
    if (typeof value === "string") {
      let normalized = value;
      for (const [id, replacement] of identifiers) normalized = normalized.replaceAll(id, replacement);
      return normalized;
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => !ignored.has(key)).map(key => [key, normalize(value[key])]));
    return value;
  };
  const reviewed: JsonObject = {
    actions: plan.results.filter(action => MUTATING_ACTIONS.has(action.name)).map(action => ({ action: action.name, data: normalize(action.data) })),
    writes: plan.writes.map(write => ({ kind: write.kind, data: normalize(write.value) })),
    handoff: plan.handoff ? normalize(plan.handoff) : null,
  };
  return createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}

function confirmationSummary(scenario: Scenario, slots: JsonObject, plan: ActionPlan, state: DialogueState): string {
  const language = state.language;
  if (stateLanguages(state).includes("tr")) return domainPhrase(state, "", "", undefined, turkishConfirmation(scenario, slots, plan));
  const values = plan.results.filter(a => a.status === "preview").map(a => {
    const d = a.data;
    if (a.name === "cancel_policy") return localized(language, `Расторгнуть полис ${slots.policy_number}; расчёт возврата ${d.refund_amount} тенге`, `${slots.policy_number} полисін бұзу; есептелген қайтарым ${d.refund_amount} теңге`);
    if (a.name === "update_contact") return localized(language, `Изменить ${slots.contact_field}: ${mask(string(slots.new_value))}`, `${slots.contact_field} өзгерту: ${mask(string(slots.new_value))}`);
    if (a.name === "create_policy" || a.name === "renew_policy") return localized(language, `Сохранить заявку на ${a.name === "renew_policy" ? "продление" : "оформление"} полиса, стоимость ${d.price} тенге; оплата ещё не проведена`, `Полисті ${a.name === "renew_policy" ? "ұзарту" : "рәсімдеу"} өтінімін сақтау, құны ${d.price} теңге; төлем әлі жасалмаған`);
    if (a.name === "book_appointment" || a.name === "book_inspection") return localized(language, `Создать запрос на ${a.name === "book_appointment" ? "приём" : "осмотр"} на ${slots.preferred_date}; время подтвердит специалист`, `${slots.preferred_date} күніне ${a.name === "book_appointment" ? "қабылдау" : "тексеру"} сұранысын жасау; уақытты маман растайды`);
    if (a.name === "create_claim") return localized(language, `Зарегистрировать страховой случай от ${slots.incident_date}: ${mask(string(slots.incident_description))}`, `${slots.incident_date} күнгі сақтандыру оқиғасын тіркеу: ${mask(string(slots.incident_description))}`);
    if (a.name === "create_dispute") return localized(language, `Зарегистрировать несогласие по ${slots.claim_number}: ${mask(string(slots.complaint_text))}`, `${slots.claim_number} бойынша келіспеушілікті тіркеу: ${mask(string(slots.complaint_text))}`);
    if (a.name === "update_policy") return localized(language, `Изменить полис ${slots.policy_number}: ${scenario.scenario_id === "SC04" ? `добавить водителя ${mask(string(slots.new_driver_iin))}` : `госномер ${slots.vehicle_plate}`}${d.extra_premium === null ? "; доплату рассчитает специалист" : `; доплата ${d.extra_premium} тенге`}`, `${slots.policy_number} полисін өзгерту: ${scenario.scenario_id === "SC04" ? `жүргізушіні қосу ${mask(string(slots.new_driver_iin))}` : `көлік нөмірі ${slots.vehicle_plate}`}`);
    if (a.name === "create_callback") return localized(language, `Сохранить просьбу об обратном звонке на ${slots.callback_time}; время согласует специалист`, `${slots.callback_time} уақытына кері қоңырау сұранысын сақтау; уақытты маман келіседі`);
    if (a.name === "create_complaint") return localized(language, `Зарегистрировать жалобу: ${mask(string(slots.complaint_text))}`, `Шағымды тіркеу: ${mask(string(slots.complaint_text))}`);
    if (a.name === "report_fraud") return localized(language, `Зарегистрировать сообщение о подозрительном обращении: ${mask(string(slots.fraud_details))}`, `Күдікті хабарласу туралы хабарламаны тіркеу: ${mask(string(slots.fraud_details))}`);
    if (a.name === "send_sms") return localized(language, `Сохранить запрос SMS на ${string(d.recipient)}; доставка пока недоступна`, `${string(d.recipient)} нөміріне SMS сұранысын сақтау; жеткізу әзірге қолжетімсіз`);
    if (a.name === "resend_documents" || a.name === "request_document") return localized(language, `Сохранить запрос документа на ${string(d.destination_masked)}; доставка пока недоступна`, `${string(d.destination_masked)} мекенжайына құжат сұранысын сақтау; жеткізу әзірге қолжетімсіз`);
    if (a.name === "transfer_to_operator") return localized(language, "Передать запрос и контекст специалисту", "Сұраныс пен контекстті маманға беру");
    return scenario.name;
  });
  return values.join("; ");
}

function fallbackReply(scenario: Scenario, plan: ActionPlan, state: DialogueState): string {
  if (stateLanguages(state).includes("tr")) return domainPhrase(state, "", "", undefined, turkishFallback(scenario, plan));
  const lang = state.language, find = (name: string) => object(plan.facts[name]);
  const quote = plan.results.find(a => prices.includes(a.name));
  if (plan.handoff) {
    const manual = object(plan.facts.manual_fulfillment);
    if (manual.request_id) return localized(lang, `Запрос ${manual.request_id} сохранён и передан специалисту для согласования. Время и внешнее исполнение ещё не подтверждены.`, `${manual.request_id} сұранысы сақталып, келісу үшін маманға берілді. Уақыт пен сыртқы орындалу әлі расталған жоқ.`, `Запрос ${manual.request_id} сохранён и передан специалисту для согласования. Уақыт пен сыртқы орындалу әлі расталған жоқ.`);
    return localized(lang, "Запрос и контекст сохранены в очереди специалиста. Оператор сможет продолжить разговор здесь.", "Сұраныс пен контекст маман кезегінде сақталды. Оператор әңгімені осы жерде жалғастыра алады.", "Запрос и контекст сохранены в очереди специалиста. Оператор әңгімені осы жерде жалғастыра алады.");
  }
  switch (scenario.scenario_id) {
    case "SC01": case "SC03": case "SC07": case "SC08": return localized(lang, `Стоимость по условиям программы — ${quote?.data.price} тенге. Расчёт сохранён в истории разговора.`, `Бағдарлама шарттары бойынша құны — ${quote?.data.price} теңге. Есеп әңгіме тарихында сақталды.`);
    case "SC02": case "SC06": case "SC27": { const d = find(scenario.scenario_id === "SC27" ? "renew_policy" : "create_policy"); return localized(lang, `Заявка ${d.policy_number} сохранена, стоимость ${d.price} тенге. Полис ожидает оплаты; платёжная ссылка пока недоступна.`, `${d.policy_number} өтінімі сақталды, құны ${d.price} теңге. Полис төлемді күтуде; төлем сілтемесі әзірге қолжетімсіз.`); }
    case "SC04": case "SC05": return localized(lang, `Изменение полиса сохранено.${find("update_policy").extra_premium === null ? " Доплату должен проверить специалист." : " Доплата не требуется."}`, "Полистегі өзгеріс сақталды. Қосымша төлемді маман тексереді.");
    case "SC11": return localized(lang, "Если есть пострадавшие, звоните сто двенадцать; включите аварийные огни и выставьте знак. Сфотографируйте место ДТП и не передвигайте автомобили до оформления.", "Зардап шеккендер болса, жүз он екіге қоңырау шалыңыз; апаттық шамдар мен ескерту белгісін қосыңыз. Оқиға орнын суретке түсіріп, рәсімделгенге дейін көлікті қозғамаңыз.");
    case "SC12": case "SC13": case "SC14": case "SC16": return localized(lang, `Заявление ${find("create_claim").claim_number} зарегистрировано. Документы можно загрузить в разделе «Мои заявления» приложения.`, `${find("create_claim").claim_number} өтініші тіркелді. Құжаттарды қосымшадағы «Менің өтініштерім» бөліміне жүктеуге болады.`);
    case "SC17": return localized(lang, `По заявлению ${find("get_claim").claim_number}: ${statusLabel(find("get_claim").status)}. ${string(find("get_claim").next_step)}`, `${find("get_claim").claim_number} өтінішінің мәртебесі: ${find("get_claim").status}. ${string(find("get_claim").next_step)}`);
    case "SC19": return localized(lang, `Несогласие ${find("create_dispute").ticket_id} зарегистрировано. Срок рассмотрения по правилам — пятнадцать рабочих дней.`, `${find("create_dispute").ticket_id} келіспеушілігі тіркелді. Ереже бойынша қарау мерзімі — он бес жұмыс күні.`);
    case "SC20": case "SC21": return localized(lang, "Запрос на запись сохранён. Время ещё не подтверждено: его согласует специалист.", "Жазылу сұранысы сақталды. Уақыт әлі расталмаған: оны маман келіседі.");
    case "SC22": { const d = find("check_coverage"); return localized(lang, d.covered === true ? `Услуга входит в программу ${d.package}; ${d.note ?? "действуют условия программы"}.` : d.covered === false ? "Услуга не входит в вашу программу ДМС." : "Для этой услуги в каталоге недостаточно сведений; нужна проверка специалиста.", d.covered === true ? `Қызмет ${d.package} бағдарламасына кіреді; бағдарлама шарттары қолданылады.` : d.covered === false ? "Қызмет сіздің ДМС бағдарламаңызға кірмейді." : "Каталогта бұл қызмет туралы мәлімет жеткіліксіз; маман тексеруі қажет."); }
    case "SC23": return localized(lang, `В вашем городе: ${array(find("list_clinics").clinics).map(c => string(object(c).name)).join(", ")}. Адреса доступны в деталях результата.`, `Сіздің қалаңызда: ${array(find("list_clinics").clinics).map(c => string(object(c).name)).join(", ")}. Мекенжайлар нәтиже мәліметтерінде бар.`);
    case "SC24": return localized(lang, "Электронная карта доступна в приложении в разделе «Мои полисы». Запрос SMS сохранён; доставка пока не подтверждена.", "Электрондық карта қосымшадағы «Менің полистерім» бөлімінде бар. SMS сұранысы сақталды; жеткізу әзірге расталмады.");
    case "SC25": return localized(lang, `Полис ${find("get_policy").policy_number}: ${statusLabel(find("get_policy").status)}, срок до ${find("get_policy").end_date}.`, `${find("get_policy").policy_number} полисінің мәртебесі: ${find("get_policy").status}, мерзімі ${find("get_policy").end_date} дейін.`);
    case "SC26": case "SC39": return localized(lang, "Запрос на отправку документа сохранён в очереди. Доставка ещё не подтверждена.", "Құжат жіберу сұранысы кезекте сақталды. Жеткізу әлі расталған жоқ.");
    case "SC28": return localized(lang, `Полис расторгнут; расчёт возврата — ${find("cancel_policy").refund_amount} тенге. Возврат средств ожидает обработки.`, `Полис бұзылды; есептелген қайтарым — ${find("cancel_policy").refund_amount} теңге. Қаражатты қайтару өңдеуді күтуде.`);
    case "SC29": return localized(lang, "Контактные данные обновлены и сохранены.", "Байланыс деректері жаңартылды және сақталды.");
    case "SC30": return localized(lang, `Платёж найден: ${find("check_payment").amount} тенге, статус ${find("check_payment").payment_status}.`, `Төлем табылды: ${find("check_payment").amount} теңге, мәртебесі ${find("check_payment").payment_status}.`);
    case "SC32": return localized(lang, `Ваш класс бонус-малус — ${find("get_bm_class").bm_class}. За год без ДТП по вашей вине он повышается на один, после виновного ДТП снижается на два.`, `Сіздің бонус-малус сыныбыңыз — ${find("get_bm_class").bm_class}. Өз кінәңізбен ЖКО болмаған жыл үшін бір саты көтеріледі, кінәлі ЖКО-дан кейін екі саты төмендейді.`);
    case "SC33": return localized(lang, `Офис: ${find("get_offices").address}. Часы работы: ${find("get_offices").hours}.`, `Кеңсе: ${find("get_offices").address}. Жұмыс уақыты: ${find("get_offices").hours}.`);
    case "SC35": return localized(lang, `Жалоба ${find("create_complaint").ticket_id} зарегистрирована. Ответ предусмотрен в течение пятнадцати рабочих дней.`, `${find("create_complaint").ticket_id} шағымы тіркелді. Жауап он бес жұмыс күні ішінде қарастырылған.`);
    case "SC36": return localized(lang, `Запрос обратного звонка на ${find("create_callback").callback_time} сохранён. Время ожидает подтверждения специалистом.`, `${find("create_callback").callback_time} уақытына кері қоңырау сұранысы сақталды. Уақыт маманның растауын күтуде.`);
    case "SC38": return localized(lang, "Сообщение о подозрительном звонке зарегистрировано. Никому не сообщайте коды SMS, CVV и PIN.", "Күдікті қоңырау туралы хабарлама тіркелді. Ешкімге SMS кодын, CVV және PIN айтпаңыз.");
    case "SC09": return localized(lang, "Есть программы ДМС Basic за сто восемьдесят тысяч и Comfort за триста двадцать тысяч тенге в год. Comfort также включает стоматологическое лечение и МРТ по направлению до двух раз в год.", "Жылдық ДМС Basic бағдарламасы жүз сексен мың, Comfort үш жүз жиырма мың теңге тұрады. Comfort тіс емдеуді және жолдамамен жылына екі ретке дейін МРТ қамтиды.");
    case "SC31": return localized(lang, "Оплатить можно картой, по платёжной ссылке, переводом для компаний или в терминале офиса. Рассрочка есть для КАСКО на два или четыре платежа и для индивидуального ДМС на два платежа.", "Картамен, төлем сілтемесімен, компанияларға аударыммен немесе кеңсе терминалында төлеуге болады. КАСКО үшін екі не төрт төлем, жеке ДМС үшін екі төлем қарастырылған.");
    case "SC34": return localized(lang, "Вход в приложение — по телефону и одноразовому SMS-коду. Если код не пришёл, проверьте номер, подождите шестьдесят секунд и запросите снова; лимит — пять кодов в час.", "Қосымшаға телефон және бір реттік SMS кодымен кіресіз. Код келмесе, нөмірді тексеріп, алпыс секунд күтіп, қайта сұраңыз; сағатына бес код шегі бар.");
    default: return localized(lang, "Сведения из правил программы доступны в результате запроса. Я использую только предоставленную базу знаний.", "Бағдарлама ережелерінің мәліметтері сұраныс нәтижесінде бар. Мен тек берілген білім қорын қолданамын.");
  }
}

async function identifyAndFill(input: ExecuteInput, state: DialogueState, scenario: Scenario): Promise<void> {
  const { store, dataset } = input, slots = state.slots;
  let client = state.clientId ? await store.get("clients", state.clientId) : null;
  if (scenario.requires_identification && !client) {
    const clients = await store.list("clients");
    if (slots.phone || slots.iin) client = clients.find(c => (!slots.phone || c.phone === slots.phone) && (!slots.iin || c.iin === slots.iin)) ?? null;
    else if (slots.claim_number) { const claim = await store.get("claims", string(slots.claim_number)); if (claim) client = await store.get("clients", string(claim.client_id)); }
    else if (slots.policy_number) { const policy = await store.get("policies", string(slots.policy_number)); if (policy) client = await store.get("clients", string(policy.client_id)); }
    if (!client && identitySlots.some(k => present(slots[k]))) throw new DomainError("not_found", "Не удалось найти клиента по указанным данным.", "Көрсетілген деректер бойынша клиент табылмады.", slots.phone ? "phone" : slots.iin ? "iin" : slots.claim_number ? "claim_number" : "policy_number");
    if (!client) return;
    state.clientId = string(client.client_id);
  }
  if (client) {
    // A known session identity is immutable unless the operator starts a new session.
    if ((slots.phone && client.phone && slots.phone !== client.phone) || (slots.iin && client.iin && slots.iin !== client.iin && scenario.requires_identification)) throw new DomainError("not_found", "Идентификатор не совпадает с текущим клиентом; для другого клиента начните новый разговор.", "Идентификатор ағымдағы клиентке сәйкес келмейді; басқа клиент үшін жаңа әңгіме бастаңыз.", slots.phone !== client.phone ? "phone" : "iin");
    for (const key of ["phone", "city", "email"]) if (!present(slots[key]) && present(client[key])) slots[key] = client[key];
    if (!slots.iin && client.iin && ["SC32"].includes(scenario.scenario_id)) slots.iin = client.iin;
    const expected = productForScenario(scenario.scenario_id);
    let policies = (await store.list("policies")).filter(p => p.client_id === state.clientId && (!expected || p.product === expected));
    if (!slots.policy_number && scenario.scenario_id !== "SC12") {
      const active = policies.filter(p => policyStatus(p, dataset.businessDate) === "active");
      if (active.length === 1) policies = active;
      if (policies.length === 1) slots.policy_number = policies[0].policy_number;
    }
    if (!slots.claim_number && ["SC17", "SC19", "SC20"].includes(scenario.scenario_id)) {
      const claims = (await store.list("claims")).filter(c => c.client_id === state.clientId);
      if (claims.length === 1) slots.claim_number = claims[0].claim_number;
    }
  }
  if (slots.policy_number && scenario.scenario_id !== "SC12") {
    const policy = await store.get("policies", string(slots.policy_number));
    if (policy && state.clientId && policy.client_id !== state.clientId) throw new DomainError("not_found", "Полис недоступен для текущего клиента.", "Полис ағымдағы клиентке қолжетімсіз.", "policy_number");
    if (policy && state.clientId === policy.client_id) {
      if (!slots.product_type) slots.product_type = policy.product;
      const details = object(policy.details);
      for (const key of ["vehicle_plate", "vehicle_type", "drivers_iin", "car_year", "car_value", "franchise", "property_type", "sum_insured"]) if (!present(slots[key]) && present(details[key])) slots[key] = details[key];
    }
  }
  const product = productForScenario(scenario.scenario_id); if (product) slots.product_type = product;
  if (["SC01", "SC02"].includes(scenario.scenario_id) && !slots.region && slots.vehicle_plate) slots.region = regionFromPlate(dataset, string(slots.vehicle_plate));
}

function complete(state: DialogueState, scenario: Scenario): void {
  state.slotsByScenario[scenario.scenario_id] = structuredClone(state.slots);
  state.completedScenarioIds = [...new Set([...state.completedScenarioIds, scenario.scenario_id])];
  state.activeScenarioId = null; state.lastQuestionSlot = null; state.pendingConfirmation = null; state.lookupFailures = 0;
}

export async function executeTurn(input: ExecuteInput): Promise<ExecuteOutput> {
  const state = structuredClone(input.state), { dataset, decision, store } = input;
  const slotDefinitions = effectiveSlots(dataset);
  const replyLanguage = decision.responseLanguage ?? decision.language;
  state.responseLanguages = spokenLanguages(replyLanguage, decision.responseLanguages ?? (replyLanguage === input.state.language ? stateLanguages(input.state) : undefined));
  state.language = languageFromList(state.responseLanguages);
  const output: ExecuteOutput = { state, actions: [], reply: "", facts: {}, warnings: [] };
  const text = (ru: string, kk: string, mixed?: string, tr?: string) => domainPhrase(state, ru, kk, mixed, tr);
  const handoff = (queue: string, reason: string, authorized = false): ExecuteOutput => {
    const selectedQueue = dataset.queues.includes(queue) ? queue : "operator_general";
    if (!authorized) {
      if (state.activeScenarioId && state.activeScenarioId !== "SC37") {
        state.slotsByScenario[state.activeScenarioId] = structuredClone(state.slots);
        if (!state.suspendedScenarioIds.includes(state.activeScenarioId)) state.suspendedScenarioIds.push(state.activeScenarioId);
      }
      const snapshot: JsonObject = { __handoff: true, __handoff_queue: selectedQueue, __handoff_reason: reason };
      const summary = text("Передать запрос и контекст специалисту", "Сұраныс пен контекстті маманға беру");
      state.activeScenarioId = "SC37"; state.status = "active"; state.lastQuestionSlot = null;
      state.slots = snapshot; state.slotsByScenario.SC37 = snapshot;
      state.pendingConfirmation = { id: randomUUID(), scenarioId: "SC37", actionNames: ["transfer_to_operator"], slots: snapshot, summary, createdAt: new Date().toISOString() };
      output.actions.push({ name: "transfer_to_operator", status: "preview", data: { queue: selectedQueue } });
      output.facts = { ...output.facts, confirmation_required: true, proposed_queue: selectedQueue };
      output.reply = text("Могу передать запрос и контекст специалисту. Подтверждаете?", "Сұраныс пен контекстті маманға бере аламын. Растайсыз ба?", "Могу передать запрос и контекст специалисту. Растайсыз ба?");
      return output;
    }
    state.status = "handoff"; state.pendingConfirmation = null;
    output.handoff = { queue: selectedQueue, reason };
    output.actions.push({ name: "transfer_to_operator", status: "queued", data: { queue: output.handoff.queue, status: "waiting" } });
    output.reply = text("Запрос и контекст переданы в очередь специалиста. Оператор сможет продолжить этот разговор.", "Сұраныс пен контекст маман кезегіне берілді. Оператор осы әңгімені жалғастыра алады.", "Запрос и контекст переданы в очередь специалиста. Оператор осы әңгімені жалғастыра алады."); return output;
  };
  if (state.status === "closed") { output.reply = text("Разговор завершён; начните новый для следующего вопроса.", "Әңгіме аяқталды; келесі сұрақ үшін жаңасын бастаңыз."); return output; }
  const candidates = decision.scenarios.filter(c => dataset.scenarios.some(s => s.scenario_id === c.scenarioId) || dataset.systemIntents.some(s => s.id === c.scenarioId));
  const ranked = [...candidates].sort((a, b) => Number(dataset.scenarios.find(s => s.scenario_id === b.scenarioId)?.priority === "urgent") - Number(dataset.scenarios.find(s => s.scenario_id === a.scenarioId)?.priority === "urgent"));
  const primary = ranked[0];
  const pendingHandoff = state.pendingConfirmation?.slots.__handoff === true ? state.pendingConfirmation : null;
  if (pendingHandoff && (!primary || primary.scenarioId === "SC37" || primary.scenarioId === "SYS_UNCLEAR")) {
    if (decision.confirmation === "reject") {
      state.pendingConfirmation = null; state.unclearCount = 0;
      state.activeScenarioId = state.suspendedScenarioIds.pop() ?? null;
      state.slots = state.activeScenarioId ? structuredClone(state.slotsByScenario[state.activeScenarioId] ?? {}) : {};
      if (state.activeScenarioId === "SC34") {
        delete state.slots.__app_help_failed;
        state.slotsByScenario.SC34 = structuredClone(state.slots);
      }
      output.reply = text("Передача отменена. Продолжим разговор здесь.", "Маманға беру тоқтатылды. Әңгімені осы жерде жалғастырайық.", "Передача отменена. Әңгімені осы жерде жалғастырайық."); return output;
    }
    if (decision.confirmation === "confirm") {
      const previous = await store.get("operations", pendingHandoff.id);
      const result = handoff(string(pendingHandoff.slots.__handoff_queue), string(pendingHandoff.slots.__handoff_reason), true);
      if (previous) { result.handoff = undefined; result.reply = string(previous.reply); result.warnings.push("Operator handoff consent was already applied."); return result; }
      await store.put("operations", pendingHandoff.id, { id: pendingHandoff.id, scenario_id: "SC37", reply: result.reply, session_id: input.sessionId, applied_at: new Date().toISOString() });
      return result;
    }
    if (decision.isContinuation || primary?.scenarioId === "SYS_UNCLEAR") {
      output.facts = { confirmation_required: true, proposed_queue: pendingHandoff.slots.__handoff_queue };
      output.reply = text("Передать запрос специалисту? Ответьте «да» или «нет».", "Сұранысты маманға берейін бе? «Иә» немесе «жоқ» деп жауап беріңіз.", "Сұранысты маманға берейін бе? Ответьте «да» или «нет»."); return output;
    }
  }
  // Only an unambiguous direct request is already the client's decision.
  // Lower-confidence routing must reach the clarification branch below.
  if (primary?.scenarioId === "SC37" && primary.confidence >= 0.75 && !decision.clarification && !decision.alternatives.length) return handoff(pendingHandoff ? string(pendingHandoff.slots.__handoff_queue) : "operator_general", pendingHandoff ? string(pendingHandoff.slots.__handoff_reason) : "Client requested a human operator", true);
  if (primary?.scenarioId === "SYS_GOODBYE" && primary.confidence >= 0.75) { state.status = "closed"; state.pendingConfirmation = null; output.reply = text("Спасибо за обращение. Всего доброго!", "Хабарласқаныңызға рақмет. Сау болыңыз!"); return output; }
  if (primary?.scenarioId === "SYS_OUT_OF_SCOPE" && primary.confidence >= 0.75) { output.reply = text("Я помогаю с услугами страхования Saqta: авто, ДМС, поездки, имущество и несчастные случаи. Какой вопрос по этим услугам вас интересует?", "Мен Saqta сақтандыруы бойынша көмектесемін: көлік, ДМС, саяхат, мүлік және жазатайым оқиғалар. Осы қызметтер бойынша қандай сұрағыңыз бар?"); return output; }
  const continued = decision.isContinuation && !!state.activeScenarioId && (!primary || primary.scenarioId === state.activeScenarioId || primary.scenarioId === "SYS_UNCLEAR");
  if (!continued && (!primary || primary.confidence < 0.75 || primary.scenarioId === "SYS_UNCLEAR")) {
    state.unclearCount = (!primary || primary.confidence < 0.45 || primary.scenarioId === "SYS_UNCLEAR") ? state.unclearCount + 1 : 0;
    if ((!primary || primary.confidence < 0.45 || primary.scenarioId === "SYS_UNCLEAR") && state.unclearCount >= 2) return handoff("operator_general", "Two unresolved low-confidence turns");
    const choices = [...ranked, ...decision.alternatives].filter(c => dataset.scenarios.some(s => s.scenario_id === c.scenarioId)).slice(0, 2).map(c => { const choice = dataset.scenarios.find(s => s.scenario_id === c.scenarioId)!; return stateLanguages(state).includes("tr") ? turkishScenarioName(choice) : choice.name; });
    output.reply = decision.clarification || (choices.length === 2 ? text(`Вы хотите: ${choices[0]} или ${choices[1]}?`, `${choices[0]} немесе ${choices[1]} керек пе?`, `Уточните, қайсысы керек: ${choices[0]} немесе ${choices[1]}?`, `Hangisini istiyorsunuz: ${choices[0]} veya ${choices[1]}?`) : text("Уточните, пожалуйста: вам нужна информация, действие по полису или помощь со страховым случаем?", "Нақтылаңызшы: ақпарат, полис бойынша әрекет немесе сақтандыру оқиғасына көмек керек пе?", "Нақтылаңызшы: нужна информация, действие по полису немесе помощь со страховым случаем?")); return output;
  }
  state.unclearCount = 0;
  const targetId = continued ? state.activeScenarioId! : primary!.scenarioId;
  const scenario = dataset.scenarios.find(s => s.scenario_id === targetId);
  if (!scenario) return handoff("operator_general", "Scenario missing from catalog");
  const previousId = state.activeScenarioId;
  if (previousId && previousId !== targetId) {
    if (previousId === "SC34") delete state.slots.__app_help_failed;
    state.slotsByScenario[previousId] = structuredClone(state.slots);
    if (!state.suspendedScenarioIds.includes(previousId)) state.suspendedScenarioIds.push(previousId);
    state.pendingConfirmation = null; state.lookupFailures = 0;
  }
  if (previousId !== targetId) {
    const previousSlots = state.slots;
    state.slots = structuredClone(state.slotsByScenario[targetId] ?? {});
    if (targetId === "SC34") delete state.slots.__app_help_failed;
    if (targetId === "SC02") for (const key of ["region", "vehicle_type", "vehicle_plate", "drivers_iin", "phone", "term_months"]) if (!state.slots[key] && (previousId === "SC01" || state.completedScenarioIds.at(-1) === "SC01")) state.slots[key] = previousSlots[key] ?? null;
    state.lastQuestionSlot = null;
  }
  // A new app-help request is not a continuation of an earlier failed attempt.
  // An actual confirmation still restores its reviewed snapshot below.
  if (targetId === "SC34" && !continued && decision.confirmation === "none") {
    delete state.slots.__app_help_failed;
    if (state.pendingConfirmation?.scenarioId === "SC34") state.pendingConfirmation = null;
  }
  state.activeScenarioId = targetId;
  state.suspendedScenarioIds = state.suspendedScenarioIds.filter(id => id !== targetId);
  state.pendingScenarioIds = [...new Set([...state.pendingScenarioIds.filter(id => id !== targetId), ...ranked.filter(c => c.scenarioId !== targetId && c.confidence >= 0.75 && c.scenarioId.startsWith("SC")).map(c => c.scenarioId)])];
  // Store multi-intent slots per scenario; never copy unrelated free text into the active operation.
  for (const id of state.pendingScenarioIds) {
    const pending = dataset.scenarios.find(s => s.scenario_id === id); if (!pending) continue;
    const selected = state.slotsByScenario[id] ?? {};
    for (const [key, value] of Object.entries(decision.slots)) if (allowedSlots(pending).has(key) && present(value)) selected[key] = value;
    state.slotsByScenario[id] = selected;
  }
  const accepted = allowedSlots(scenario);
  let changedWhilePending = false;
  try {
    for (const [key, value] of Object.entries(decision.slots)) {
      if (!accepted.has(key) || !present(value)) continue;
      const def = slotDefinitions.find(s => s.name === key);
      const normalized = def ? normalizeSlot(def, value, dataset.businessDate) : value;
      if (key === "term_months" && ![6, 12].includes(Number(normalized))) throw new DomainError("invalid_input", "Доступен срок шесть или двенадцать месяцев.", "Алты немесе он екі ай мерзімі қолжетімді.", "term_months");
      if (key === "package" && !["Standard", "Lite"].includes(string(normalized))) throw new DomainError("invalid_input", "Уточните программу: Standard или Lite.", "Бағдарламаны нақтылаңыз: Standard немесе Lite.", "package");
      if (state.pendingConfirmation && JSON.stringify(state.pendingConfirmation.slots[key]) !== JSON.stringify(normalized)) changedWhilePending = true;
      state.slots[key] = normalized;
    }
    // Stored slots originated in earlier LLM turns too; validate them at each execution boundary.
    for (const [key, value] of Object.entries(state.slots)) {
      const def = slotDefinitions.find(s => s.name === key); if (def && present(value)) state.slots[key] = normalizeSlot(def, value, dataset.businessDate);
    }
    if (targetId === "SC29" && state.slots.contact_field && state.slots.new_value) {
      const kind = string(state.slots.contact_field), def = slotDefinitions.find(s => s.name === kind);
      if (def) state.slots.new_value = normalizeSlot(def, state.slots.new_value, dataset.businessDate);
    }
    if (changedWhilePending) state.pendingConfirmation = null;
    if (state.pendingConfirmation && decision.confirmation === "reject") {
      if (targetId === "SC34") delete state.slots.__app_help_failed;
      state.pendingConfirmation = null; output.reply = text("Действие отменено. Какие данные нужно изменить?", "Әрекет тоқтатылды. Қандай деректерді өзгерту керек?", "Действие отменено. Қандай деректерді өзгерту керек?"); return output;
    }
    await identifyAndFill(input, state, scenario);
    if (scenario.requires_identification && !state.clientId) {
      state.lastQuestionSlot = "phone"; output.reply = text("Назовите телефон, ИИН, номер полиса или заявления для поиска клиента.", "Клиентті табу үшін телефон, ЖСН, полис немесе өтініш нөмірін айтыңыз.", "Клиентті табу үшін назовите телефон, ЖСН, номер полиса или заявления."); return output;
    }
    const required = [...scenario.slots.required];
    if (targetId === "SC02") required.push("region", "vehicle_type");
    if (targetId === "SC06") required.push("phone");
    if (targetId === "SC26") required.push("policy_number");
    const missing = [...new Set(required)].find(key => !present(state.slots[key]));
    if (missing) {
      state.lastQuestionSlot = missing;
      const urgent = targetId === "SC11" ? text("Если есть пострадавшие, сразу звоните сто двенадцать. ", "Зардап шеккендер болса, бірден жүз он екіге қоңырау шалыңыз. ") : targetId === "SC38" ? text("Никому не сообщайте коды SMS и данные карты. ", "Ешкімге SMS кодын және карта деректерін айтпаңыз. ") : "";
      output.reply = urgent + defaultQuestion(input, state, missing); output.facts = { awaiting_slot: missing, queued_scenarios: state.pendingScenarioIds }; return output;
    }
    state.lastQuestionSlot = null;
    const pending = state.pendingConfirmation;
    const confirmed = !!pending && pending.scenarioId === targetId && decision.confirmation === "confirm" && !changedWhilePending;
    if (confirmed) {
      const saved = await store.get("operations", pending.id);
      if (saved) {
        output.actions = array(saved.actions) as unknown as ActionResult[]; output.facts = object(saved.facts);
        output.reply = string(saved.reply); output.warnings.push("Operation confirmation was already applied; returning its saved result.");
        complete(state, scenario); return output;
      }
      // The operation is executed using its persisted snapshot, never newly guessed arguments.
      state.slots = structuredClone(pending.slots);
    }
    // Preserve the reported troubleshooting failure in the reviewed snapshot so
    // the next confirmation does not accidentally re-plan a different operation.
    if (scenario.scenario_id === "SC34" && appHelpFailed(input.text)) state.slots.__app_help_failed = true;
    const plan = await planActions({ dataset, store, scenario, slots: state.slots, clientId: state.clientId, sessionId: input.sessionId, requestId: input.requestId, text: input.text, preview: !confirmed });
    const needsConfirmation = plan.writes.length > 0 || Boolean(plan.handoff);
    const signature = reviewSignature(plan);
    const changedAtExecution = confirmed && pending.slots.__review !== signature;
    output.facts = { ...plan.facts, slots: safeSlots(state.slots), queued_scenarios: state.pendingScenarioIds };
    output.warnings.push(...plan.warnings);
    if (needsConfirmation && (!confirmed || changedAtExecution)) {
      const previewPlan = { ...plan, results: plan.results.map(a => MUTATING_ACTIONS.has(a.name) ? { ...a, status: "preview" as const } : a) };
      const summary = confirmationSummary(scenario, state.slots, previewPlan, state);
      const snapshot = { ...structuredClone(state.slots), __review: signature };
      state.pendingConfirmation = { id: changedAtExecution ? randomUUID() : pending?.id ?? randomUUID(), scenarioId: targetId, actionNames: [...new Set(plan.results.filter(action => MUTATING_ACTIONS.has(action.name)).map(action => action.name))], slots: snapshot, summary, createdAt: changedAtExecution ? new Date().toISOString() : pending?.createdAt ?? new Date().toISOString() };
      output.actions = plan.results.map(a => a.status === "executed" || a.status === "queued" ? { ...a, status: "preview" } : a);
      const safety = targetId === "SC11" ? text("Если есть пострадавшие, сразу звоните сто двенадцать. ", "Зардап шеккендер болса, бірден жүз он екіге қоңырау шалыңыз. ") : targetId === "SC38" ? text("Никому не сообщайте SMS-коды, CVV и PIN. ", "Ешкімге SMS кодын, CVV және PIN айтпаңыз. ") : "";
      const office = object(plan.facts.get_offices);
      let readAnswer = targetId === "SC33" && office.address ? text(`Офис: ${office.address}, ${office.hours}. `, `Кеңсе: ${office.address}, ${office.hours}. `, undefined, `Ofis: ${office.address}, ${office.hours}. `) : "";
      if (targetId === "SC23") {
        const clinics = array(object(plan.facts.list_clinics).clinics).map(value => { const clinic = object(value); return `${clinic.name} — ${clinic.address}`; }).join("; ");
        readAnswer = text(`Клиники: ${clinics}. `, `Емханалар: ${clinics}. `, undefined, `Klinikler: ${clinics}. `);
      }
      if (targetId === "SC24") readAnswer = text("Электронная карта находится в приложении в разделе «Мои полисы». ", "Электрондық карта қосымшадағы «Менің полистерім» бөлімінде орналасқан. ");
      if (targetId === "SC34") readAnswer = `${fallbackReply(scenario, { ...plan, handoff: undefined }, state)} `;
      if (targetId === "SC18") {
        const documents: Record<string, [string, string, string]> = {
          "ID card": ["удостоверение личности", "жеке куәлік", "kimlik belgesi"], "Driving licence": ["водительское удостоверение", "жүргізуші куәлігі", "sürücü belgesi"],
          "Vehicle registration certificate": ["свидетельство о регистрации автомобиля", "көлікті тіркеу куәлігі", "araç tescil belgesi"],
          "Road accident documents from the police": ["документы полиции о ДТП", "полицияның ЖКО туралы құжаттары", "polisin trafik kazası belgeleri"], "Bank details": ["банковские реквизиты", "банк деректемелері", "banka bilgileri"],
          "Photos of the damage": ["фотографии повреждений", "зақымдардың фотосуреттері", "hasar fotoğrafları"], "Policy number": ["номер полиса", "полис нөмірі", "poliçe numarası"],
          "Police documents (if police was involved)": ["документы полиции, если она участвовала", "полиция қатысса, оның құжаттары", "polis katıldıysa polis belgeleri"],
          "Act from the building management company (for water damage) or fire service report (for fire)": ["акт управляющей компании при затоплении или пожарной службы при пожаре", "су басқанда басқарушы компания актісі немесе өрт кезінде өрт қызметінің актісі", "su hasarında bina yönetiminin tutanağı veya yangında itfaiye raporu"],
          "Medical certificate from the trauma centre or hospital": ["медицинская справка из травмпункта или больницы", "жарақат пунктінен немесе ауруханадан медициналық анықтама", "acil servis veya hastaneden sağlık raporu"],
          "Medical documents from abroad": ["медицинские документы из-за границы", "шетелдегі медициналық құжаттар", "yurt dışındaki sağlık belgeleri"],
          "Receipts (only for expenses agreed with assistance)": ["чеки только по расходам, согласованным с ассистансом", "ассистанспен келісілген шығындардың түбіртектері", "yalnızca asistansla onaylanmış masrafların makbuzları"],
        };
        const list = array(object(plan.facts.kb_lookup).documents).map(value => { const label = string(value), translated = documents[label]; return translated ? stateLanguages(state).includes("tr") ? translated[2] : text(translated[0], translated[1]) : label; }).join(", ");
        if (list) readAnswer = text(`Нужны: ${list}. `, `Қажет құжаттар: ${list}. `, undefined, `Gerekli belgeler: ${list}. `);
      }
      output.reply = `${safety}${readAnswer}${changedAtExecution ? text("Условия изменились: ", "Шарттар өзгерді: ") : ""}${summary}. ${text("Подтверждаете?", "Растайсыз ба?", "Растайсыз ба? Ответьте «да» или «нет».")}`;
      output.facts.confirmation_required = true; return output;
    }
    for (const write of plan.writes) await store.put(write.kind, write.id, write.value);
    state.clientId = plan.clientId;
    if (confirmed && targetId === "SC29" && state.slots.contact_field === "phone") {
      const clientWrite = plan.writes.find(write => write.kind === "clients" && write.id === state.clientId);
      if (clientWrite && typeof clientWrite.value.phone === "string") {
        // Update identity references only after the confirmed entity write. Keep
        // a different explicitly supplied phone and the reviewed snapshot intact.
        const previousPhone = state.slots.phone;
        state.slots.phone = clientWrite.value.phone;
        if (present(previousPhone)) for (const savedSlots of Object.values(state.slotsByScenario)) {
          if (savedSlots.phone === previousPhone) savedSlots.phone = clientWrite.value.phone;
        }
      }
    }
    output.actions = plan.results; output.reply = fallbackReply(scenario, plan, state);
    if (plan.handoff) { output.handoff = plan.handoff; state.status = "handoff"; }
    if (confirmed) await store.put("operations", pending.id, { id: pending.id, scenario_id: targetId, actions: plan.results as unknown as Json, facts: output.facts, reply: output.reply, applied_at: new Date().toISOString(), session_id: input.sessionId });
    complete(state, scenario);
    const nextId = state.pendingScenarioIds.shift() ?? state.suspendedScenarioIds.pop();
    if (nextId && state.status === "active") {
      state.activeScenarioId = nextId; state.slots = structuredClone(state.slotsByScenario[nextId] ?? {});
      if (nextId === "SC34") delete state.slots.__app_help_failed;
      const next = dataset.scenarios.find(s => s.scenario_id === nextId);
      if (next) {
        // A follow-up lookup must not replace a successfully committed operation's result.
        try { await identifyAndFill(input, state, next); }
        catch (error) { if (!(error instanceof DomainError)) throw error; if (error.slot) delete state.slots[error.slot]; }
        const question = next.slots.required.find(key => !present(state.slots[key]));
        state.lastQuestionSlot = question ?? null;
        output.reply += question ? ` ${defaultQuestion(input, state, question)}` : text(` Вернёмся к вопросу «${next.name}»?`, ` «${next.name}» сұрағына оралайық па?`, undefined, ` «${turkishScenarioName(next)}» konusuna dönelim mi?`);
        output.facts.next_scenario = nextId;
      }
    }
    return output;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    state.pendingConfirmation = null;
    output.actions.push({ name: "scenario_validation", status: "failed", data: { scenario_id: targetId }, error: { code: error.code, message: error.message } });
    output.facts = { error: { code: error.code, message: error.message }, source_context: lookupKnowledge(dataset, targetId, state.slots) };
    if (error.escalate) { const result = handoff(scenario.handoff?.queue ?? "operator_general", error.ru); result.reply = `${domainErrorText(state, error)} ${result.reply}`; return result; }
    state.lookupFailures++;
    if (state.lookupFailures >= 2 && ["not_found", "invalid_input"].includes(error.code)) {
      const result = handoff(scenario.handoff?.queue ?? "operator_general", "Repeated record lookup or slot validation failure"); return result;
    }
    if (error.slot) { delete state.slots[error.slot]; state.lastQuestionSlot = error.slot; }
    output.reply = `${domainErrorText(state, error)}${error.slot ? ` ${defaultQuestion(input, state, error.slot)}` : ""}`;
    return output;
  } finally {
    if (state.activeScenarioId) state.slotsByScenario[state.activeScenarioId] = structuredClone(state.slots);
  }
}
