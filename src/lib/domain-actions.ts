import { randomUUID } from "node:crypto";
import type { ActionResult, Dataset, EntityStore, Json, JsonObject, Scenario } from "./types";
import { addDays, addMonths, array, calculatePrice, DomainError, lookupKnowledge, mask, object, policyStatus, productForScenario, regionFromPlate, requireActive, string } from "./domain-data";

export type ActionContext = { dataset: Dataset; store: EntityStore; scenario: Scenario; slots: JsonObject; clientId: string | null; sessionId: string; requestId: string; preview: boolean };
export type ActionPlan = { results: ActionResult[]; writes: { kind: string; id: string; value: JsonObject }[]; facts: JsonObject; clientId: string | null; handoff?: { queue: string; reason: string }; warnings: string[] };

const prefixes: Record<string, string> = { ogpo: "OGPO", casco: "CASCO", travel: "TRVL", property: "PROP", accident: "NS", dms: "DMS" };
const statusNames: Record<string, string> = { active: "действует", expired: "срок истёк", not_yet_active: "ещё не вступил в силу", cancelled: "расторгнут", pending_payment: "ожидает оплаты", paid: "выплата произведена", approved: "выплата одобрена", documents_requested: "ожидаются документы", under_review: "на рассмотрении", registered: "зарегистрирован" };
export const statusLabel = (status: Json | undefined): string => statusNames[string(status)] ?? string(status);

export async function planActions(context: ActionContext): Promise<ActionPlan> {
  const { dataset, scenario, sessionId, requestId, preview } = context;
  const slots = { ...context.slots }, writes: ActionPlan["writes"] = [], results: ActionResult[] = [], warnings: string[] = [];
  let clientId = context.clientId;
  let handoff: ActionPlan["handoff"];
  const facts: JsonObject = { scenario_id: scenario.scenario_id, business_date: dataset.businessDate };
  const get = async (kind: string, id: string) => writes.findLast(v => v.kind === kind && v.id === id)?.value ?? await context.store.get(kind, id);
  const list = async (kind: string): Promise<JsonObject[]> => {
    const idKey = ({ clients: "client_id", policies: "policy_number", claims: "claim_number", payments: "payment_id" } as Record<string, string>)[kind] ?? "id";
    const values = new Map((await context.store.list(kind)).map(v => [string(v[idKey]), v]));
    for (const w of writes.filter(v => v.kind === kind)) values.set(w.id, w.value);
    return [...values.values()];
  };
  const stage = (kind: string, id: string, value: JsonObject) => { writes.push({ kind, id, value }); };
  const record = (name: string, data: JsonObject, status: ActionResult["status"] = "read") => { results.push({ name, status, data }); facts[name] = data; };
  const createdAt = new Date().toISOString();
  const unique = async (kind: string, prefix: string) => {
    for (let i = 0; i < 10; i++) { const id = `${prefix}${(parseInt(randomUUID().replace(/-/g, "").slice(0, 12), 16) % 900000) + 100000}`; if (!await get(kind, id)) return id; }
    throw new DomainError("service_unavailable", "Не удалось создать уникальный номер. Передам специалисту.", "Бірегей нөмір жасау мүмкін болмады. Маманға беремін.", undefined, true);
  };
  const notFound = (slot?: string): never => { throw new DomainError("not_found", "По указанным данным запись не найдена.", "Көрсетілген деректер бойынша жазба табылмады.", slot); };
  const own = (record: JsonObject): void => {
    if (!clientId || record.client_id !== clientId) throw new DomainError("not_found", "Эта запись недоступна для идентифицированного клиента.", "Бұл жазба сәйкестендірілген клиентке қолжетімсіз.", record.claim_number ? "claim_number" : "policy_number");
  };
  const policy = async (allowCulprit = false): Promise<JsonObject> => {
    let p = slots.policy_number ? await get("policies", string(slots.policy_number)) : null;
    if (allowCulprit) p = (await list("policies")).find(p => p.product === "ogpo" && object(p.details).vehicle_plate === slots.culprit_vehicle_plate) ?? null;
    if (!p) return notFound(allowCulprit ? "culprit_vehicle_plate" : "policy_number");
    if (!allowCulprit) own(p);
    const expected = productForScenario(scenario.scenario_id);
    if (expected && p.product !== expected) throw new DomainError("invalid_input", "Этот полис относится к другой программе страхования.", "Бұл полис басқа сақтандыру бағдарламасына жатады.", "policy_number");
    return p;
  };
  const claim = async (): Promise<JsonObject> => {
    const c = slots.claim_number ? await get("claims", string(slots.claim_number)) : (await list("claims")).find(c => c.client_id === clientId) ?? null;
    if (!c) return notFound("claim_number"); own(c); return c;
  };
  const client = async (): Promise<JsonObject> => {
    const c = clientId ? await get("clients", clientId) : null; if (!c) return notFound("phone"); return c;
  };
  const ensureSalesClient = async (): Promise<JsonObject> => {
    if (clientId) return client();
    const found = (await list("clients")).find(c => c.phone === slots.phone);
    if (found) { clientId = string(found.client_id); return found; }
    const id = `C-${randomUUID()}`;
    const c: JsonObject = { client_id: id, phone: slots.phone ?? null, preferred_language: "ru", source: "customer_request", created_at: createdAt };
    stage("clients", id, c); clientId = id; return c;
  };
  const outbox = (channel: string, recipient: Json, payload: JsonObject) => {
    const id = randomUUID(); stage("outbox", id, { id, channel, recipient, payload, status: "queued", delivery_status: "provider_not_configured", session_id: sessionId, request_id: requestId, created_at: createdAt });
    return { outbox_id: id, status: "queued", delivery_status: "provider_not_configured", recipient: mask(string(recipient)) };
  };
  const request = (kind: string, payload: JsonObject, prefix = "R-") => {
    const id = `${prefix}${randomUUID()}`;
    stage(kind, id, { id, ...payload, client_id: clientId, session_id: sessionId, request_id: requestId, created_at: createdAt }); return id;
  };
  const cover = async (p: JsonObject, service: string): Promise<JsonObject> => {
    requireActive(p, dataset.businessDate);
    if (p.product !== "dms") throw new DomainError("not_covered", "Для медицинской услуги нужен полис ДМС.", "Медициналық қызмет үшін ДМС полисі қажет.", undefined, true);
    const pkg = string(object(p.details).package), source = object(object(object(dataset.knowledge.products).dms).packages)[pkg];
    const v = service.toLowerCase();
    let covered: boolean | null = null, condition: string | null = null;
    if (/имплан|протез|cosmet|космет|амбулатор.*лекар|outpatient med/.test(v)) covered = false;
    else if (/мрт|кт\b|mri|ct\b/.test(v)) { covered = pkg === "Comfort"; condition = "MRI and CT by referral, up to 2 per year"; }
    else if (/стомат|зуб|dent|тіс/.test(v)) { covered = pkg === "Comfort"; condition = "Dental treatment (caries, extraction); prosthetics and implants excluded"; }
    else if (/анализ|lab|талдау/.test(v)) { covered = true; condition = "Lab tests require a doctor's referral; Basic covers basic tests only"; }
    else if (/узи|ultrasound|удз/.test(v)) covered = pkg === "Comfort";
    else if (/терапев|therapist/.test(v)) covered = true;
    else if (/лор|ent|кардиолог|cardiolog|гинеколог|gynecolog|педиатр|pediatric|specialist/.test(v)) { covered = true; condition = pkg === "Basic" ? "Specialists require a therapist referral" : "Specialists without referral"; }
    else if (/планов.*госпитал|planned hospital/.test(v)) covered = pkg === "Comfort";
    else if (/скорая|экстрен|emergency|жедел/.test(v)) covered = true;
    return { covered, package: pkg, service_name: service, note: condition, source: `products.dms.packages.${pkg}`, terms: source ?? null, ...(covered === null ? { requires_specialist: true } : {}) };
  };

  for (const name of scenario.actions) {
    const irreversible = dataset.actions.find(a => a.name === name)?.irreversible ?? false;
    const changeStatus: ActionResult["status"] = preview && irreversible ? "preview" : "executed";
    switch (name) {
      case "find_client": {
        const c = await client(); record(name, { client_id: c.client_id, identified: true }); break;
      }
      case "get_policies": {
        const ps = (await list("policies")).filter(p => p.client_id === clientId);
        if (!ps.length) notFound("policy_number");
        record(name, { policies: ps.map(p => ({ policy_number: p.policy_number, product: p.product, status: policyStatus(p, dataset.businessDate), end_date: p.end_date })) }); break;
      }
      case "get_policy": {
        const p = await policy(scenario.scenario_id === "SC12"); slots.policy_number = p.policy_number;
        const data: JsonObject = { policy_number: p.policy_number, product: p.product, status: policyStatus(p, dataset.businessDate), start_date: p.start_date, end_date: p.end_date };
        if (scenario.scenario_id !== "SC12") data.premium = p.premium ?? null;
        record(name, data); break;
      }
      case "get_bm_class": {
        const iins = slots.new_driver_iin ? [slots.new_driver_iin] : array(slots.drivers_iin).length ? array(slots.drivers_iin) : [slots.iin];
        const clients = await list("clients");
        const classes = iins.filter(Boolean).map(iin => ({ iin_masked: mask(string(iin)), bm_class: clients.find(c => c.iin === iin)?.bm_class ?? object(dataset.backend.defaults).unknown_iin_bm_class ?? "3" }));
        record(name, { classes, ...(classes.length === 1 ? { bm_class: classes[0].bm_class } : {}) }); break;
      }
      case "calc_ogpo_price": case "calc_casco_price": case "calc_travel_price": case "calc_property_price": case "calc_accident_price": {
        const product = name.replace(/^calc_/, "").replace(/_price$/, ""); const quote = calculatePrice(dataset, product, slots, await list("clients"));
        Object.assign(slots, quote); record(name, quote); break;
      }
      case "create_policy": {
        await ensureSalesClient(); const product = string(slots.product_type ?? productForScenario(scenario.scenario_id));
        const quote = calculatePrice(dataset, product, slots, await list("clients"));
        const number = await unique("policies", `SQ-${prefixes[product]}-`), start = product === "travel" ? string(slots.trip_start) : dataset.businessDate;
        const end = product === "travel" ? string(slots.trip_end) : addDays(addMonths(start, Number(slots.term_months ?? 12)), -1);
        const details: JsonObject = {};
        for (const key of ["vehicle_plate", "drivers_iin", "vehicle_type", "region", "trip_country", "travelers_count", "traveler_max_age", "trip_start", "trip_end", "term_months"]) if (slots[key] !== undefined) details[key] = slots[key];
        stage("policies", number, { policy_number: number, client_id: clientId, product, start_date: start, end_date: end, premium: quote.price, details, status: "pending_payment", created_at: createdAt, origin_session: sessionId });
        slots.policy_number = number;
        record(name, { policy_number: number, price: quote.price, status: "pending_payment", payment_link: null, note: "Policy request persisted; payment provider is not connected. Coverage is not activated." }, changeStatus); break;
      }
      case "renew_policy": {
        const p = await policy();
        if (["cancelled", "pending_payment"].includes(policyStatus(p, dataset.businessDate))) throw new DomainError("not_eligible", "Этот полис нельзя продлить автоматически.", "Бұл полисті автоматты түрде ұзарту мүмкін емес.", undefined, true);
        const oldDetails = object(p.details), product = string(p.product), renewalSlots = { ...oldDetails, ...slots };
        if (product === "ogpo") renewalSlots.region = regionFromPlate(dataset, string(oldDetails.vehicle_plate));
        if (!["ogpo", "casco", "property", "accident"].includes(product)) throw new DomainError("not_eligible", "Для продления этого продукта нужны новые условия; передам специалисту.", "Бұл өнімді ұзарту үшін жаңа шарттар қажет; маманға беремін.", undefined, true);
        const start = string(p.end_date) >= dataset.businessDate ? addDays(string(p.end_date), 1) : dataset.businessDate;
        const quote = calculatePrice({ ...dataset, businessDate: start }, product, renewalSlots, await list("clients"));
        const number = await unique("policies", `SQ-${prefixes[product]}-`);
        stage("policies", number, { ...p, policy_number: number, start_date: start, end_date: addDays(addMonths(start, Number(oldDetails.term_months ?? 12)), -1), premium: quote.price, status: "pending_payment", renewed_from: p.policy_number, created_at: createdAt });
        record(name, { policy_number: number, price: quote.price, previous_policy_number: p.policy_number, status: "pending_payment", payment_link: null }, changeStatus); slots.policy_number = number; break;
      }
      case "update_policy": {
        const p = await policy(); requireActive(p, dataset.businessDate); const details = { ...object(p.details) };
        if (!["ogpo", "casco"].includes(string(p.product))) throw new DomainError("not_eligible", "Изменение водителя или автомобиля доступно только для автополиса.", "Жүргізушіні немесе көлікті өзгерту тек автополис үшін қолжетімді.", undefined, true);
        if (scenario.scenario_id === "SC04") {
          if (array(details.drivers_iin).includes(slots.new_driver_iin)) throw new DomainError("already_done", "Этот водитель уже включён в полис.", "Бұл жүргізуші полиске енгізілген.");
          details.drivers_iin = [...array(details.drivers_iin), slots.new_driver_iin];
        } else details.vehicle_plate = slots.vehicle_plate;
        let extra: Json = null;
        // No proration formula is supplied. A full annual quote is useful but is not a claimed payable premium.
        let annual: Json = null;
        if (p.product === "ogpo") { annual = calculatePrice(dataset, "ogpo", { ...details, region: regionFromPlate(dataset, string(details.vehicle_plate)) }, await list("clients")).price; if (annual === p.premium) extra = 0; }
        stage("policies", string(p.policy_number), { ...p, details, updated_at: createdAt, adjustment_status: extra === 0 ? "no_adjustment" : "review_required" });
        record(name, { policy_number: p.policy_number, extra_premium: extra, annual_quote: annual, adjustment_status: extra === 0 ? "no_adjustment" : "review_required", changed_field: scenario.scenario_id === "SC04" ? "drivers_iin" : "vehicle_plate" }, changeStatus);
        if (extra === null) warnings.push("No prorated adjustment formula exists in the supplied rules; amount requires specialist review."); break;
      }
      case "cancel_policy": {
        const p = await policy();
        if (p.status === "cancelled") throw new DomainError("already_done", "Этот полис уже расторгнут.", "Бұл полис бұрын бұзылған.");
        requireActive(p, dataset.businessDate);
        const hasPaidClaim = (await list("claims")).some(c => c.policy_number === p.policy_number && c.status === "paid");
        if (typeof p.premium !== "number") throw new DomainError("not_eligible", "В данных нет оплаченной премии для расчёта возврата.", "Қайтарымды есептеу үшін төленген сыйлықақы деректері жоқ.", undefined, true);
        const exclusiveEnd = addDays(string(p.end_date), 1); let months = 0;
        while (months < 120 && addMonths(dataset.businessDate, months + 1) <= exclusiveEnd) months++;
        const refund = hasPaidClaim ? 0 : Math.round(p.premium * months / 12 * 0.9);
        stage("policies", string(p.policy_number), { ...p, status: "cancelled", cancelled_at: dataset.businessDate, cancel_reason: slots.cancel_reason, refund_amount: refund, refund_status: hasPaidClaim ? "not_payable" : "pending_review" });
        record(name, { policy_number: p.policy_number, refund_amount: refund, unused_full_months: months, refund_status: hasPaidClaim ? "not_payable" : "pending_review", refund_reason: hasPaidClaim ? "No refund if a claim was paid under the policy" : "Unused full months minus ten percent administrative expenses", refund_time_rule: object(dataset.knowledge.cancellation).refund_time ?? null }, changeStatus); break;
      }
      case "create_claim": {
        const isVictim = scenario.scenario_id === "SC12", p = await policy(isVictim);
        const date = string(slots.incident_date);
        if (date > dataset.businessDate) throw new DomainError("invalid_input", "Дата происшествия не может быть в будущем.", "Оқиға күні болашақта болмауы керек.", "incident_date");
        requireActive(p, date); if (isVictim) await ensureSalesClient();
        const number = await unique("claims", "CL-");
        const value: JsonObject = { claim_number: number, client_id: clientId, policy_number: p.policy_number, claim_type: isVictim ? "ogpo_victim" : p.product, incident_date: date, incident_description: slots.incident_description, status: "registered", next_step: "Submit supporting documents for review", created_at: createdAt };
        stage("claims", number, value); slots.claim_number = number;
        record(name, { claim_number: number, status: "registered", documents: object(object(dataset.knowledge.claims).documents)[string(value.claim_type)] ?? null, submission: object(dataset.knowledge.claims).submission ?? null }, changeStatus); break;
      }
      case "get_claim": {
        const c = await claim(); slots.claim_number = c.claim_number;
        const data: JsonObject = {};
        for (const key of ["claim_number", "status", "next_step", "approved_amount", "assessor_estimate", "missing_documents", "decision_due", "decision_date", "claim_type"]) if (c[key] !== undefined) data[key] = c[key];
        record(name, data); break;
      }
      case "create_dispute": {
        const c = await claim(); const id = request("disputes", { claim_number: c.claim_number, complaint_text: slots.complaint_text, status: "registered" }, "D-");
        record(name, { ticket_id: id, status: "registered", review_rule: object(dataset.knowledge.claims).dispute ?? null }, changeStatus); break;
      }
      case "book_inspection": case "book_appointment": {
        if (string(slots.preferred_date) < dataset.businessDate) throw new DomainError("invalid_input", "Выберите сегодняшнюю или будущую дату.", "Бүгінгі немесе болашақ күнді таңдаңыз.", "preferred_date");
        let data: JsonObject;
        if (name === "book_inspection") {
          const c = await claim(); const point = array(dataset.knowledge.inspection_points).map(object).find(p => p.city === slots.city) ?? array(dataset.knowledge.inspection_points).map(object).find(p => p.city === "other");
          data = { claim_number: c.claim_number, city: slots.city, requested_date: slots.preferred_date, address: point?.address ?? null };
        } else {
          const p = await policy(), coverage = await cover(p, string(slots.doctor_specialty));
          if (coverage.covered === false) throw new DomainError("not_covered", "Эта медицинская услуга не входит в программу полиса.", "Бұл медициналық қызмет полис бағдарламасына кірмейді.", undefined, true);
          const clinics = array(dataset.knowledge.clinics).map(object).filter(c => c.city === slots.city && array(c.specialties).some(s => string(s).toLowerCase() === string(slots.doctor_specialty).toLowerCase()));
          if (!clinics.length) throw new DomainError("no_availability", "В каталоге нет подходящей клиники в этом городе; передам запрос специалисту.", "Каталогта бұл қалада сәйкес емхана жоқ; сұранысты маманға беремін.", undefined, true);
          data = { policy_number: p.policy_number, city: slots.city, doctor_specialty: slots.doctor_specialty, requested_date: slots.preferred_date, clinics: clinics.map(c => c.name), coverage };
        }
        const id = request(name === "book_appointment" ? "appointments" : "inspections", { ...data, status: "request_pending" });
        record(name, { ...data, request_id: id, status: "request_pending", slot_datetime: null, note: "Request persisted. There is no connected scheduling inventory; time is not confirmed." }, preview ? "preview" : "queued");
        warnings.push("Booking request is saved; actual appointment time needs an operator with scheduling access."); break;
      }
      case "check_coverage": { const data = await cover(await policy(), string(slots.service_name)); record(name, data); if (data.covered === null) warnings.push("Exact medical service cannot be determined from the available package terms."); break; }
      case "list_clinics": {
        const clinics = array(dataset.knowledge.clinics).map(object).filter(c => c.city === slots.city);
        if (!clinics.length) notFound("city"); record(name, { clinics, source: "clinics" }); break;
      }
      case "resend_documents": case "request_document": {
        const p = await policy(); const c = await client();
        if (name === "resend_documents") requireActive(p, dataset.businessDate);
        const recipient = slots.email ?? c.email ?? c.phone;
        if (!recipient) notFound("email");
        const queued = outbox(string(recipient).includes("@") ? "email" : "sms", recipient, { policy_number: p.policy_number, document_type: slots.document_type ?? "policy_duplicate" });
        record(name, { ...queued, sent_to: null, destination_masked: mask(string(recipient)), note: "Delivery requested; no delivery provider is connected." }, "queued"); break;
      }
      case "check_payment": {
        const p = (await list("payments")).find(p => p.client_id === clientId && p.date === slots.payment_date && (!slots.payment_amount || p.amount === slots.payment_amount));
        if (!p) return notFound("payment_date"); record(name, { payment_id: p.payment_id, payment_status: p.status, amount: p.amount, policy_number: p.policy_number ?? null }); break;
      }
      case "update_contact": {
        const c = await client(), field = string(slots.contact_field);
        if (!["phone", "email", "address"].includes(field)) throw new DomainError("invalid_input", "Можно изменить телефон, почту или адрес.", "Телефонды, поштаны немесе мекенжайды өзгертуге болады.", "contact_field");
        if (field === "phone" && (await list("clients")).some(other => other.client_id !== clientId && other.phone === slots.new_value)) throw new DomainError("invalid_input", "Этот номер уже связан с другим профилем.", "Бұл нөмір басқа профильмен байланысты.", "new_value");
        stage("clients", string(c.client_id), { ...c, [field]: slots.new_value, updated_at: createdAt });
        record(name, { contact_field: field, value_masked: mask(string(slots.new_value)), status: "updated" }, changeStatus); break;
      }
      case "get_offices": {
        const office = array(dataset.knowledge.offices).map(object).find(o => o.city === slots.city); if (!office) notFound("city"); record(name, { ...office, source: "offices" }); break;
      }
      case "kb_lookup": { record(name, lookupKnowledge(dataset, scenario.scenario_id, slots)); break; }
      case "send_sms": {
        const c = clientId ? await get("clients", clientId) : null, recipient = slots.phone ?? c?.phone;
        if (!recipient) { warnings.push("SMS was not queued because no phone was supplied."); break; }
        record(name, outbox("sms", recipient, { scenario_id: scenario.scenario_id, policy_number: slots.policy_number ?? null, claim_number: slots.claim_number ?? null }), "queued"); break;
      }
      case "create_callback": {
        const id = request("callbacks", { phone: slots.phone, requested_time: slots.callback_time, status: "waiting" });
        record(name, { request_id: id, callback_time: slots.callback_time, status: "waiting", note: "Callback request queued; time is requested, not confirmed." }, "queued"); break;
      }
      case "create_complaint": {
        const id = request("complaints", { complaint_text: slots.complaint_text, phone: slots.phone ?? null, status: "registered" }, "T-");
        record(name, { ticket_id: id, status: "registered", review_rule: object(dataset.knowledge.complaints).review_time ?? null }, "executed"); break;
      }
      case "report_fraud": {
        const id = request("fraud", { fraud_details: slots.fraud_details, phone: slots.phone ?? null, status: "registered" }, "F-");
        record(name, { ticket_id: id, status: "registered", advice: dataset.knowledge.fraud_policy ?? null }, "executed"); break;
      }
      case "transfer_to_operator": {
        const allText = `${string(slots.incident_description)} ${string(slots.fraud_details)} ${string(slots.topic)} ${string(slots.complaint_text)}`.toLowerCase();
        const id = scenario.scenario_id;
        const should = ["SC10", "SC15", "SC37"].includes(id)
          || (id === "SC11" && slots.injured === true)
          || (id === "SC13" && /угон|украл|theft|total.loss|тотал|ұрла/.test(allText))
          || (id === "SC14" && /пострада|injur|зардап|жарақат/.test(allText))
          || (id === "SC30" && object(facts.check_payment).payment_status === "charged_policy_not_issued")
          || (id === "SC38" && /сообщил|передал|назвал.*код|shared|айттым|жібердім/.test(allText))
          || (id === "SC34" && /не помог|still|көмектесп/.test(allText));
        if (should) { handoff = { queue: scenario.handoff?.queue ?? "operator_general", reason: scenario.name }; record(name, { queue: handoff.queue, status: "waiting", note: "Request queued for an authenticated supervisor; live telephony transfer is not connected." }, "queued"); }
        break;
      }
      default: throw new DomainError("service_unavailable", "Действие отсутствует в исполнительном модуле.", "Орындау модулінде әрекет жоқ.", undefined, true);
    }
  }
  return { results, writes, facts, clientId, handoff, warnings };
}
