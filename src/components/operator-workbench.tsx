"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, AudioLines, CircleCheck, Headphones, MessageSquare, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { Handoff, Scenario, Session, SessionDetail } from "@/lib/types";
import { api, dateTime, EmptyState, ErrorNotice, languageLabel, readableError, scenarioDisplayName, Spinner, time } from "./workspace-ui";
import { OperatorVoiceControls } from "./operator-voice-controls";
import styles from "./operator-workbench.module.css";

type Props = {
  sessions: Session[];
  handoffs: Handoff[];
  catalog: Scenario[];
  onChanged: () => Promise<unknown>;
  onOpen: (id: string) => void;
  drafts: Map<string, string>;
  requests: Map<string, string>;
  onBusyChange: (busy: boolean) => void;
};
type Filter = "all" | "ai" | "waiting" | "active" | "closed";
type Row = { id: string; title: string; status: Exclude<Filter, "all">; updatedAt: string; turnCount: number | null; handoff?: Handoff };
const statusNames = { ai: "С AI", waiting: "Ждёт оператора", active: "У оператора", closed: "Завершён" };
const queueNames: Record<string, string> = { operator_general: "Общая линия", claims_team: "Страховые случаи", complaints_team: "Жалобы", medical_assistance_24_7: "Медицинская помощь", sales_team: "Оформление", technical_support: "Техническая помощь" };

export function OperatorsView({ sessions, handoffs, catalog, onChanged, onOpen, drafts, requests, onBusyChange }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedHandoffs, setSavedHandoffs] = useState<Record<string, Handoff>>({});
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncIssue, setSyncIssue] = useState(false);
  const busyRef = useRef(false);
  const selectedRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const pollInFlightRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);
  selectedRef.current = selectedSessionId;

  const merged = new Map(handoffs.map(h => [h.id, h]));
  for (const h of Object.values(savedHandoffs)) if (!merged.has(h.id) || merged.get(h.id)!.updatedAt <= h.updatedAt) merged.set(h.id, h);
  const bySession = new Map<string, Handoff>();
  for (const h of [...merged.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) bySession.set(h.sessionId, h);
  const knownSessions = new Map(sessions.map(session => [session.id, session]));
  if (detail && (!knownSessions.has(detail.session.id) || knownSessions.get(detail.session.id)!.version <= detail.session.version)) knownSessions.set(detail.session.id, detail.session);
  const rows: Row[] = [...knownSessions.values()].map((session): Row => {
    const handoff = bySession.get(session.id);
    return { id: session.id, title: session.title || "Новый разговор", updatedAt: session.updatedAt, turnCount: session.turnCount, handoff,
      status: session.state.status === "closed" ? "closed" : handoff && handoff.status !== "closed" ? handoff.status : session.state.status === "handoff" ? "waiting" : "ai" };
  });
  for (const h of bySession.values()) if (!knownSessions.has(h.sessionId)) rows.push({ id: h.sessionId, title: h.reason || "Обращение оператору", updatedAt: h.updatedAt, turnCount: null, handoff: h, status: h.status });
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = rows.find(row => row.id === selectedSessionId);
  const selectedHandoff = selected?.handoff;
  const filtered = rows.filter(row => (filter === "all" || row.status === filter) && `${row.title} ${row.id} ${row.handoff?.queue ?? ""}`.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")));
  const state = detail?.session.state;
  const activeScenario = state?.activeScenarioId ? scenarioDisplayName(state.activeScenarioId, catalog.find(s => s.scenario_id === state.activeScenarioId)?.name) : null;

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => {
    setError(null); setNotice(null); setDetail(null); followTranscriptRef.current = true;
    if (!selectedSessionId) { setLoading(false); return; }
    let current = true;
    setLoading(true);
    api<SessionDetail>(`/api/sessions/${selectedSessionId}`).then(value => { if (current) setDetail(value); }).catch(err => { if (current) setError(readableError(err)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [selectedSessionId]);
  useEffect(() => { setMessage(selectedHandoff ? drafts.get(selectedHandoff.id) ?? "" : ""); }, [selectedHandoff?.id, drafts]);
  useEffect(() => {
    if (followTranscriptRef.current && transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [detail?.turns.length, loading]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || busyRef.current || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      const target = selectedRef.current;
      try {
        await onChanged();
        if (target && !stopped && !busyRef.current) {
          const updated = await api<SessionDetail>(`/api/sessions/${target}`);
          if (!stopped && !busyRef.current && selectedRef.current === target) setDetail(current => current?.session.id === target && current.session.version > updated.session.version ? current : updated);
        }
        if (!stopped) { setLastSync(new Date().toISOString()); setSyncIssue(false); }
      } catch { if (!stopped) setSyncIssue(true); }
      finally { pollInFlightRef.current = false; }
    };
    void refresh();
    const poll = setInterval(() => void refresh(), 2000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [onChanged]);

  function choose(id: string) {
    if (busyRef.current || selectedRef.current === id) return;
    selectedRef.current = id; setDetail(null); setLoading(true); setSelectedSessionId(id);
  }
  async function reloadSelected(sessionId: string) {
    try {
      await onChanged();
      const updated = await api<SessionDetail>(`/api/sessions/${sessionId}`);
      if (aliveRef.current && selectedRef.current === sessionId) setDetail(updated);
    } catch { if (aliveRef.current && selectedRef.current === sessionId) setError("Изменение сохранено. Историю пока не удалось обновить; повторять действие не нужно."); }
  }
  async function takeOver() {
    if (!selected || selected.status === "closed" || busyRef.current || loading) return;
    const target = selected.id;
    const key = `takeover:${target}`;
    const requestId = requests.get(key) ?? crypto.randomUUID();
    requests.set(key, requestId);
    busyRef.current = true; setBusy(true); onBusyChange(true); setError(null); setNotice(null);
    try {
      const result = await api<{ handoff: Handoff; sessionId: string }>(`/api/sessions/${target}/takeover`, { method: "POST", body: JSON.stringify({ requestId }) });
      requests.delete(key);
      if (!aliveRef.current) return;
      setSavedHandoffs(current => ({ ...current, [result.handoff.id]: result.handoff }));
      setNotice("Вы приняли разговор. AI остановлен; можно ответить текстом или подключить свой голос.");
      await reloadSelected(target);
    } catch (err) { if (aliveRef.current && selectedRef.current === target) setError(readableError(err)); }
    finally { busyRef.current = false; if (aliveRef.current) setBusy(false); onBusyChange(false); }
  }
  async function update(status: "active" | "closed", withMessage: boolean) {
    if (!selectedHandoff || busyRef.current || loading || selectedHandoff.status === "closed") return;
    const target = selectedHandoff;
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
      if (withMessage && drafts.get(target.id) === originalDraft) { drafts.delete(target.id); if (aliveRef.current && selectedRef.current === target.sessionId) setMessage(""); }
      if (!aliveRef.current) return;
      setSavedHandoffs(current => ({ ...current, [target.id]: result.handoff }));
      setNotice(status === "closed" ? "Обращение завершено." : withMessage ? "Ответ сохранён и доступен клиенту." : "Обращение принято в работу.");
      await reloadSelected(target.sessionId);
    } catch (err) { if (aliveRef.current && selectedRef.current === target.sessionId) setError(readableError(err)); }
    finally { busyRef.current = false; if (aliveRef.current) setBusy(false); onBusyChange(false); }
  }

  return <section className={`collection-page ${styles.workbench}`}>
    <div className={styles.toolbar}><div><h2>Разговоры контакт-центра</h2><p>Наблюдайте за AI и подключайтесь к нужному клиенту.</p></div><span className={styles.sync} role="status"><RefreshCw size={13} />{syncIssue ? "Синхронизация временно недоступна" : lastSync ? `Обновление каждые 2 с · ${time(lastSync)}` : "Подключаем обновления…"}</span></div>
    <div className={styles.filters}>{(["all", "ai", "waiting", "active", "closed"] as Filter[]).map(value => <button key={value} type="button" className={filter === value ? styles.filterActive : ""} onClick={() => setFilter(value)} disabled={busy}>{value === "all" ? "Все" : statusNames[value]}<span>{value === "all" ? rows.length : rows.filter(row => row.status === value).length}</span></button>)}</div>
    <div className={styles.layout}>
      <aside className={styles.list}><label className={styles.search}><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти разговор" aria-label="Поиск разговоров" /></label><div className={styles.rows}>{!filtered.length ? <p className={styles.emptyList}>По этому фильтру разговоров нет.</p> : filtered.map(row => <button type="button" key={row.id} className={`${styles.row} ${row.id === selectedSessionId ? styles.rowSelected : ""}`} disabled={busy} onClick={() => choose(row.id)}><span className={styles.rowTop}><span className={styles.status} data-status={row.status}>{row.status === "ai" ? <AudioLines size={13} /> : <Headphones size={13} />}{statusNames[row.status]}</span><time>{time(row.updatedAt)}</time></span><strong>{row.title}</strong><small>{row.handoff ? queueNames[row.handoff.queue] ?? row.handoff.queue : row.status === "closed" ? "История разговора" : "AI ведёт разговор"}{row.turnCount !== null ? ` · ${row.turnCount} реплик` : ""}</small>{row.handoff && drafts.get(row.handoff.id)?.trim() && <span className={styles.draft}>Есть черновик</span>}</button>)}</div><small className={styles.listFootnote}>Показаны загруженные разговоры всех участников.</small></aside>
      <div className={styles.detail}>{!selected ? <EmptyState icon={<Headphones size={26} />} title="Выберите разговор" description="Слева — разговоры с AI, ожидающие и принятые обращения. Здесь появятся история и контекст клиента." /> : <>
        <header className={styles.detailHeader}><div><span className={styles.status} data-status={selected.status}>{statusNames[selected.status]}</span><h3>{selected.title}</h3></div><button className="button button-secondary button-small" disabled={busy} onClick={() => onOpen(selected.id)}>Открыть<ArrowRight size={14} /></button></header>
        <div className={styles.context}><div><small>Текущий вопрос</small><strong>{activeScenario ?? (selected.status === "closed" ? "Разговор завершён" : "Сценарий ещё не выбран")}</strong></div><div><small>Язык ответа</small><strong>{languageLabel(state?.language, state?.responseLanguages)}</strong></div>{selectedHandoff && <div className={styles.contextWide}><small>Причина передачи</small><span>{selectedHandoff.reason}</span></div>}{state?.pendingConfirmation && <div className={styles.consent}><ShieldCheck size={16} /><span><strong>Клиент ещё не подтвердил действие</strong>{state.pendingConfirmation.summary}</span></div>}</div>
        {selected.status === "ai" && <div className={styles.takeover}><span>AI ведёт разговор. Перехват остановит следующие ответы AI.</span><button className="button button-primary button-small" onClick={() => void takeOver()} disabled={busy || loading}>{busy ? <Spinner /> : <Headphones size={15} />}Взять разговор</button></div>}
        {notice && <div className={styles.notice} role="status"><CircleCheck size={16} />{notice}</div>}{error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}
        {loading ? <div className="inline-loading"><Spinner label="Загружаем разговор…" /></div> : <div className={styles.transcript} ref={transcriptRef} onScroll={() => { const node = transcriptRef.current; if (node) followTranscriptRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 70; }} aria-live="polite" aria-relevant="additions text">{!detail?.turns.length ? <p className={styles.emptyList}>Сохранённых реплик пока нет.</p> : detail.turns.map(turn => <div className={styles.turn} key={turn.id}>{turn.mode !== "operator" && turn.userText && <article data-speaker="client"><header><strong>Клиент</strong><time>{time(turn.createdAt)}</time></header><p dir="auto">{turn.userText}</p></article>}<article data-speaker={turn.mode === "operator" ? "operator" : "ai"}><header><strong>{turn.mode === "operator" ? "Оператор" : turn.trace.source === "operator" ? "Система" : "AI-ассистент"}</strong><time>{time(turn.createdAt)}</time></header><p dir="auto">{turn.assistantText}</p></article></div>)}</div>}
        {selectedHandoff && selectedHandoff.status !== "closed" && <>
          <div className={styles.voice}><OperatorVoiceControls sessionId={selected.id} role="supervisor" enabled={selectedHandoff.status === "active"} /></div>
          <div className={styles.compose}><label htmlFor="operator-message">Ответ клиенту</label><textarea id="operator-message" value={message} onChange={event => { const value = event.target.value; drafts.set(selectedHandoff.id, value); setMessage(value); setNotice(null); }} maxLength={2000} placeholder="Ответ появится в разговоре клиента" disabled={busy || loading} /><div>{selectedHandoff.status === "waiting" && <button className="button button-secondary button-small" onClick={() => void update("active", false)} disabled={busy || loading}>Принять в работу</button>}<button className="button button-primary button-small" disabled={busy || loading || !message.trim()} onClick={() => void update("active", true)}>{busy ? <Spinner /> : <MessageSquare size={14} />}Отправить</button><button className="button button-ghost button-small" disabled={busy || loading} onClick={() => void update("closed", !!message.trim())}><CircleCheck size={15} />{message.trim() ? "Ответить и завершить" : "Завершить"}</button></div></div>
        </>}
        {selected.status === "closed" && <div className={styles.notice}><CircleCheck size={16} />Завершено {dateTime(selected.updatedAt)}.{message.trim() && <textarea aria-label="Неотправленный черновик" value={message} readOnly rows={3} />}</div>}
      </>}</div>
    </div>
  </section>;
}
