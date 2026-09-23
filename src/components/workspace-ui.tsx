import { AlertCircle, ArrowUpRight, AudioLines, LoaderCircle } from "lucide-react";
import type { Handoff, Role, Scenario, Session } from "@/lib/types";
import { normalizeLanguageCode } from "@/lib/languages";

export type WorkspaceView = "conversation" | "history" | "catalog" | "operators" | "supervision";

// Presentation labels only: source identifiers and router input remain unchanged.
const scenarioLabels: Record<string, string> = {
  SC01: "Расчёт стоимости ОГПО",
  SC02: "Оформление ОГПО",
  SC03: "Консультация и расчёт КАСКО",
  SC04: "Добавление водителя в полис",
  SC05: "Изменение автомобиля или госномера",
  SC06: "Страхование путешествий",
  SC07: "Страхование жилья",
  SC08: "Страхование от несчастных случаев",
  SC09: "Индивидуальное медицинское страхование",
  SC10: "Корпоративное страхование",
  SC11: "Помощь сразу после ДТП",
  SC12: "Возмещение по ОГПО виновника ДТП",
  SC13: "Страховой случай по КАСКО",
  SC14: "Повреждение имущества",
  SC15: "Медицинская помощь за рубежом",
  SC16: "Травма при несчастном случае",
  SC17: "Статус страхового случая",
  SC18: "Документы по страховому случаю",
  SC19: "Несогласие с решением по выплате",
  SC20: "Запись на осмотр автомобиля",
  SC21: "Запись к врачу по ДМС",
  SC22: "Проверка покрытия по ДМС",
  SC23: "Клиники-партнёры",
  SC24: "Проблема с электронной картой ДМС",
  SC25: "Проверка действия полиса",
  SC26: "Повторная отправка полиса",
  SC27: "Продление полиса",
  SC28: "Расторжение полиса и возврат",
  SC29: "Изменение контактных данных",
  SC30: "Оплата списана, полис не выдан",
  SC31: "Способы оплаты и рассрочка",
  SC32: "Бонус-малус и изменение стоимости",
  SC33: "Адреса и часы работы офисов",
  SC34: "Помощь с приложением и кабинетом",
  SC35: "Жалоба на обслуживание",
  SC36: "Обратный звонок",
  SC37: "Соединение с оператором",
  SC38: "Подозрительный звонок или мошенничество",
  SC39: "Справка или копия документа",
  SC40: "Разъяснение условий полиса",
  SYS_OUT_OF_SCOPE: "Вопрос вне страховых услуг",
  SYS_UNCLEAR: "Уточнение обращения",
  SYS_GOODBYE: "Завершение разговора",
};

const domainLabels: Record<string, string> = { auto: "Авто", travel: "Путешествия", property: "Имущество", accident: "Несчастные случаи", health: "Здоровье", corporate: "Бизнес", general: "Общие вопросы" };
const categoryLabels: Record<string, string> = { sales: "Оформление и консультации", servicing: "Обслуживание", claims: "Страховые случаи", info: "Информация", feedback: "Обратная связь", contact: "Связь", security: "Безопасность" };

const sourceNames: Record<string, string> = {
  SC01: "OGPO price quote", SC02: "OGPO purchase", SC03: "CASCO consultation and quote", SC04: "Add driver to motor policy", SC05: "Change vehicle or plate in policy", SC06: "Travel insurance purchase", SC07: "Home insurance consultation", SC08: "Accident insurance consultation", SC09: "Individual health insurance consultation", SC10: "Corporate insurance request", SC11: "Road accident just happened", SC12: "Claim as victim under culprit's OGPO", SC13: "CASCO damage claim", SC14: "Property damage claim", SC15: "Medical event abroad", SC16: "Accident injury claim", SC17: "Claim status", SC18: "Documents for a claim", SC19: "Disagreement with claim decision", SC20: "Book vehicle inspection", SC21: "Doctor appointment under DMS", SC22: "DMS coverage check", SC23: "Partner clinics list", SC24: "DMS e-card issue", SC25: "Check policy validity", SC26: "Resend policy documents", SC27: "Policy renewal", SC28: "Policy termination and refund", SC29: "Update contact details", SC30: "Charged but policy not issued", SC31: "Payment methods and installments", SC32: "Bonus-malus class and price change", SC33: "Office addresses and hours", SC34: "Mobile app and account help", SC35: "Service complaint", SC36: "Callback request", SC37: "Request a human operator", SC38: "Suspicious call or fraud report", SC39: "Certificate or document copy request", SC40: "Policy terms explanation",
};
export function scenarioDisplayName(id: string, originalName?: string) {
  if (originalName && originalName !== sourceNames[id]) return originalName;
  return scenarioLabels[id] ?? originalName ?? id;
}
export function domainDisplayName(domain: string) { return domainLabels[domain] ?? domain; }
export function categoryDisplayName(category: string) { return categoryLabels[category] ?? category; }
export type Bootstrap = {
  viewer: { role: Role };
  stats: { sessions: number; turns: number; handoffs: number; medianRoutingMs: number | null };
  catalog: Scenario[];
  sessions: Session[];
  handoffs: Handoff[];
  businessDate: string;
  configured: { database: boolean; ai: boolean };
  datasetHash: string;
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message;
    throw new ApiError(message || (response.status === 401 ? "Войдите снова, чтобы продолжить." : `Не удалось выполнить запрос (${response.status}). Попробуйте ещё раз.`), response.status);
  }
  if (data === null) throw new ApiError("Сервис вернул некорректный ответ. Обновите данные или попробуйте ещё раз.", 502);
  return data as T;
}

export function readableError(error: unknown) {
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "Нет соединения с сервером. Проверьте интернет и попробуйте ещё раз. Сохранённые разговоры остаются в истории.";
  return error instanceof Error ? error.message : "Не удалось выполнить действие. Попробуйте ещё раз.";
}

export function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function duration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(2)} с`;
}

export function languageLabel(language?: string, languages?: readonly string[]) {
  const sources = languages !== undefined ? languages : language === "mixed" ? ["ru", "kk"] : language ? [language] : [];
  const codes = [...new Set(sources.map(normalizeLanguageCode).filter((value): value is string => value !== null))];
  if (!codes.length) return "Не определён";
  let names: Intl.DisplayNames | undefined;
  try { names = new Intl.DisplayNames(["ru"], { type: "language", fallback: "code" }); } catch { /* Keep the validated code on older browsers. */ }
  return codes.map(code => {
    let name = code;
    try { name = names?.of(code) ?? code; } catch { /* A code is still a truthful label. */ }
    return name === code ? code : `${name.charAt(0).toLocaleUpperCase("ru")}${name.slice(1)} (${code})`;
  }).join(" + ");
}

export function sessionStatus(status: string) {
  return status === "handoff" ? "У оператора" : status === "closed" ? "Завершён" : "В работе";
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? "brand-compact" : ""}`}>
    <span className="brand-symbol" aria-hidden="true"><AudioLines size={25} strokeWidth={1.7} /></span>
    {!compact && <span className="brand-wordmark">DIR ECHOES<span>VOICE ROUTER</span></span>}
  </div>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner-label"><LoaderCircle size={16} className="spin" aria-hidden="true" />{label}</span>;
}

export function ErrorNotice({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return <div className="error-notice" role="alert"><AlertCircle size={17} /><span>{message}</span>{onDismiss && <button onClick={onDismiss} aria-label="Скрыть сообщение об ошибке">×</button>}</div>;
}

export function EmptyState({ title, description, icon, action }: { title: string; description: string; icon: React.ReactNode; action?: { label: string; onClick: () => void } }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action && <button className="button button-secondary" onClick={action.onClick}>{action.label}<ArrowUpRight size={15} /></button>}</div>;
}
