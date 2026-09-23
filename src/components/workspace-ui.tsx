import { AlertCircle, ArrowUpRight, AudioLines, LoaderCircle } from "lucide-react";
import type { Handoff, Role, Scenario, Session } from "@/lib/types";

export type WorkspaceView = "conversation" | "history" | "catalog" | "operators";
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

export function languageLabel(language?: string) {
  return language === "kk" ? "Қазақша" : language === "mixed" ? "RU + KZ" : "Русский";
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
