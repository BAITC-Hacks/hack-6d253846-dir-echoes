"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ClipboardCheck, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import type { Scenario, Turn } from "@/lib/types";
import { api, ApiError, dateTime, duration, EmptyState, ErrorNotice, readableError, scenarioDisplayName, Spinner } from "./workspace-ui";
import styles from "./supervisor-tools.module.css";

type Review = { id: string; turnId: string; sessionId: string | null; expectedScenario: string; actualScenario: string | null; matchesPrimary: boolean; note: string; userText: string; createdAt: string };
type Revision = { id: string; hash: string; parentHash: string; scenarioId: string; fields: string[]; createdAt: string };
type Supervision = {
  stats: { llmTurns: number; storedFailedTurns: number; validationFailedTurns: number; reviewedTurns: number; matchedPrimary: number; correctedPrimary: number; primaryAgreementRate: number | null; reviewCoverageRate: number | null };
  errorCodes: { code: string; count: number }[]; reviews: Review[]; revisions: Revision[]; currentCatalogHash: string; methodology: string;
  latencyBySource: { source: "llm" | "slot" | "confirmation"; count: number; p50ServerMs: number | null; p95ServerMs: number | null; p50RoutingMs: number | null; p95RoutingMs: number | null }[];
};
const systemIds = ["SYS_OUT_OF_SCOPE", "SYS_UNCLEAR", "SYS_GOODBYE"];
const fieldNames: Record<string, string> = { name: "название", description: "описание", examples: "примеры", not_this_if: "исключения" };
const percentage = (value: number | null) => value == null ? "—" : `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
const scenarioName = (catalog: Scenario[], id: string | null) => id ? scenarioDisplayName(id, catalog.find(s => s.scenario_id === id)?.name) : "Не определён";

export function SupervisorDashboard({ catalog, onOpen }: { catalog: Scenario[]; onOpen: (sessionId: string) => void }) {
  const [data, setData] = useState<Supervision | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try { const result = await api<Supervision>("/api/supervision"); if (alive.current) setData(result); }
    catch (err) { if (alive.current) setError(readableError(err)); }
    finally { if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);
  return <section className={`collection-page ${styles.dashboard}`}>
    <div className="collection-toolbar"><div><h2 className={styles.title}>Контроль качества</h2><p className={styles.hint}>Сохранённые ошибки, ручная проверка решений и изменения каталога.</p></div><button className="button button-secondary button-small" onClick={() => void refresh()} disabled={busy}>{busy ? <Spinner /> : <RefreshCw size={15} />}Обновить</button></div>
    {error && <ErrorNotice message={error} />}
    {!data ? busy ? <div className={styles.loading}><Spinner label="Загружаем статистику…" /></div> : <EmptyState title="Статистика недоступна" description="Повторите загрузку, чтобы получить сохранённые данные." icon={<ClipboardCheck size={26} />} action={{ label: "Повторить", onClick: () => void refresh() }} /> : <div className={styles.content}>
      <div className={styles.metrics}>
        <Metric label="Решений LLM" value={data.stats.llmTurns} detail="Завершённые реплики" />
        <Metric label="Проверено вручную" value={data.stats.reviewedTurns} detail={`${percentage(data.stats.reviewCoverageRate)} от решений LLM`} />
        <Metric label="Согласие с супервизором" value={percentage(data.stats.primaryAgreementRate)} detail="На проверенных основных маршрутах" />
        <Metric label="Исправленных маршрутов" value={data.stats.correctedPrimary} detail="Основной сценарий выбран неверно" />
      </div>
      <p className={styles.methodology}>{data.methodology}</p>
      <section className={styles.section}><h3>Время обработки по типу реплики</h3><p className={styles.hint}>Из сохранённых измерений завершённых реплик. p50 — медиана, p95 — 95-й перцентиль. Серверное время не включает распознавание, синтез речи и сеть до пользователя; при малом числе реплик перцентили не характеризуют стабильную задержку.</p>{data.latencyBySource.length ? <div className={styles.tableScroll}><table className={styles.latencyTable}><thead><tr><th>Обработка</th><th>Реплик</th><th>Сервер p50 / p95</th><th>Маршрут p50 / p95</th></tr></thead><tbody>{data.latencyBySource.map(row => <tr key={row.source}><td>{{ llm: "Выбор сценария LLM", slot: "Заполнение параметра", confirmation: "Подтверждение операции" }[row.source]}</td><td>{row.count}</td><td>{duration(row.p50ServerMs)} / {duration(row.p95ServerMs)}</td><td>{duration(row.p50RoutingMs)} / {duration(row.p95RoutingMs)}</td></tr>)}</tbody></table></div> : <p className={styles.hint}>Завершённых реплик с измерениями пока нет.</p>}</section>
      <div className={styles.columns}>
        <section className={styles.section}><h3>Ошибки исполнения</h3><dl className="slot-list"><div><dt>Реплики со статусом «Ошибка»</dt><dd>{data.stats.storedFailedTurns}</dd></div><div><dt>Реплики с отказом бизнес-действия</dt><dd>{data.stats.validationFailedTurns}</dd></div></dl><p className={styles.hint}>Отказ может означать корректную проверку данных, например неподходящий полис. Это не оценка ошибки модели.</p>{data.errorCodes.length ? <ul className={styles.errorList}>{data.errorCodes.map(item => <li key={item.code}><code>{item.code}</code><strong>{item.count}</strong></li>)}</ul> : <p className={styles.hint}>Сохранённых отказов бизнес-действий нет.</p>}</section>
        <section className={styles.section}><h3>Версии каталога</h3><p className={styles.hint}>Текущая версия: <code>{data.currentCatalogHash.slice(0, 12)}</code></p>{data.revisions.length ? <ul className={styles.revisionList}>{data.revisions.map(revision => <li key={revision.id}><div><strong>{scenarioName(catalog, revision.scenarioId)}</strong><time>{dateTime(revision.createdAt)}</time></div><p>{revision.fields.map(field => fieldNames[field] ?? field).join(", ")} · <code>{revision.hash.slice(0, 12)}</code></p></li>)}</ul> : <p className={styles.hint}>Каталог ещё не редактировали. Используется исходная версия.</p>}</section>
      </div>
      <section className={styles.section}><div className={styles.sectionHeading}><h3>Последние ручные оценки</h3><span className={styles.hint}>До 50 записей</span></div>{!data.reviews.length ? <div className={styles.noReviews}><ClipboardCheck size={24} /><p>Откройте разговор, выберите реплику в панели маршрутизации и укажите ожидаемый основной сценарий.</p></div> : <div className={styles.reviews}>{data.reviews.map(review => <article key={review.id} className={styles.review}><div className={styles.sectionHeading}><span className={review.matchesPrimary ? styles.match : styles.correction}>{review.matchesPrimary ? "Маршрут подтверждён" : "Маршрут исправлен"}</span><time>{dateTime(review.createdAt)}</time></div><p className={styles.utterance}>{review.userText}</p><dl className="slot-list"><div><dt>Выбран маршрутизатором</dt><dd>{scenarioName(catalog, review.actualScenario)}</dd></div><div><dt>Ожидаемый основной маршрут</dt><dd>{scenarioName(catalog, review.expectedScenario)}</dd></div></dl>{review.note && <p className={styles.reviewNote}>{review.note}</p>}{review.sessionId && <button className="button button-secondary button-small" onClick={() => onOpen(review.sessionId!)}>Открыть разговор<ArrowRight size={14} /></button>}</article>)}</div>}</section>
    </div>}
  </section>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function TurnReviewEditor({ turn, catalog }: { turn: Turn; catalog: Scenario[] }) {
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Review | null>(null);
  useEffect(() => { setExpected(""); setNote(""); setError(null); setSaved(null); }, [turn.id]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || !expected) return;
    setBusy(true); setError(null); setSaved(null);
    try { const result = await api<{ review: Review }>("/api/reviews", { method: "POST", body: JSON.stringify({ turnId: turn.id, expectedScenario: expected, note }) }); setSaved(result.review); }
    catch (err) { setError(readableError(err)); } finally { setBusy(false); }
  }
  if (turn.trace.source !== "llm" || !turn.trace.scenarios.length) return null;
  return <section className={`trace-section ${styles.reviewEditor}`}><div className="trace-section-heading"><ClipboardCheck size={15} /><h3>Оценка супервизора</h3></div><p className={styles.hint}>Какой сценарий должен быть основным? Повторная отправка заменит вашу оценку этой реплики.</p><form onSubmit={submit} className={styles.form}><label>Ожидаемый сценарий<select value={expected} onChange={event => { setExpected(event.target.value); setSaved(null); }} disabled={busy} required><option value="">Выберите сценарий</option>{catalog.map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.scenario_id} · {scenarioDisplayName(s.scenario_id, s.name)}</option>)}{systemIds.map(id => <option key={id} value={id}>{scenarioDisplayName(id)}</option>)}</select></label><label>Комментарий<textarea value={note} onChange={event => { setNote(event.target.value); setSaved(null); }} maxLength={1500} rows={3} disabled={busy} placeholder="Почему нужен этот маршрут?" /></label>{error && <ErrorNotice message={error} />}{saved && <div className={styles.success} role="status"><Check size={15} />Оценка сохранена: {saved.matchesPrimary ? "маршрут подтверждён" : "отмечена ошибка основного маршрута"}.</div>}<button className="button button-secondary button-small" type="submit" disabled={busy || !expected}>{busy ? <Spinner /> : <Save size={14} />}Сохранить оценку</button></form></section>;
}

type CatalogPatch = { name?: string; description?: string; examples?: { ru?: string[]; kk?: string[] }; not_this_if?: Scenario["not_this_if"] };
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);

export function CatalogEditor({ scenario: incomingScenario, catalog, expectedHash: incomingHash, onSaved, onClose }: { scenario: Scenario; catalog: Scenario[]; expectedHash: string; onSaved: (hash: string) => Promise<unknown>; onClose: () => void }) {
  // Keep the edit base fixed even if background polling refreshes the catalog.
  const editBase = useRef({ scenario: incomingScenario, expectedHash: incomingHash });
  const { scenario, expectedHash } = editBase.current;
  const [name, setName] = useState(scenario.name);
  const [description, setDescription] = useState(scenario.description);
  const [ru, setRu] = useState(scenario.examples.ru.join("\n"));
  const [kk, setKk] = useState(scenario.examples.kk.join("\n"));
  const [rules, setRules] = useState(() => scenario.not_this_if.map(rule => ({ ...rule })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committedHash, setCommittedHash] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])];
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") { const elements = focusable(), first = elements[0], last = elements.at(-1); if (!elements.length) { event.preventDefault(); return; } if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    document.addEventListener("keydown", keydown); return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  const patch: CatalogPatch = {};
  if (name.trim() !== scenario.name) patch.name = name.trim();
  if (description.trim() !== scenario.description) patch.description = description.trim();
  const examples: NonNullable<CatalogPatch["examples"]> = {};
  if (ru !== scenario.examples.ru.join("\n")) examples.ru = lines(ru);
  if (kk !== scenario.examples.kk.join("\n")) examples.kk = lines(kk);
  if (Object.keys(examples).length) patch.examples = examples;
  const normalizedRules = rules.map(rule => ({ condition: rule.condition.trim(), use_instead: rule.use_instead }));
  if (JSON.stringify(normalizedRules) !== JSON.stringify(scenario.not_this_if)) patch.not_this_if = normalizedRules;
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy || !Object.keys(patch).length || committedHash) return;
    setBusy(true); busyRef.current = true; setError(null); setConflict(false);
    try {
      const result = await api<{ revision: Revision }>(`/api/catalog/${scenario.scenario_id}`, { method: "PATCH", body: JSON.stringify({ expectedHash, patch }) });
      setCommittedHash(result.revision.hash);
      try { await onSaved(result.revision.hash); onClose(); } catch { setError("Изменения сохранены, но обновить каталог не удалось. Повторите загрузку ниже."); }
    } catch (err) { setError(readableError(err)); setConflict(err instanceof ApiError && err.status === 409); }
    finally { setBusy(false); busyRef.current = false; }
  }
  async function reload() {
    setBusy(true); busyRef.current = true; setError(null);
    try { await onSaved(committedHash ?? ""); onClose(); } catch (err) { setError(readableError(err)); }
    finally { setBusy(false); busyRef.current = false; }
  }
  const disabled = busy || !!committedHash;
  return <div className={styles.backdrop}><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="catalog-editor-title" className={styles.dialog}><div className={styles.dialogHeader}><div><span className={styles.hint}>{scenario.scenario_id} · версия {expectedHash.slice(0, 12)}</span><h2 id="catalog-editor-title">Редактирование сценария</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Закрыть редактор"><X size={19} /></button></div><form className={styles.editorForm} onSubmit={save}><div className={`${styles.form} ${styles.editorBody}`}><p className={styles.hint}>Изменения применятся к следующим решениям маршрутизатора. Действия, обязательные параметры и подтверждения защищены от редактирования.</p><label>Название<input value={name} onChange={e => setName(e.target.value)} minLength={3} maxLength={100} required disabled={disabled} /></label><label>Описание<textarea value={description} onChange={e => setDescription(e.target.value)} minLength={10} maxLength={1000} rows={4} required disabled={disabled} /></label><div className={styles.exampleColumns}><label>Примеры на русском<textarea value={ru} onChange={e => setRu(e.target.value)} rows={6} maxLength={2500} required disabled={disabled} /><span className={styles.hint}>Одна фраза на строке, 1–8 фраз по 3–300 символов.</span></label><label>Примеры на казахском<textarea value={kk} onChange={e => setKk(e.target.value)} rows={6} maxLength={2500} required disabled={disabled} /><span className={styles.hint}>Одна фраза на строке, 1–8 фраз по 3–300 символов.</span></label></div><div className={styles.sectionHeading}><h3>Когда выбрать другой сценарий</h3><button type="button" className="button button-secondary button-small" onClick={() => setRules(value => [...value, { condition: "", use_instead: catalog.find(s => s.scenario_id !== scenario.scenario_id)?.scenario_id ?? "SC01" }])} disabled={disabled || rules.length >= 8}><Plus size={14} />Добавить</button></div>{!rules.length && <p className={styles.hint}>Дополнительных правил исключения нет.</p>}{rules.map((rule, index) => <div key={index} className={styles.rule}><label>Условие {index + 1}<textarea value={rule.condition} minLength={3} maxLength={300} required rows={2} disabled={disabled} onChange={e => setRules(value => value.map((item, i) => i === index ? { ...item, condition: e.target.value } : item))} /></label><div className={styles.ruleTarget}><label>Вместо этого выбрать<select value={rule.use_instead} disabled={disabled} onChange={e => setRules(value => value.map((item, i) => i === index ? { ...item, use_instead: e.target.value } : item))}>{catalog.filter(s => s.scenario_id !== scenario.scenario_id).map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.scenario_id} · {scenarioDisplayName(s.scenario_id, s.name)}</option>)}</select></label><button type="button" className="icon-button" onClick={() => setRules(value => value.filter((_, i) => i !== index))} disabled={disabled} aria-label={`Удалить правило ${index + 1}`}><Trash2 size={16} /></button></div></div>)}{committedHash && <p className={styles.success} role="status"><Check size={16} />Версия {committedHash.slice(0, 12)} сохранена.</p>}{error && <ErrorNotice message={error} />}{(conflict || committedHash) && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void reload()}><RefreshCw size={14} />{committedHash ? "Загрузить сохранённый каталог" : "Обновить каталог и закрыть редактор"}</button>}</div><div className={styles.dialogFooter}><span className={styles.hint}>Сохранение создаст новую версию с автором и временем изменения.</span><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Отмена</button><button type="submit" className="button button-primary" disabled={disabled || !Object.keys(patch).length}>{busy ? <Spinner /> : <Save size={15} />}Сохранить</button></div></form></section></div>;
}
