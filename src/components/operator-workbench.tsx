"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, AudioLines, CircleCheck, Headphones, MessageSquare, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { Handoff, Scenario, Session, SessionDetail, SessionLive } from "@/lib/types";
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
type Row = { id: string; title: string; topic: string; status: Exclude<Filter, "all">; updatedAt: string; turnCount: number | null; handoff?: Handoff; live?: SessionLive | null };
const statusNames = { ai: "С AI", waiting: "Ждёт оператора", active: "У оператора", closed: "Завершён" };
const queueNames: Record<string, string> = { operator_general: "Общая линия", claims_team: "Страховые случаи", complaints_team: "Жалобы", medical_assistance_24_7: "Медицинская помощь", sales_team: "Оформление", technical_support: "Техническая помощь" };
const liveNames = { listening: "Микрофон клиента", processing: "AI обрабатывает", replying: "AI отвечает" };
function LiveBadge({ live }: { live: SessionLive }) { return <span className={styles.live} title="Активен голосовой разговор клиента с AI"><i aria-hidden="true" /><strong>LIVE</strong><span>{liveNames[live.phase]}</span></span>; }

function conversationTopic(session: Session, catalog: Scenario[], detail?: SessionDetail | null): string {
  const recent = detail?.session.id === session.id ? detail.turns : [];
  const candidates = [session.state.activeScenarioId,
    ...recent.slice().reverse().filter(turn => turn.trace.source !== "operator").flatMap(turn => turn.trace.scenarios.map(item => item.scenarioId)),
    ...session.state.pendingScenarioIds, ...session.state.suspendedScenarioIds, ...session.state.completedScenarioIds.slice().reverse()];
  for (const id of candidates) {
    const scenario = id && id !== "SC37" ? catalog.find(item => item.scenario_id === id) : null;
    if (scenario) return scenarioDisplayName(scenario.scenario_id, scenario.name);
  }
  // A fallback is the client's actual question, never a guessed insurance topic.
  // Pure social contact has no subject yet and must not become the call topic.
  const social = /^(?:(?:алло|здравствуйте|здравствуй|привет|добрый день|доброе утро|добрый вечер|сәлем|сәлеметсіз бе|сәлеметсіздер ме|merhaba|selam|hello|hi|iyi günler)[\s,.!?…]*)+$/iu;
  const question = [...recent.filter(turn => turn.mode !== "operator" && turn.trace.source !== "social").map(turn => turn.userText), session.title]
    .map(text => text.trim()).find(text => text && !social.test(text) && !/^(?:новый разговор|новое обращение)$/iu.test(text) && /[\p{L}]{3}/u.test(text));
  return question ? question.slice(0, 140) : "Тема пока не определена";
}

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
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const initialSelectionRef = useRef(false);
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
  if (detail && (!knownSessions.has(detail.session.id) || knownSessions.get(detail.session.id)!.version <= detail.session.version)) {
    const listed = knownSessions.get(detail.session.id);
    // Presence has its own clock; a same-version detail must not conceal the
    // newest heartbeat or expiry delivered by the list refresh.
    knownSessions.set(detail.session.id, { ...detail.session, live: listed ? listed.live : detail.session.live });
  }
  const rows: Row[] = [...knownSessions.values()].map((session): Row => {
    const handoff = bySession.get(session.id);
    return { id: session.id, title: session.title || "Новый разговор", topic: conversationTopic(session, catalog, detail), updatedAt: session.updatedAt, turnCount: session.turnCount, handoff,
      live: session.state.status === "active" && session.live && Date.parse(session.live.expiresAt) > presenceNow ? session.live : null,
      status: session.state.status === "closed" ? "closed" : handoff && handoff.status !== "closed" ? handoff.status : session.state.status === "handoff" ? "waiting" : "ai" };
  });
  for (const h of bySession.values()) if (!knownSessions.has(h.sessionId)) rows.push({ id: h.sessionId, title: h.reason || "Обращение оператору", topic: h.reason || "Тема пока не определена", updatedAt: h.updatedAt, turnCount: null, handoff: h, status: h.status });
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const selected = rows.find(row => row.id === selectedSessionId);
  const selectedHandoff = selected?.handoff;
  const filtered = rows.filter(row => (filter === "all" || row.status === filter) && `${row.topic} ${row.title} ${row.id} ${row.handoff?.queue ?? ""}`.toLocaleLowerCase("ru").includes(search.trim().toLocaleLowerCase("ru")));
  const state = detail?.session.state;

  useEffect(() => {
    if (initialSelectionRef.current || !rows.length) return;
    initialSelectionRef.current = true;
    const initial = rows.find(row => row.status === "waiting") ?? rows.find(row => row.live) ?? rows[0];
    selectedRef.current = initial.id; setSelectedSessionId(initial.id);
  }, [rows]);

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
    const poll = setInterval(() => { setPresenceNow(Date.now()); void refresh(); }, 2000);
    const visible = () => { if (document.visibilityState === "visible") { setPresenceNow(Date.now()); void refresh(); } };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [onChanged]);

  function choose(id: string) {
    if (busyRef.current || selectedRef.current === id) return;
    initialSelectionRef.current = true; selectedRef.current = id; setDetail(null); setLoading(true); setSelectedSessionId(id);
  }
  async function reloadSelected(sessionId: string) {
    try {
      await onChanged();
      const updated = await api<SessionDetail>(`/api/sessions/${sessionId}`);
      if (aliveRef.current && selectedRef.current === sessionId) setDetail(updated);
    } catch { if (aliveRef.current && selectedRef.current === sessionId) setError("Изменение сохранено. Историю пока не удалось обновить; повторять действие не нужно."); }
  }
  async function takeOver(): Promise<boolean> {
    if (!selected || selected.status === "closed" || busyRef.current || loading) return false;
    const target = selected.id;
    const key = `takeover:${target}`;
    const requestId = requests.get(key) ?? crypto.randomUUID();
    requests.set(key, requestId);
    busyRef.current = true; setBusy(true); onBusyChange(true); setError(null); setNotice(null);
    try {
      const result = await api<{ handoff: Handoff; sessionId: string }>(`/api/sessions/${target}/takeover`, { method: "POST", body: JSON.stringify({ requestId }) });
      requests.delete(key);
      if (!aliveRef.current) return false;
      setSavedHandoffs(current => ({ ...current, [result.handoff.id]: result.handoff }));
      setNotice("Вы приняли разговор. AI остановлен; можно ответить текстом или подключить свой голос.");
      await reloadSelected(target);
      return aliveRef.current && selectedRef.current === target;
    } catch (err) { if (aliveRef.current && selectedRef.current === target) setError(readableError(err)); return false; }
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
    <div className={styles.toolbar}><div className={styles.overview}><span><strong>{rows.filter(row => row.live).length}</strong> LIVE</span><span><strong>{rows.filter(row => row.status === "waiting").length}</strong> ожидают</span><span><strong>{rows.length}</strong> диалогов</span></div><span className={styles.sync} role="status"><RefreshCw size={13} />{syncIssue ? "Синхронизация временно недоступна" : lastSync ? `Обновление каждые 2 с · ${time(lastSync)}` : "Подключаем обновления…"}</span></div>
    <div className={styles.filters}>{(["all", "ai", "waiting", "active", "closed"] as Filter[]).map(value => <button key={value} type="button" className={filter === value ? styles.filterActive : ""} onClick={() => setFilter(value)} disabled={busy}>{value === "all" ? "Все" : statusNames[value]}<span>{value === "all" ? rows.length : rows.filter(row => row.status === value).length}</span></button>)}</div>
    <div className={styles.layout}>
      <aside className={styles.list}><label className={styles.search}><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти разговор" aria-label="Поиск разговоров" /></label><div className={styles.rows}>{!filtered.length ? <p className={styles.emptyList}>По этому фильтру разговоров нет.</p> : filtered.map(row => <button type="button" key={row.id} className={`${styles.row} ${row.id === selectedSessionId ? styles.rowSelected : ""}`} disabled={busy} onClick={() => choose(row.id)}><span className={styles.rowTop}><span className={styles.status} data-status={row.status}>{row.status === "ai" ? <AudioLines size={13} /> : <Headphones size={13} />}{statusNames[row.status]}</span><time>{time(row.updatedAt)}</time></span>{row.live && <LiveBadge live={row.live} />}<strong>{row.topic}</strong><small>{row.handoff ? queueNames[row.handoff.queue] ?? row.handoff.queue : row.status === "closed" ? "История разговора" : "AI ведёт разговор"}{row.turnCount !== null ? ` · ${row.turnCount} реплик` : ""}</small>{row.handoff && drafts.get(row.handoff.id)?.trim() && <span className={styles.draft}>Есть черновик</span>}<span className={styles.openRow}>Открыть диалог<ArrowRight size={14} /></span></button>)}</div><small className={styles.listFootnote}>Показаны загруженные разговоры всех участников.</small></aside>
      <div className={styles.detail}>{!selected ? <EmptyState icon={<Headphones size={26} />} title="Выберите разговор" description="Слева — разговоры с AI, ожидающие и принятые обращения. Здесь появятся история и контекст клиента." /> : <>
        <header className={styles.detailHeader}><div><span className={styles.status} data-status={selected.status}>{statusNames[selected.status]}</span><h3>{selected.topic}</h3>{selected.live && <LiveBadge live={selected.live} />}</div><button className="button button-secondary button-small" disabled={busy} onClick={() => onOpen(selected.id)}>Детали<ArrowRight size={14} /></button></header>
        <div className={styles.context}><div><small>Линия</small><strong>{selectedHandoff ? queueNames[selectedHandoff.queue] ?? selectedHandoff.queue : "AI-ассистент"}</strong></div><div><small>Язык ответа</small><strong>{languageLabel(state?.language, state?.responseLanguages)}</strong></div>{selectedHandoff && <div className={styles.contextWide}><small>Причина передачи</small><span>{selectedHandoff.reason}</span></div>}{state?.pendingConfirmation && <div className={styles.consent}><ShieldCheck size={16} /><span><strong>Клиент ещё не подтвердил действие</strong>{state.pendingConfirmation.summary}</span></div>}</div>
        {(selected.status === "ai" || selected.status === "waiting") && <div className={styles.takeover}><span>Нужна только переписка?</span><button className="button button-secondary button-small" onClick={() => void takeOver()} disabled={busy || loading}>{busy ? <Spinner /> : <Headphones size={15} />}Принять в чат</button></div>}
        {notice && <div className={styles.notice} role="status"><CircleCheck size={16} />{notice}</div>}{error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}
        {selected.status !== "closed" && <div className={styles.voice}><OperatorVoiceControls key={selected.id} sessionId={selected.id} role="supervisor" enabled conversationTopic={selected.topic} prepareCall={selected.status === "ai" || selected.status === "waiting" ? takeOver : undefined} /></div>}{loading ? <div className="inline-loading"><Spinner label="Загружаем разговор…" /></div> : <div className={styles.transcript} ref={transcriptRef} onScroll={() => { const node = transcriptRef.current; if (node) followTranscriptRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 70; }} aria-live="polite" aria-relevant="additions text">{!detail?.turns.length ? <p className={styles.emptyList}>Сохранённых реплик пока нет.</p> : detail.turns.map(turn => <div className={styles.turn} key={turn.id}>{turn.mode !== "operator" && turn.userText && <article data-speaker="client"><header><strong>Клиент</strong><time>{time(turn.createdAt)}</time></header><p dir="auto">{turn.userText}</p></article>}<article data-speaker={turn.mode === "operator" ? "operator" : "ai"}><header><strong>{turn.mode === "operator" ? "Оператор" : turn.trace.source === "operator" ? "Система" : "AI-ассистент"}</strong><time>{time(turn.createdAt)}</time></header><p dir="auto">{turn.assistantText}</p></article></div>)}</div>}
        {selectedHandoff && selectedHandoff.status !== "closed" && <>

          <div className={styles.compose}><label htmlFor="operator-message">Ответ клиенту</label><textarea id="operator-message" value={message} onChange={event => { const value = event.target.value; drafts.set(selectedHandoff.id, value); setMessage(value); setNotice(null); }} maxLength={2000} placeholder="Ответ появится в разговоре клиента" disabled={busy || loading} /><div>{selectedHandoff.status === "waiting" && <button className="button button-secondary button-small" onClick={() => void update("active", false)} disabled={busy || loading}>Принять в работу</button>}<button className="button button-primary button-small" disabled={busy || loading || !message.trim()} onClick={() => void update("active", true)}>{busy ? <Spinner /> : <MessageSquare size={14} />}Отправить</button><button className="button button-ghost button-small" disabled={busy || loading} onClick={() => void update("closed", !!message.trim())}><CircleCheck size={15} />{message.trim() ? "Ответить и завершить" : "Завершить"}</button></div></div>
        </>}
        {selected.status === "closed" && <div className={styles.notice}><CircleCheck size={16} />Завершено {dateTime(selected.updatedAt)}.{message.trim() && <textarea aria-label="Неотправленный черновик" value={message} readOnly rows={3} />}</div>}
      </>}</div>
    </div>
  </section>;
}
