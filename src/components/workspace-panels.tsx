"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronDown, ChevronRight, CircleCheck, Clock3, GitBranch, Headphones, History, Layers3, MessageSquare, Pencil, Search, ShieldCheck, SlidersHorizontal, Workflow } from "lucide-react";
import type { ActionResult, DialogueState, Handoff, Json, Scenario, Session, SessionDetail, Turn } from "@/lib/types";
import { api, categoryDisplayName, dateTime, domainDisplayName, duration, EmptyState, ErrorNotice, languageLabel, readableError, scenarioDisplayName, sessionStatus, Spinner, time } from "./workspace-ui";
import { CatalogEditor, TurnReviewEditor } from "./supervisor-tools";
import supervisorStyles from "./supervisor-tools.module.css";

const slotLabels: Record<string, string> = {
  client_id: "Клиент", customer_id: "Клиент", account_id: "Лицевой счёт", phone: "Телефон", phone_number: "Телефон",
  order_id: "Заказ", address: "Адрес", city: "Город", date: "Дата", amount: "Сумма", service: "Услуга",
  full_name: "Имя", iin: "ИИН", language: "Язык", reason: "Причина", status: "Статус", request_id: "Обращение",
};

function humanKey(key: string) { return slotLabels[key] ?? key.replaceAll("_", " "); }
function displayValue(value: Json): string { return value == null ? "Не указано" : typeof value === "object" ? JSON.stringify(value) : String(value); }
function scenarioName(catalog: Scenario[], id: string) { return scenarioDisplayName(id, catalog.find(s => s.scenario_id === id)?.name); }
function actionStatus(status: ActionResult["status"]) {
  return { read: "Данные получены", preview: "Ожидает подтверждения", executed: "Выполнено", queued: "В очереди", failed: "Ошибка" }[status];
}

function SlotList({ slots }: { slots: Record<string, Json> }) {
  const entries = Object.entries(slots);
  return entries.length ? <dl className="slot-list">{entries.map(([key, value]) => <div key={key}><dt>{humanKey(key)}</dt><dd>{displayValue(value)}</dd></div>)}</dl> : <p className="muted small">Параметры ещё не определены.</p>;
}

export function TracePanel({ detail, catalog, selectedTurnId, onSelectTurn, isSupervisor = false }: { detail: SessionDetail | null; catalog: Scenario[]; selectedTurnId: string | null; onSelectTurn: (id: string) => void; isSupervisor?: boolean }) {
  const [tab, setTab] = useState<"trace" | "context">("trace");
  const turn = detail?.turns.find(t => t.id === selectedTurnId) ?? detail?.turns.at(-1);
  const trace = turn?.trace;
  const state = detail?.session.state;
  const active = state?.activeScenarioId ? catalog.find(s => s.scenario_id === state.activeScenarioId) : null;

  return <aside className="trace-panel" aria-label="Решение маршрутизатора">
    <div className="panel-heading"><span className="section-eyebrow"><GitBranch size={15} />ПОД КАПОТОМ</span><span className="trace-live">В реальном времени</span></div>
    <div className="panel-tabs"><button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>Маршрутизация</button><button className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}>Контекст</button></div>
    <div className="trace-scroll">
      {tab === "context" ? <>
        <section className="trace-section"><div className="trace-section-heading"><Layers3 size={15} /><h3>Состояние разговора</h3></div>{state ? <>
          <dl className="slot-list"><div><dt>Статус</dt><dd>{sessionStatus(state.status)}</dd></div><div><dt>Язык</dt><dd>{languageLabel(state.language)}</dd></div><div><dt>Текущий сценарий</dt><dd>{active ? scenarioDisplayName(active.scenario_id, active.name) : "Не выбран"}</dd></div></dl>
          {state.pendingConfirmation && <div className="confirmation-note"><ShieldCheck size={17} /><div><strong>Нужно подтверждение</strong><p>{state.pendingConfirmation.summary}</p></div></div>}
        </> : <p className="muted small">Контекст появится после начала разговора.</p>}</section>
        {state && <><ContextThemes title="Следующие темы" ids={state.pendingScenarioIds} catalog={catalog} /><ContextThemes title="Приостановленные" ids={state.suspendedScenarioIds} catalog={catalog} /><ContextThemes title="Завершённые" ids={state.completedScenarioIds} catalog={catalog} /><section className="trace-section"><div className="trace-section-heading"><SlidersHorizontal size={15} /><h3>Собранные параметры</h3></div><SlotList slots={state.slots} /></section></>}
      </> : !trace ? <div className="trace-empty"><div className="trace-diagram" aria-hidden="true"><span><MessageSquare size={18} /></span><i /><span className="trace-diagram-center"><GitBranch size={22} /></span><i /><span><Check size={18} /></span></div><h3>У каждого решения<br />есть объяснение</h3><p>После первой реплики здесь появятся выбранный сценарий, параметры, действия и время обработки.</p><div className="trace-empty-note"><ShieldCheck size={16} /><span>Значимые операции выполняются после подтверждения.</span></div></div> : <>
        <div className="turn-select"><label htmlFor="trace-turn">Реплика</label><select id="trace-turn" value={turn?.id} onChange={e => onSelectTurn(e.target.value)}>{detail?.turns.map((t, index) => <option key={t.id} value={t.id}>{index + 1}. {t.userText.slice(0, 48)}</option>)}</select></div>
        <section className="trace-section first-trace-section"><div className="trace-section-heading"><GitBranch size={15} /><h3>Выбранный маршрут</h3><span className="micro-badge">{{ llm: "LLM", slot: "Заполнение параметра", operator: "Оператор", confirmation: "Подтверждение" }[trace.source]}</span></div>
          {trace.scenarios.length ? trace.scenarios.map((choice, index) => <div className="route-choice" key={`${choice.scenarioId}-${index}`}><div className="route-choice-top"><span className="route-number">{String(index + 1).padStart(2, "0")}</span><span className="confidence">{Math.round(choice.confidence * 100)}%</span></div><h4>{scenarioName(catalog, choice.scenarioId)}</h4><p>{choice.reason}</p><div className="confidence-track"><span style={{ width: `${Math.min(100, Math.max(0, choice.confidence * 100))}%` }} /></div></div>) : <div className="soft-note">Сценарий не выбран. {trace.reason}</div>}
          {trace.scenarios.length > 0 && !trace.scenarios.some(choice => choice.reason.trim() === trace.reason.trim()) && <p className="trace-reason">{trace.reason}</p>}
          <p className="tiny muted">{trace.source === "llm" ? "Проценты — оценка выбора модели." : "Продолжение активного сценария по правилам диалога."}</p>
          {trace.alternatives.length > 0 && <details className="alternatives"><summary>Другие варианты <span>{trace.alternatives.length}</span><ChevronDown size={13} /></summary>{trace.alternatives.map((choice, index) => <div className="alternative" key={`${choice.scenarioId}-${index}`}><strong>{scenarioName(catalog, choice.scenarioId)}</strong><span>{Math.round(choice.confidence * 100)}%</span><p>{choice.reason}</p></div>)}</details>}
        </section>
        <section className="trace-section"><div className="trace-section-heading"><SlidersHorizontal size={15} /><h3>Параметры реплики</h3><span className="micro-badge">{languageLabel(trace.language)}</span></div><SlotList slots={trace.slots} /></section>
        <section className="trace-section"><div className="trace-section-heading"><Workflow size={15} /><h3>Исполнение</h3>{trace.actions.length > 0 && <span className="micro-badge">{trace.actions.length}</span>}</div>{trace.actions.length ? trace.actions.map((action, index) => <details className={`action-result action-${action.status}`} key={`${action.name}-${index}`}><summary><span className="action-marker">{action.status === "failed" ? "!" : action.status === "preview" || action.status === "queued" ? <Clock3 size={13} /> : <Check size={13} />}</span><span><strong>{humanKey(action.name)}</strong><small>{actionStatus(action.status)}</small></span><ChevronDown size={13} /></summary><div className="action-result-data">{action.error && <p className="text-error">{action.error.message}</p>}<SlotList slots={action.data} /></div></details>) : <p className="muted small">Действия в этой реплике не выполнялись.</p>}</section>
        <section className="trace-section timing-section"><div className="trace-section-heading"><Clock3 size={15} /><h3>Время обработки</h3></div><dl className="timing-list">{trace.timings.stt != null && <div><dt>Распознавание речи</dt><dd>{duration(trace.timings.stt)}</dd></div>}<div><dt>Выбор маршрута</dt><dd>{duration(trace.timings.router)}</dd></div><div><dt>Исполнение</dt><dd>{duration(trace.timings.executor)}</dd></div><div><dt>Подготовка ответа</dt><dd>{duration(trace.timings.response)}</dd></div><div className="timing-total"><dt>На сервере</dt><dd>{duration(trace.timings.serverTotal)}</dd></div>{trace.timings.ttsFirstByte != null && <div><dt>{trace.timings.ttsCacheHit ? "Первое озвучивание" : "До ответа синтеза"}</dt><dd>{trace.timings.ttsCacheHit ? "Из кэша" : duration(trace.timings.ttsFirstByte)}</dd></div>}{trace.timings.playback != null && <div className="timing-total"><dt>{turn?.mode === "voice" ? "От отправки записи до звука" : "От отправки до звука"}</dt><dd>{duration(trace.timings.playback)}</dd></div>}</dl></section>
        {trace.warnings.length > 0 && <section className="trace-section"><h3 className="small">Замечания</h3>{trace.warnings.map((warning, i) => <p className="warning-text small" key={i}>{warning}</p>)}</section>}
        {(trace.timings.lastPlaybackCached != null || trace.timings.ttsCacheHit) && <div className="soft-note"><strong>Последнее воспроизведение: {(trace.timings.lastPlaybackCached ?? trace.timings.ttsCacheHit) ? "из кэша" : "новый синтез"}</strong><p>{(trace.timings.lastPlaybackCached ?? trace.timings.ttsCacheHit) ? "Использована сохранённая аудиозапись без повторного синтеза." : "Для этого ответа создана новая аудиозапись."}</p></div>}
        <div className="trace-footnote"><span>{trace.model}</span><span>{trace.usage.inputTokens + trace.usage.outputTokens} токенов · ${trace.usage.estimatedUsd.toFixed(5)}</span><span>Каталог: {trace.catalogHash.slice(0, 12)}</span></div>
        {trace.tone && <p className="tiny muted">Стиль ответа: {{ neutral: "нейтральный", calm: "спокойный", reassuring: "поддерживающий" }[trace.tone]}. Язык ответа: {languageLabel(trace.responseLanguage ?? trace.language)}.</p>}
        {isSupervisor && turn && <TurnReviewEditor key={turn.id} turn={turn} catalog={catalog} />}
      </>}
    </div>
  </aside>;
}

function ContextThemes({ title, ids, catalog }: { title: string; ids: string[]; catalog: Scenario[] }) {
  return <section className="trace-section"><div className="trace-section-heading"><Layers3 size={15} /><h3>{title}</h3><span className="micro-badge">{ids.length}</span></div>{ids.length ? <ul className="theme-list">{ids.map(id => <li key={id}><span />{scenarioName(catalog, id)}</li>)}</ul> : <p className="muted small">Нет тем.</p>}</section>;
}

export function HistoryView({ sessions, onOpen, onNew, currentId }: { sessions: Session[]; onOpen: (id: string) => void; onNew: () => void; currentId?: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = [...sessions].filter(s => (status === "all" || s.state.status === status) && `${s.title} ${s.id}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="collection-page"><div className="collection-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Поиск разговоров" placeholder="Найти разговор…" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Статус разговора" className="filter-select" value={status} onChange={e => setStatus(e.target.value)}><option value="all">Все статусы</option><option value="active">В работе</option><option value="handoff">У оператора</option><option value="closed">Завершённые</option></select><span className="result-count">Найдено: {filtered.length}</span></div>
    {!sessions.length ? <EmptyState icon={<History size={26} />} title="Здесь будет история разговоров" description="Разговоры сохраняются. Вы сможете вернуться к обращению и продолжить с того же места." action={{ label: "Начать разговор", onClick: onNew }} /> : !filtered.length ? <EmptyState icon={<Search size={26} />} title="Ничего не найдено" description="Попробуйте изменить запрос или выбрать другой статус." /> : <div className="history-table"><div className="history-table-heading"><span>Разговор</span><span>Статус</span><span>Последнее обращение</span><span /></div>{filtered.map(session => <div className={`history-row ${session.id === currentId ? "history-current" : ""}`} key={session.id}><button className="history-main" onClick={() => onOpen(session.id)}><span className="history-icon"><MessageSquare size={19} /></span><span><strong>{session.title || "Новый разговор"}</strong><small>{session.turnCount} реплик · {languageLabel(session.state.language)}{session.id === currentId ? " · Открыт сейчас" : ""}</small></span></button><span className={`status-badge status-${session.state.status}`}><i />{sessionStatus(session.state.status)}</span><span className="history-date">{dateTime(session.updatedAt)}</span><div className="row-actions"><a href={`/api/sessions/${session.id}/export`} download className="icon-button" title="Скачать историю в JSON" aria-label={`Скачать разговор ${session.title}`}><ArrowDownToLine size={17} /></a><button className="icon-button" onClick={() => onOpen(session.id)} aria-label={`Открыть разговор ${session.title}`}><ArrowRight size={18} /></button></div></div>)}</div>}
  </section>;
}

export function CatalogView({ catalog, onExample, canEdit = false, catalogHash, onCatalogChanged }: { catalog: Scenario[]; onExample: (text: string) => void; canEdit?: boolean; catalogHash: string; onCatalogChanged: () => Promise<unknown> }) {
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const domains = [...new Set(catalog.map(s => s.domain))];
  const filtered = catalog.filter(s => (domain === "all" || s.domain === domain) && `${scenarioDisplayName(s.scenario_id, s.name)} ${domainDisplayName(s.domain)} ${categoryDisplayName(s.category)} ${s.name} ${s.description} ${s.scenario_id} ${s.category}`.toLowerCase().includes(query.toLowerCase()));
  const selected = catalog.find(s => s.scenario_id === selectedId);
  async function catalogSaved(hash: string) { if (hash) setSavedHash(hash); await onCatalogChanged(); }
  return <section className="collection-page"><div className="collection-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Поиск сценариев" placeholder="Название, описание или код сценария…" value={query} onChange={e => setQuery(e.target.value)} /></div><select className="filter-select" aria-label="Направление сценария" value={domain} onChange={e => setDomain(e.target.value)}><option value="all">Все направления</option>{domains.map(value => <option value={value} key={value}>{domainDisplayName(value)}</option>)}</select><span className="result-count">{filtered.length} сценариев</span></div>
    {savedHash && <div className={`${supervisorStyles.success} ${supervisorStyles.notice}`} role="status"><Check size={16} />Каталог сохранён. Версия {savedHash.slice(0, 12)}.</div>}{editing && selected && canEdit && <CatalogEditor key={selected.scenario_id} scenario={selected} catalog={catalog} expectedHash={catalogHash} onSaved={catalogSaved} onClose={() => setEditing(false)} />}
    <div className={`catalog-layout ${selected ? "catalog-with-detail" : ""}`}><div className="catalog-grid">{filtered.map(s => <button className={`catalog-card ${selectedId === s.scenario_id ? "catalog-card-selected" : ""}`} onClick={() => setSelectedId(selectedId === s.scenario_id ? null : s.scenario_id)} key={s.scenario_id}><div className="catalog-card-top"><span className="catalog-card-icon"><GitBranch size={18} /></span><span className="catalog-domain">{domainDisplayName(s.domain)}</span><ChevronRight size={15} /></div><h3>{scenarioDisplayName(s.scenario_id, s.name)}</h3><p>{categoryDisplayName(s.category)}</p><div className="catalog-card-footer"><span>{s.scenario_id}</span>{s.requires_confirmation ? <span><ShieldCheck size={13} />Подтверждение</span> : s.handoff ? <span><Headphones size={13} />Оператор</span> : <span>{s.slots.required.length} параметров</span>}</div></button>)}</div>
    {selected && <aside className="catalog-detail"><div className="panel-heading"><span className="section-eyebrow">КАРТОЧКА СЦЕНАРИЯ</span><button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Закрыть карточку сценария">×</button></div><h2>{scenarioDisplayName(selected.scenario_id, selected.name)}</h2>{canEdit && <button className={`button button-secondary button-small ${supervisorStyles.editButton}`} onClick={() => setEditing(true)}><Pencil size={14} />Редактировать сценарий</button>}<details className="catalog-source"><summary>Название и описание для маршрутизатора</summary><strong>{selected.name}</strong><p>{selected.description}</p></details><dl className="slot-list"><div><dt>Код</dt><dd>{selected.scenario_id}</dd></div><div><dt>Приоритет</dt><dd>{selected.priority === "urgent" ? "Срочный" : selected.priority === "high" ? "Высокий" : "Обычный"}</dd></div><div><dt>Идентификация</dt><dd>{selected.requires_identification ? "Нужна" : "Не нужна"}</dd></div><div><dt>Подтверждение</dt><dd>{selected.requires_confirmation ? "Нужно" : "Не нужно"}</dd></div></dl><h3>Обязательные параметры</h3><div className="tag-list">{selected.slots.required.length ? selected.slots.required.map(slot => <span key={slot}>{humanKey(slot)}</span>) : <p className="muted small">Не требуются.</p>}</div><h3>Действия</h3><ul className="theme-list">{selected.actions.map(action => <li key={action}><Workflow size={13} />{humanKey(action)}</li>)}</ul>{selected.handoff && <div className="soft-note"><strong>Передача оператору</strong><p>{selected.handoff.when}</p><small>Очередь: {selected.handoff.queue}</small></div>}<h3>Примеры из каталога</h3><p className="muted tiny">Нажмите, чтобы перенести фразу в поле ввода.</p>{[...selected.examples.ru.slice(0, 2), ...selected.examples.kk.slice(0, 1)].map((example, i) => <button className="catalog-example" key={i} onClick={() => onExample(example)}>{example}<ArrowUpRightIcon /></button>)}</aside>}
    </div>{!filtered.length && <EmptyState icon={<BookOpen size={26} />} title="Сценарии не найдены" description="Измените фильтр или поисковый запрос." />}
  </section>;
}

function ArrowUpRightIcon() { return <ArrowRight size={15} className="example-arrow" />; }

export function OperatorsView({ handoffs, onChanged, onOpen, drafts, requests, onBusyChange }: { handoffs: Handoff[]; onChanged: () => Promise<unknown>; onOpen: (id: string) => void; drafts: Map<string, string>; requests: Map<string, string>; onBusyChange: (busy: boolean) => void }) {
  const [filter, setFilter] = useState("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedHandoffs, setSavedHandoffs] = useState<Record<string, Handoff>>({});
  const busyRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const pollInFlightRef = useRef(false);
  selectedIdRef.current = selectedId;
  const effectiveHandoffs = handoffs.map(item => {
    const saved = savedHandoffs[item.id];
    return saved && saved.updatedAt >= item.updatedAt ? saved : item;
  });
  const filtered = effectiveHandoffs.filter(h => filter === "all" || (filter === "open" ? h.status !== "closed" : h.status === filter));
  const selected = effectiveHandoffs.find(h => h.id === selectedId);

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => {
    setMessage(selectedId ? drafts.get(selectedId) ?? "" : ""); setError(null); setNotice(null); setDetail(null);
    if (!selected) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    api<SessionDetail>(`/api/sessions/${selected.sessionId}`).then(value => { if (current) setDetail(value); }).catch(err => { if (current) setError(readableError(err)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selected?.id, selected?.sessionId, selectedId, drafts]);

  useEffect(() => {
    let stopped = false;
    const poll = setInterval(async () => {
      if (document.visibilityState !== "visible" || busyRef.current || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      const targetId = selected?.id;
      try {
        await onChanged();
        if (selected && selected.status !== "closed" && !busyRef.current && !stopped) {
          const updated = await api<SessionDetail>(`/api/sessions/${selected.sessionId}`);
          if (!stopped && !busyRef.current && selectedIdRef.current === targetId) setDetail(current => current && current.session.id === updated.session.id && current.session.version > updated.session.version ? current : updated);
        }
      } catch { /* Manual refresh remains available; polling never discards a draft. */ }
      finally { pollInFlightRef.current = false; }
    }, 5000);
    return () => { stopped = true; clearInterval(poll); };
  }, [onChanged, selected?.id, selected?.sessionId, selected?.status]);

  function choose(id: string) {
    if (busyRef.current || selectedIdRef.current === id) return;
    selectedIdRef.current = id; setMessage(drafts.get(id) ?? ""); setDetail(null); setLoading(true); setSelectedId(id);
  }

  async function update(status: "active" | "closed", withMessage: boolean) {
    if (!selected || selectedIdRef.current !== selected.id || busyRef.current || loading || selected.status === "closed") return;
    const target = selected;
    const originalDraft = drafts.get(target.id) ?? message;
    const sentMessage = withMessage ? originalDraft.trim() : "";
    if (withMessage && !sentMessage) return;
    const key = JSON.stringify([target.id, status, sentMessage]);
    const requestId = requests.get(key) ?? crypto.randomUUID();
    requests.set(key, requestId);
    busyRef.current = true; setBusy(true); onBusyChange(true); setError(null); setNotice(null);
    try {
      const result = await api<{ handoff: Handoff }>(`/api/handoffs/${target.id}`, { method: "PATCH", body: JSON.stringify({ status, requestId, ...(withMessage ? { message: sentMessage } : {}) }) });
      requests.delete(key);
      if (withMessage && drafts.get(target.id) === originalDraft) {
        drafts.delete(target.id);
        if (aliveRef.current && selectedIdRef.current === target.id) setMessage("");
      }
      if (!aliveRef.current) return;
      setSavedHandoffs(current => ({ ...current, [target.id]: result.handoff }));
      if (selectedIdRef.current === target.id) setNotice(status === "closed" ? withMessage ? "Ответ сохранён. Обращение завершено." : "Обращение завершено." : withMessage ? "Ответ сохранён и доступен клиенту." : "Обращение принято в работу. Черновик ответа сохранён.");
      try {
        await onChanged();
        const updated = await api<SessionDetail>(`/api/sessions/${target.sessionId}`);
        if (aliveRef.current && selectedIdRef.current === target.id) setDetail(updated);
      } catch {
        if (aliveRef.current && selectedIdRef.current === target.id) setError("Изменение сохранено, но свежую историю загрузить не удалось. Повторно отправлять ответ не нужно: обновите данные.");
      }
    } catch (err) {
      if (aliveRef.current && selectedIdRef.current === target.id) setError(readableError(err));
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
      onBusyChange(false);
    }
  }

  return <section className="collection-page">
    <div className="collection-toolbar"><div className="segmented-control">
      <button className={filter === "open" ? "active" : ""} disabled={busy} onClick={() => setFilter("open")}>Открытые <span>{effectiveHandoffs.filter(h => h.status !== "closed").length}</span></button>
      <button className={filter === "closed" ? "active" : ""} disabled={busy} onClick={() => setFilter("closed")}>Завершённые</button>
      <button className={filter === "all" ? "active" : ""} disabled={busy} onClick={() => setFilter("all")}>Все</button>
    </div><span className="result-count">{filtered.length} обращений</span></div>
    {!filtered.length && !selected ? <EmptyState icon={<Headphones size={27} />} title="В очереди нет обращений" description="Здесь появятся разговоры, для которых требуется участие оператора, вместе с контекстом и причиной передачи." /> : <div className="operator-layout">
      <div className="handoff-list">{filtered.map(h => <button className={`handoff-card ${h.id === selectedId ? "selected" : ""}`} key={h.id} disabled={busy} onClick={() => choose(h.id)}><div><span className={`status-badge status-${h.status}`}><i />{h.status === "waiting" ? "Ожидает" : h.status === "active" ? "В работе" : "Закрыто"}</span><time>{time(h.createdAt)}</time></div><h3>{h.queue}</h3><p>{h.summary || h.reason}</p>{h.summary && h.summary.trim() !== h.reason.trim() && <span className="handoff-reason">{h.reason}</span>}{drafts.get(h.id)?.trim() && <small>Есть черновик ответа</small>}</button>)}</div>
      <div className="operator-detail">{!selected ? <EmptyState icon={<Headphones size={26} />} title="Выберите обращение" description="Просмотрите историю, примите обращение в работу и ответьте клиенту." /> : <>
        <div className="operator-detail-header"><div><span className="section-eyebrow">ОБРАЩЕНИЕ ОПЕРАТОРА</span><h2>{selected.queue}</h2></div><button className="button button-secondary button-small" disabled={busy} onClick={() => { if (!busyRef.current) onOpen(selected.sessionId); }}>Открыть диалог<ArrowRight size={14} /></button></div>
        <div className="handoff-summary"><strong>Контекст передачи</strong><p>{selected.summary || selected.reason}</p>{selected.summary && selected.summary.trim() !== selected.reason.trim() && <span>{selected.reason}</span>}</div>
        {notice && <div className="closed-note" role="status"><CircleCheck size={17} />{notice}</div>}
        {error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}
        {loading ? <div className="inline-loading"><Spinner label="Загружаем историю…" /></div> : <div className="operator-transcript">{detail?.turns.map(turn => <div key={turn.id}>{turn.mode !== "operator" && turn.userText && <p><strong>Клиент</strong>{turn.userText}</p>}<p><strong>{turn.mode === "operator" ? "Оператор" : "DIR ECHOES"}</strong>{turn.assistantText}</p></div>)}</div>}
        {selected.status !== "closed" ? <div className="operator-compose"><label htmlFor="operator-message">Ответ клиенту</label><textarea id="operator-message" value={message} onChange={e => { const value = e.target.value; drafts.set(selected.id, value); setMessage(value); setNotice(null); }} maxLength={2000} placeholder="Напишите ответ. Он сохранится в разговоре клиента." disabled={busy || loading} /><div>
          {selected.status === "waiting" && <button className="button button-secondary button-small" onClick={() => void update("active", false)} disabled={busy || loading}>Принять в работу</button>}
          <button className="button button-primary button-small" disabled={busy || loading || !message.trim()} onClick={() => void update("active", true)}>{busy ? <Spinner /> : <MessageSquare size={14} />}Отправить ответ</button>
          <button className="button button-ghost button-small" disabled={busy || loading} onClick={() => void update("closed", !!message.trim())}><CircleCheck size={15} />{message.trim() ? "Ответить и завершить" : "Завершить обращение"}</button>
        </div></div> : <><div className="closed-note"><CircleCheck size={17} />Обращение завершено {dateTime(selected.updatedAt)}.</div>{message.trim() && <div className="soft-note"><strong>Неотправленный черновик</strong><p>Обращение уже закрыто. Текст можно скопировать для дальнейшей работы.</p><textarea aria-label="Неотправленный черновик ответа" value={message} readOnly rows={4} /></div>}</>}
      </>}</div>
    </div>}
  </section>;
}
