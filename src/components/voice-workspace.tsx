"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, CircleHelp, Clock3, GitBranch, Headphones, History, Languages, LockKeyhole, LogOut, MessageSquare, Mic, MicOff, Plus, RefreshCw, Send, ShieldCheck, Square, Volume2, VolumeX, X } from "lucide-react";
import type { Role, SessionDetail, Turn } from "@/lib/types";
import { createAudioPlayback } from "@/lib/audio-playback";
import { CatalogView, HistoryView, OperatorsView, TracePanel } from "./workspace-panels";
import { SupervisorDashboard } from "./supervisor-tools";
import { api, ApiError, type Bootstrap, duration, ErrorNotice, languageLabel, Logo, readableError, sessionStatus, Spinner, time, type WorkspaceView } from "./workspace-ui";

type Phase = "requesting-mic" | "recording" | "transcribing" | "routing" | "synthesizing" | null;
const MAX_RECORDING_MS = 45_000;
const MAX_AUDIO_BYTES = 3_000_000;
const SESSION_KEY = "dir-echoes:last-session";
const viewCopy: Record<WorkspaceView, { title: string; subtitle: string }> = {
  conversation: { title: "Рабочая линия", subtitle: "Слушаем обращение. Находим сценарий. Помогаем решить вопрос." },
  history: { title: "История разговоров", subtitle: "Все обращения, решения и контекст. Продолжайте с места остановки." },
  catalog: { title: "Каталог сценариев", subtitle: "Доступные маршруты, условия и действия из подключённого каталога." },
  operators: { title: "Очередь оператора", subtitle: "Обращения, которым нужно внимание человека. Весь контекст уже здесь." },
  supervision: { title: "Контроль качества", subtitle: "Ручная проверка маршрутов, ошибки исполнения и версии каталога." },
};

export function VoiceWorkspace() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<WorkspaceView>("conversation");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<Phase>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [loadingSession, setLoadingSession] = useState(false);
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [audioLoadingId, setAudioLoadingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRecordingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const speechSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const sessionChangeRef = useRef(false);
  const refreshingRef = useRef(false);
  const recordingBusyRef = useRef(false);
  const autoSpeakRef = useRef(true);
  const operatorDraftsRef = useRef(new Map<string, string>());
  const operatorRequestsRef = useRef(new Map<string, string>());
  const pendingRequestRef = useRef<{ sessionId: string; text: string; mode: "text" | "voice"; requestId: string } | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const helpModalRef = useRef<HTMLElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<SessionDetail | null>(null);
  const mountedRef = useRef(true);

  const rememberSession = useCallback((value: SessionDetail) => {
    detailRef.current = value;
    setDetail(value);
    setSelectedTurnId(value.turns.at(-1)?.id ?? null);
    try { localStorage.setItem(SESSION_KEY, value.session.id); } catch { /* Storage may be unavailable in private browsing. */ }
    setBootstrap(current => current ? { ...current, sessions: [value.session, ...current.sessions.filter(s => s.id !== value.session.id)] } : current);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const value = await api<Bootstrap>("/api/bootstrap");
    setBootstrap(value);
    return value;
  }, []);

  const initialize = useCallback(async () => {
    operatorDraftsRef.current.clear(); operatorRequestsRef.current.clear();
    setBooting(true); setError(null); setBootstrap(null); setDetail(null); detailRef.current = null; setSelectedTurnId(null);
    try {
      const auth = await api<{ authenticated: boolean; role?: Role }>("/api/auth");
      setAuthenticated(auth.authenticated);
      if (auth.authenticated) {
        await refreshBootstrap();
        let savedId: string | null = null;
        try { savedId = localStorage.getItem(SESSION_KEY); } catch { /* Optional convenience only. */ }
        if (savedId) {
          try { rememberSession(await api<SessionDetail>(`/api/sessions/${encodeURIComponent(savedId)}`)); }
          catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              try { localStorage.removeItem(SESSION_KEY); } catch { /* Optional convenience only. */ }
            } else if (err instanceof ApiError && err.status === 401) {
              setAuthenticated(false); setBootstrap(null); setDraft(""); setError(readableError(err));
            } else setError("Последний разговор не удалось открыть. Он остаётся в истории — попробуйте открыть его ещё раз.");
          }
        }
      } else { setDraft(""); pendingRequestRef.current = null; }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { setAuthenticated(false); setBootstrap(null); setDraft(""); pendingRequestRef.current = null; }
      setError(readableError(err));
    } finally { setBooting(false); }
  }, [refreshBootstrap, rememberSession]);

  useEffect(() => {
    mountedRef.current = true;
    void initialize();
    return () => {
      mountedRef.current = false;
      speechSequenceRef.current += 1;
      cancelRecordingRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
      audioRef.current?.pause();
      audioAbortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [initialize]);

  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [detail?.turns.length, phase, view]);
  useEffect(() => {
    if (!authenticated || detail?.session.state.status !== "handoff") return;
    let stopped = false;
    const poll = setInterval(async () => {
      if (document.visibilityState !== "visible" || submittingRef.current || phase) return;
      const sessionId = detailRef.current?.session.id;
      if (!sessionId) return;
      try {
        const updated = await api<SessionDetail>(`/api/sessions/${sessionId}`);
        if (!stopped && detailRef.current?.session.id === sessionId && (updated.session.version !== detailRef.current.session.version || updated.turns.length !== detailRef.current.turns.length)) {
          rememberSession(updated);
          await refreshBootstrap();
        }
      } catch { /* A manual refresh remains available when polling cannot reach the server. */ }
    }, 5000);
    return () => { stopped = true; clearInterval(poll); };
  }, [authenticated, detail?.session.state.status, phase, refreshBootstrap, rememberSession]);
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
      if (event.key === "Tab") {
        const items = helpModalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); helpButtonRef.current?.focus(); };
  }, [helpOpen]);

  function stopAudio() {
    speechSequenceRef.current += 1;
    audioAbortRef.current?.abort(); audioAbortRef.current = null;
    audioRef.current?.pause(); audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setPlayingTurnId(null); setAudioLoadingId(null);
    setPhase(current => current === "synthesizing" ? null : current);
  }

  function handleError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) { stopAudio(); setAuthenticated(false); setBootstrap(null); setDetail(null); detailRef.current = null; setDraft(""); pendingRequestRef.current = null; operatorDraftsRef.current.clear(); operatorRequestsRef.current.clear(); }
    setError(readableError(err));
  }

  async function playSpeech(sessionId: string, turn: Turn, cycleStartedAt?: number) {
    if (!mountedRef.current || detailRef.current?.session.id !== sessionId || sessionChangeRef.current) return;
    stopAudio();
    const sequence = speechSequenceRef.current;
    const controller = new AbortController();
    audioAbortRef.current = controller;
    setAudioLoadingId(turn.id); setPhase("synthesizing");
    const synthesisStartedAt = performance.now();
    try {
      const response = await fetch("/api/speech", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, turnId: turn.id }), signal: controller.signal });
      const reportedFirstByte = response.headers.get("X-TTS-First-Byte-Ms");
      const firstByteMs = reportedFirstByte !== null && Number.isFinite(Number(reportedFirstByte)) ? Number(reportedFirstByte) : performance.now() - synthesisStartedAt;
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new ApiError(typeof data?.error === "string" ? data.error : data?.error?.message ?? "Озвучивание сейчас недоступно. Текст ответа сохранён.", response.status);
      }
      if (sequence !== speechSequenceRef.current || controller.signal.aborted || detailRef.current?.session.id !== sessionId) return;
      const lastPlaybackCached = response.headers.get("X-Audio-Cached") === "true";
      setDetail(current => {
        if (!current || current.session.id !== sessionId) return current;
        const updated = { ...current, turns: current.turns.map(item => item.id === turn.id ? { ...item, trace: { ...item.trace, timings: { ...item.trace.timings, lastPlaybackCached } } } : item) };
        detailRef.current = updated;
        return updated;
      });
      const playback = await createAudioPlayback(response, controller.signal, () => {
        if (sequence !== speechSequenceRef.current || controller.signal.aborted) return;
        setError("Аудиопоток прервался. Текст ответа сохранён."); stopAudio();
      });
      const { audio, url } = playback;
      if (sequence !== speechSequenceRef.current || controller.signal.aborted || detailRef.current?.session.id !== sessionId) { audio.pause(); URL.revokeObjectURL(url); return; }
      audioUrlRef.current = url;
      audioRef.current = audio;
      audio.onended = () => {
        if (sequence !== speechSequenceRef.current || detailRef.current?.session.id !== sessionId) return;
        setPlayingTurnId(null); audioRef.current = null;
        URL.revokeObjectURL(url); audioUrlRef.current = null;
      };
      audio.onerror = () => { if (sequence === speechSequenceRef.current) { setError("Браузер не смог воспроизвести ответ. Текст сохранён; попробуйте воспроизвести его ещё раз."); stopAudio(); } };
      let firstPlaybackRecorded=false;
      audio.onplaying = () => {
        if (!mountedRef.current || sequence !== speechSequenceRef.current || detailRef.current?.session.id !== sessionId) { audio.pause(); return; }
        setPlayingTurnId(turn.id); setAudioLoadingId(null);
        if (cycleStartedAt != null && !firstPlaybackRecorded) {
          firstPlaybackRecorded=true;
          const playbackMs = performance.now() - cycleStartedAt;
          void api(`/api/sessions/${sessionId}/metrics`, { method: "POST", body: JSON.stringify({ turnId: turn.id, playbackMs, ttsFirstByteMs: firstByteMs }) }).then(() => {
            setDetail(current => {
              if (!current || current.session.id !== sessionId) return current;
              const updated = { ...current, turns: current.turns.map(item => item.id === turn.id ? { ...item, trace: { ...item.trace, timings: { ...item.trace.timings, playback: playbackMs, ttsFirstByte: firstByteMs } } } : item) };
              detailRef.current = updated;
              return updated;
            });
          }).catch(() => { if (mountedRef.current && sequence === speechSequenceRef.current && detailRef.current?.session.id === sessionId) setError("Ответ воспроизведён, но время воспроизведения не удалось сохранить."); });
        }
      };
      await playback.start();
    } catch (err) {
      if (controller.signal.aborted || sequence !== speechSequenceRef.current) return;
      stopAudio();
      if (err instanceof ApiError && err.status === 401) { handleError(err); return; }
      setError(err instanceof DOMException && err.name === "NotAllowedError" ? "Браузер заблокировал автоматический звук. Нажмите «Слушать ответ» под сообщением." : readableError(err));
    } finally {
      if (sequence === speechSequenceRef.current) { setPhase(current => current === "synthesizing" ? null : current); setAudioLoadingId(null); }
    }
  }

  async function ensureSession() {
    if (detailRef.current) return detailRef.current;
    const created = await api<SessionDetail>("/api/sessions", { method: "POST", body: "{}" });
    rememberSession(created);
    return created;
  }

  async function sendTurn(text: string, mode: "text" | "voice", sttMs?: number, cycleStartedAt = performance.now()) {
    if (!text.trim() || submittingRef.current || sessionChangeRef.current || operatorBusy) return;
    if (text.trim().length > 3000) { setError("Сообщение слишком длинное. Сократите его до 3000 символов."); setPhase(null); return; }
    if (detailRef.current?.session.state.status === "closed") { setError("Этот разговор завершён. Нажмите «Новый разговор», чтобы продолжить с новым обращением."); setPhase(null); return; }
    submittingRef.current = true;
    setPhase("routing"); setError(null); stopAudio();
    let result: SessionDetail | null = null;
    try {
      const active = await ensureSession();
      const previous = pendingRequestRef.current;
      const requestId = previous?.sessionId === active.session.id && previous.text === text.trim() && previous.mode === mode ? previous.requestId : crypto.randomUUID();
      pendingRequestRef.current = { sessionId: active.session.id, text: text.trim(), mode, requestId };
      result = await api<SessionDetail>(`/api/sessions/${active.session.id}/turn`, { method: "POST", body: JSON.stringify({ text: text.trim(), requestId, mode, ...(sttMs != null ? { sttMs } : {}) }) });
      rememberSession(result); pendingRequestRef.current = null;
      setDraft(current => current.trim() === text.trim() ? "" : current);
      void refreshBootstrap().catch(() => { /* The saved response is authoritative; the refresh button can retry summaries. */ });
    } catch (err) { handleError(err); } finally { submittingRef.current = false; setPhase(null); }
    if (result && autoSpeakRef.current && detailRef.current?.session.id === result.session.id && !sessionChangeRef.current && result.turns.length && result.session.state.status !== "handoff") await playSpeech(result.session.id, result.turns.at(-1)!, cycleStartedAt);
    textareaRef.current?.focus();
  }

  async function transcribe(blob: Blob, mime: string, cycleStartedAt: number) {
    setPhase("transcribing"); setError(null);
    try {
      const data = new FormData();
      const extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      data.append("audio", new File([blob], `voice-message.${extension}`, { type: mime }));
      const result = await api<{ text: string; language: string; elapsedMs: number }>("/api/transcribe", { method: "POST", body: data });
      if (!result.text.trim()) throw new Error("Речь не распознана. Попробуйте записать ещё раз или введите обращение текстом.");
      setDraft(result.text);
      await sendTurn(result.text, "voice", result.elapsedMs, cycleStartedAt);
    } catch (err) { handleError(err); setPhase(null); }
  }

  async function startRecording() {
    if (phase || sessionChangeRef.current || recordingBusyRef.current || submittingRef.current || operatorBusy || detailRef.current?.session.state.status === "closed") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("В этом браузере запись недоступна. Откройте приложение по HTTPS в современном браузере или используйте текстовый ввод."); return; }
    recordingBusyRef.current = true;
    stopAudio(); setError(null); setPhase("requesting-mic");
    cancelRecordingRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!mountedRef.current || cancelRecordingRef.current) { stream.getTracks().forEach(track => track.stop()); recordingBusyRef.current = false; return; }
      streamRef.current = stream;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(value => MediaRecorder.isTypeSupported(value));
      if (!mime) throw new Error("Браузер не поддерживает формат записи для распознавания. Используйте Chrome, Edge, Safari или текстовый ввод.");
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let size = 0;
      let oversized = false;
      recorder.ondataavailable = event => {
        if (event.data.size) { chunks.push(event.data); size += event.data.size; }
        if (size > MAX_AUDIO_BYTES && recorder.state === "recording") { oversized = true; recorder.stop(); }
      };
      recorder.onerror = () => { cancelRecordingRef.current = true; setError("Запись прервалась. Проверьте микрофон или используйте текстовый ввод."); if (recorder.state === "recording") recorder.stop(); };
      recorder.onstop = () => {
        const stoppedAt = performance.now();
        if (timerRef.current) clearInterval(timerRef.current);
        if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null; recorderRef.current = null;
        recordingBusyRef.current = false;
        if (!mountedRef.current) return;
        if (cancelRecordingRef.current) { setPhase(null); return; }
        if (oversized || size > MAX_AUDIO_BYTES) { setPhase(null); setError("Запись превысила 3 МБ. Запишите более короткое обращение или используйте текстовый ввод."); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        if (blob.size < 100) { setPhase(null); setError("Запись получилась слишком короткой. Проверьте микрофон и запишите обращение ещё раз."); return; }
        void transcribe(blob, recorder.mimeType || mime || "audio/webm", stoppedAt);
      };
      recorder.start(250); setRecordingSeconds(0); setPhase("recording");
      const startedAt = performance.now();
      timerRef.current = setInterval(() => setRecordingSeconds(Math.floor((performance.now() - startedAt) / 1000)), 250);
      maxTimerRef.current = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, MAX_RECORDING_MS);
    } catch (err) {
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
      recordingBusyRef.current = false;
      setPhase(null);
      const name = err instanceof DOMException ? err.name : "";
      setError(name === "NotAllowedError" ? "Нет доступа к микрофону. Разрешите его в настройках браузера или введите обращение текстом." : name === "NotFoundError" ? "Микрофон не найден. Подключите его или используйте текстовый ввод." : `Не удалось включить микрофон. ${readableError(err)}`);
    }
  }

  function stopRecording(cancel = false) {
    cancelRecordingRef.current = cancel;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else if (phase === "requesting-mic") setPhase(null);
  }

  async function newSession() {
    if (phase || sessionChangeRef.current || submittingRef.current || recordingBusyRef.current || operatorBusy) return;
    sessionChangeRef.current = true;
    stopAudio(); setLoadingSession(true); setError(null); setView("conversation");
    try {
      const result = await api<SessionDetail>("/api/sessions", { method: "POST", body: "{}" });
      rememberSession(result); setDraft(""); pendingRequestRef.current = null;
      void refreshBootstrap().catch(() => {});
    } catch (err) { handleError(err); } finally { sessionChangeRef.current = false; setLoadingSession(false); }
    textareaRef.current?.focus();
  }

  async function openSession(id: string) {
    if (phase || sessionChangeRef.current || submittingRef.current || recordingBusyRef.current || operatorBusy) return;
    sessionChangeRef.current = true;
    stopAudio(); setLoadingSession(true); setError(null);
    try {
      rememberSession(await api<SessionDetail>(`/api/sessions/${id}`));
      setDraft(""); pendingRequestRef.current = null; setView("conversation");
    } catch (err) { handleError(err); } finally { sessionChangeRef.current = false; setLoadingSession(false); }
  }

  async function refresh() {
    if (refreshingRef.current || phase || sessionChangeRef.current || submittingRef.current || operatorBusy) return;
    const sessionId = detailRef.current?.session.id;
    refreshingRef.current = true; setRefreshing(true); setError(null);
    try {
      await refreshBootstrap();
      if (sessionId) {
        const updated = await api<SessionDetail>(`/api/sessions/${sessionId}`);
        if (!sessionChangeRef.current && detailRef.current?.session.id === sessionId && updated.session.version >= detailRef.current.session.version) rememberSession(updated);
      }
    } catch (err) { if (!sessionChangeRef.current && detailRef.current?.session.id === sessionId) handleError(err); }
    finally { refreshingRef.current = false; setRefreshing(false); }
  }

  async function logout() {
    if (phase || sessionChangeRef.current || submittingRef.current || recordingBusyRef.current || operatorBusy) return;
    try {
      await api("/api/auth", { method: "DELETE" });
      stopAudio(); setAuthenticated(false); setBootstrap(null); setDetail(null); detailRef.current = null; setDraft(""); setView("conversation");
      operatorDraftsRef.current.clear(); operatorRequestsRef.current.clear(); pendingRequestRef.current = null;
      try { localStorage.removeItem(SESSION_KEY); } catch { /* Optional convenience only. */ }
    } catch (err) { handleError(err); }
  }

  function useExample(text: string) {
    if (detailRef.current?.session.state.status === "closed") { setView("conversation"); setError("Этот разговор завершён. Создайте новый разговор, затем выберите пример."); return; }
    setView("conversation"); setDraft(text); requestAnimationFrame(() => textareaRef.current?.focus());
  }

  if (booting) return <main className="boot-screen"><Logo /><Spinner label="Подключаем рабочее пространство…" /></main>;
  if (!authenticated) return <Login onSuccess={initialize} initialError={error} />;
  if (!bootstrap) return <main className="boot-screen"><Logo /><ErrorNotice message={error || "Не удалось загрузить рабочее пространство."} /><button className="button button-primary" onClick={() => void initialize()}><RefreshCw size={16} />Повторить подключение</button><button className="button button-ghost" onClick={() => void logout()}>Выйти</button></main>;

  const busy = phase !== null || loadingSession || operatorBusy;
  const voiceBusy = phase && phase !== "recording";
  const currentSession = detail?.session;
  const canSendText = currentSession?.state.status !== "closed" && bootstrap.configured.database && (bootstrap.configured.ai || currentSession?.state.status === "handoff");
  const pendingCount = bootstrap.handoffs.filter(h => h.status !== "closed").length;
  const title = viewCopy[view];
  const exampleScenarios = bootstrap.catalog.filter(s => s.examples.ru.length > 0).slice(0, 3);
  const phaseLabel = phase === "transcribing" ? "Распознаём речь" : phase === "routing" ? "Выбираем сценарий и готовим ответ" : phase === "synthesizing" ? "Подготавливаем голосовой ответ" : "Запрашиваем доступ к микрофону";

  return <div className="app-shell">
    <aside className="sidebar"><div className="sidebar-brand"><Logo /></div><div className="workspace-label"><span className="workspace-avatar">DE</span><div>Контакт-центр<span>Рабочее пространство</span></div><span className="workspace-online" title="Рабочее пространство загружено" /></div>
      <div className="sidebar-section-label">РАБОТА С ОБРАЩЕНИЯМИ</div><nav className="primary-nav" aria-label="Основная навигация">
        <NavItem icon={<AudioLines size={19} />} label="Рабочая линия" active={view === "conversation"} disabled={busy} onClick={() => setView("conversation")} />
        <NavItem icon={<History size={19} />} label="История" count={bootstrap.sessions.length} active={view === "history"} disabled={busy} onClick={() => setView("history")} />
        <NavItem icon={<BookOpen size={19} />} label="Сценарии" active={view === "catalog"} disabled={busy} onClick={() => setView("catalog")} />
        {bootstrap.viewer.role === "supervisor" && <NavItem icon={<Headphones size={19} />} label="Оператор" count={pendingCount} active={view === "operators"} disabled={busy} onClick={() => setView("operators")} />}
        {bootstrap.viewer.role === "supervisor" && <NavItem icon={<ShieldCheck size={19} />} label="Качество" active={view === "supervision"} disabled={busy} onClick={() => setView("supervision")} />}
      </nav><div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><GitBranch size={18} /></span><strong>Голос. Контекст. Решение.</strong><p>Одна линия для обращений на русском и казахском.</p><span className="sidebar-languages">RU <span /> KZ</span></div><button ref={helpButtonRef} className="sidebar-help" onClick={() => setHelpOpen(true)}><CircleHelp size={18} />Как работать с линией<ChevronRight size={14} /></button><div className="sidebar-profile"><span className="profile-avatar">{bootstrap.viewer.role === "supervisor" ? "С" : "У"}</span><span><strong>{bootstrap.viewer.role === "supervisor" ? "Супервизор" : "Участник"}</strong><small>Защищённый доступ</small></span><button onClick={() => void logout()} disabled={busy} aria-label="Выйти" title="Выйти"><LogOut size={16} /></button></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><span>Контакт-центр</span><ChevronRight size={13} /><strong>{title.title}</strong></div><div className="topbar-right"><span className={`connection-status ${bootstrap.configured.database && bootstrap.configured.ai ? "" : "connection-warning"}`}><i />{bootstrap.configured.database && bootstrap.configured.ai ? "Система подключена" : "Требуется настройка"}</span><span className="topbar-divider" /><button className="icon-button" onClick={() => void refresh()} disabled={busy || refreshing} aria-label="Обновить данные" title="Обновить данные"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><span className="topbar-product">VOICE ROUTER <span>01</span></span></div></header>
      <main className={`main-content view-${view}`} id="main-content"><div className="page-heading"><div><div className="page-eyebrow"><span /> DIR ECHOES / VOICE OPERATIONS</div><h1>{title.title}</h1><p>{title.subtitle}</p></div><button className="button button-primary new-conversation" onClick={() => void newSession()} disabled={busy}>{loadingSession ? <Spinner /> : <Plus size={17} />}Новый разговор</button></div>
        <div className="stats-grid"><Stat label="Разговоров" value={bootstrap.stats.sessions} icon={<MessageSquare size={17} />} note="В вашем рабочем пространстве" /><Stat label="Обработано реплик" value={bootstrap.stats.turns} icon={<AudioLines size={17} />} note="С сохранённым результатом" /><Stat label="У оператора" value={bootstrap.stats.handoffs} icon={<Headphones size={17} />} note="Открытые обращения с контекстом" /><Stat label="Выбор маршрута" value={bootstrap.stats.turns ? duration(bootstrap.stats.medianRoutingMs) : "—"} icon={<GitBranch size={17} />} note="Медиана времени маршрутизации" /></div>
        {error && <div className="global-error"><ErrorNotice message={error} onDismiss={() => setError(null)} /></div>}
        {(!bootstrap.configured.ai || !bootstrap.configured.database) && <div className="configuration-notice"><ShieldCheck size={17} /><span>{!bootstrap.configured.database ? "Хранилище не подключено. Сохранение разговоров недоступно." : "AI-сервис не подключён. Обработка новых обращений пока недоступна."}</span></div>}
        {view === "conversation" ? <div className="conversation-layout"><section className="conversation-panel" aria-label="Разговор"><div className="conversation-heading"><span className="conversation-heading-icon"><AudioLines size={21} /></span><div className="conversation-title"><h2>{currentSession?.title || "Новый разговор"}</h2><span>{currentSession ? <><i className={`state-dot state-${currentSession.state.status}`} />{sessionStatus(currentSession.state.status)}<span className="dot-separator">·</span>{languageLabel(currentSession.state.language)}</> : <>Готовы к первому обращению<span className="dot-separator">·</span>RU / KZ</>}</span></div>{currentSession && <a href={`/api/sessions/${currentSession.id}/export`} download className="icon-button" aria-label="Скачать историю разговора в JSON" title="Скачать историю в JSON"><ArrowDownToLine size={18} /></a>}<button className={`icon-button ${autoSpeak ? "audio-enabled" : ""}`} onClick={() => { autoSpeakRef.current = !autoSpeakRef.current; setAutoSpeak(autoSpeakRef.current); if (!autoSpeakRef.current) stopAudio(); }} aria-label={autoSpeak ? "Выключить автоматическое озвучивание" : "Включить автоматическое озвучивание"} aria-pressed={autoSpeak} title={autoSpeak ? "Автоматическое озвучивание включено" : "Автоматическое озвучивание выключено"}>{autoSpeak ? <Volume2 size={18} /> : <VolumeX size={18} />}</button></div>
          <div className="conversation-body" aria-live="polite" aria-relevant="additions text">{loadingSession ? <div className="conversation-loading"><Spinner label="Открываем разговор…" /></div> : !detail?.turns.length ? <div className="conversation-empty"><div className="voice-orbit" aria-hidden="true"><div className="voice-orbit-ring" /><div className="voice-orbit-core"><AudioLines size={39} strokeWidth={1.45} /></div><span className="orbit-badge"><Check size={12} /></span></div><span className="empty-eyebrow">ГОТОВЫ СЛУШАТЬ</span><h2>С чего начнём разговор?</h2><p>Расскажите о своём вопросе голосом или текстом.<br className="desktop-break" />Маршрутизатор подберёт подходящий сценарий.</p><div className="starter-label">МОЖНО НАЧАТЬ С ФРАЗЫ ИЗ КАТАЛОГА</div><div className="conversation-starters">{exampleScenarios.map(s => <button disabled={busy} key={s.scenario_id} onClick={() => useExample(s.examples.ru[0])}><span>{s.examples.ru[0]}</span><ArrowRight size={15} /></button>)}</div><span className="language-support"><Languages size={14} />Русский и қазақша · язык определяется автоматически</span></div> : <div className="messages"><div className="conversation-date"><span>{new Date(detail.session.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</span></div>{detail.turns.map((turn, index) => <div className="turn-group" key={turn.id}>{turn.mode !== "operator" && turn.userText && <div className="message message-user"><div className="message-meta"><span>{bootstrap.viewer.role === "supervisor" ? "Клиент" : "Вы"}</span><time>{time(turn.createdAt)}</time>{turn.mode === "voice" && <Mic size={12} />}</div><div className="message-bubble">{turn.userText}</div></div>}<div className={`message message-assistant ${selectedTurnId === turn.id ? "message-selected" : ""}`}><span className="assistant-avatar">{turn.mode === "operator" ? <Headphones size={16} /> : <AudioLines size={17} />}</span><div className="assistant-message-content"><div className="message-meta"><strong>{turn.mode === "operator" ? "Оператор" : "DIR ECHOES"}</strong><span>{turn.mode === "operator" ? "Человек в диалоге" : turn.trace.source === "operator" ? "Система" : "AI-ассистент"}</span></div><div className="message-bubble">{turn.assistantText}</div><div className="message-actions"><button onClick={() => { if (playingTurnId === turn.id || audioLoadingId === turn.id) stopAudio(); else void playSpeech(detail.session.id, turn); }} disabled={busy && audioLoadingId !== turn.id} aria-label={playingTurnId === turn.id ? "Остановить озвучивание" : "Слушать ответ"}>{audioLoadingId === turn.id ? <Spinner /> : playingTurnId === turn.id ? <Square size={12} fill="currentColor" /> : <Volume2 size={13} />}{audioLoadingId === turn.id ? "Подготовка…" : playingTurnId === turn.id ? "Остановить" : "Слушать ответ"}</button><button className={selectedTurnId === turn.id ? "selected" : ""} onClick={() => setSelectedTurnId(turn.id)}><GitBranch size={13} />Решение {index + 1}<ChevronRight size={12} /></button><span className="message-duration"><Clock3 size={11} />{duration(turn.trace.timings.serverTotal)}</span></div></div></div></div>)}</div>}
          {phase && phase !== "recording" && phase !== "requesting-mic" && <div className="processing-message" role="status"><span className="assistant-avatar"><AudioLines size={17} /></span><Spinner label={phaseLabel} /></div>}<div ref={messageEndRef} /></div>
          {currentSession?.state.pendingConfirmation && <div className="conversation-confirmation"><ShieldCheck size={17} /><span>Перед выполнением операции нужно ваше подтверждение.</span></div>}
          {currentSession?.state.status === "handoff" && <div className="conversation-handoff"><Headphones size={17} /><span>Обращение передано оператору вместе с контекстом.</span><button onClick={() => void refresh()} disabled={busy || refreshing}>Проверить ответ</button></div>}
          <div className="composer"><div className={`voice-control ${phase === "recording" ? "is-recording" : ""}`}><div className="voice-control-copy"><span className={`voice-control-symbol ${phase === "recording" ? "recording-pulse" : ""}`}>{phase === "recording" ? <Mic size={20} /> : <AudioLines size={21} />}</span><div><strong>{phase === "recording" ? "Запись идёт" : voiceBusy ? phaseLabel : "Скажите — мы разберёмся"}</strong><span>{phase === "recording" ? `00:${String(recordingSeconds).padStart(2, "0")} / 00:45 · остановите, чтобы отправить` : "До 45 секунд · ответ озвучивается голосом AI"}</span></div></div><div className="voice-control-buttons">{phase === "recording" ? <><button className="icon-button" onClick={() => stopRecording(true)} aria-label="Отменить запись" title="Отменить запись"><X size={17} /></button><button className="button button-recording" onClick={() => stopRecording()}><Square size={13} fill="currentColor" />Отправить</button></> : phase === "synthesizing" ? <button className="button button-secondary button-small" onClick={stopAudio}><Square size={13} />Отменить звук</button> : <button className="button button-mic" onClick={() => void startRecording()} disabled={busy || currentSession?.state.status === "closed" || !bootstrap.configured.ai || !bootstrap.configured.database}>{voiceBusy ? <Spinner /> : <Mic size={16} />}{phase === "requesting-mic" ? "Доступ…" : "Начать запись"}</button>}</div></div>
          <p className="tiny muted">Используйте данные кейса. Не вводите и не произносите реальные персональные данные.</p>
          <form className="text-composer" onSubmit={event => { event.preventDefault(); if (!busy) void sendTurn(draft, "text"); }}><label className="visually-hidden" htmlFor="message-input">{currentSession?.state.status === "handoff" ? "Сообщение оператору" : "Текст обращения"}</label><textarea ref={textareaRef} id="message-input" placeholder={currentSession?.state.status === "closed" ? "Разговор завершён. Начните новый." : currentSession?.state.status === "handoff" ? "Сообщение оператору…" : "Или напишите обращение…"} value={draft} rows={1} maxLength={3000} disabled={busy || !canSendText} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void sendTurn(draft, "text"); } }} /><button className="send-button" type="submit" aria-label={currentSession?.state.status === "handoff" ? "Отправить сообщение оператору" : "Отправить обращение"} title="Отправить · Enter" disabled={busy || !draft.trim() || !canSendText}><ArrowRight size={20} /></button></form><div className="composer-footnote"><span><LockKeyhole size={11} />Разговор сохраняется в рабочем пространстве</span><span>Enter — отправить</span></div></div>
        </section><TracePanel detail={detail} catalog={bootstrap.catalog} selectedTurnId={selectedTurnId} onSelectTurn={setSelectedTurnId} isSupervisor={bootstrap.viewer.role === "supervisor"} /></div> : view === "history" ? <HistoryView sessions={bootstrap.sessions} onOpen={id => void openSession(id)} onNew={() => void newSession()} currentId={currentSession?.id} /> : view === "catalog" ? <CatalogView catalog={bootstrap.catalog} onExample={useExample} canEdit={bootstrap.viewer.role === "supervisor"} catalogHash={bootstrap.datasetHash} onCatalogChanged={refreshBootstrap} /> : view === "supervision" && bootstrap.viewer.role === "supervisor" ? <SupervisorDashboard catalog={bootstrap.catalog} onOpen={id => void openSession(id)} /> : <OperatorsView handoffs={bootstrap.handoffs} onChanged={refreshBootstrap} onOpen={id => void openSession(id)} drafts={operatorDraftsRef.current} requests={operatorRequestsRef.current} onBusyChange={setOperatorBusy} />}
        <footer className="page-footer"><span>DIR ECHOES <span>Гибридный голосовой маршрутизатор</span></span><span>Данные кейса на {bootstrap.businessDate} <span className="footer-dot">·</span> Каталог {bootstrap.datasetHash.slice(0, 8)}</span></footer>
      </main>
    </div>
    {helpOpen && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section ref={helpModalRef} className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close icon-button" autoFocus onClick={() => setHelpOpen(false)} aria-label="Закрыть справку"><X size={19} /></button><span className="empty-icon"><AudioLines size={26} /></span><span className="section-eyebrow">РАБОТА С ЛИНИЕЙ</span><h2 id="help-title">От обращения к действию</h2><ol><li><span>01</span><div><strong>Расскажите о вопросе</strong><p>Запишите до 45 секунд речи и остановите запись, чтобы отправить. Текстовый ввод доступен в том же разговоре.</p></div></li><li><span>02</span><div><strong>Следите за решением</strong><p>Справа показаны сценарий, объяснение выбора, параметры и выполненные действия. Ответьте на уточняющие вопросы.</p></div></li><li><span>03</span><div><strong>Подтвердите действие</strong><p>Маршрутизатор попросит подтверждение перед любым изменением данных или запросом внешнего действия. Если нужен человек, контекст будет передан оператору.</p></div></li></ol><p className="help-note">История сохраняется. Вернитесь к разговору из раздела «История». Голосовые ответы создаются AI.</p><button className="button button-primary" onClick={() => setHelpOpen(false)}>Понятно<ArrowRight size={16} /></button></section></div>}
  </div>;
}

function NavItem({ icon, label, active, disabled, count, onClick }: { icon: React.ReactNode; label: string; active: boolean; disabled: boolean; count?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-current={active ? "page" : undefined}>{icon}<span>{label}</span>{count != null && count > 0 && <span className="nav-count">{count}</span>}</button>;
}

function Stat({ label, value, icon, note }: { label: string; value: string | number; icon: React.ReactNode; note: string }) {
  return <div className="stat-card"><div className="stat-heading"><span>{label}</span>{icon}</div><strong>{value}</strong><small>{note}</small></div>;
}

function Login({ onSuccess, initialError }: { onSuccess: () => Promise<void>; initialError: string | null }) {
  const [code, setCode] = useState("");
  const [role, setRole] = useState<Role>("participant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!code.trim() || busy) return;
    setBusy(true); setError(null);
    try { await api("/api/auth", { method: "POST", body: JSON.stringify({ code: code.trim(), role }) }); setCode(""); await onSuccess(); } catch (err) { setError(readableError(err)); } finally { setBusy(false); }
  }
  return <main className="login-page"><section className="login-story"><Logo /><div className="login-story-main"><span className="login-eyebrow"><span />VOICE OPERATIONS PLATFORM</span><h1>Слышать запрос.<br />Понимать контекст.<br /><span>Находить решение.</span></h1><p>Гибридный голосовой маршрутизатор<br />для обращений на русском и казахском.</p><div className="login-flow"><span><Mic size={19} />Голос</span><i /><span><GitBranch size={19} />Сценарий</span><i /><span><Check size={19} />Действие</span></div></div><div className="login-story-footer"><span>DIR ECHOES</span><span>VOICE ROUTER / 01</span></div></section><section className="login-form-side"><div className="login-card"><span className="login-lock"><LockKeyhole size={24} /></span><span className="section-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2>Добро пожаловать</h2><p>Войдите, чтобы начать разговор<br />и работать с обращениями.</p><form onSubmit={submit}><fieldset className="login-role"><legend>Роль</legend><button type="button" className={role === "participant" ? "selected" : ""} onClick={() => setRole("participant")} disabled={busy}><MessageSquare size={16} />Участник</button><button type="button" className={role === "supervisor" ? "selected" : ""} onClick={() => setRole("supervisor")} disabled={busy}><Headphones size={16} />Супервизор</button></fieldset><label htmlFor="access-code">Код доступа</label><div className="login-code"><LockKeyhole size={17} /><input id="access-code" type="password" autoComplete="current-password" placeholder="Введите выданный код" value={code} onChange={e => setCode(e.target.value)} disabled={busy} required maxLength={200} /></div>{error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}<button className="button button-primary login-submit" type="submit" disabled={!code.trim() || busy}>{busy ? <Spinner label="Подключаемся…" /> : <>Войти в рабочее пространство<ArrowRight size={17} /></>}</button></form><div className="login-privacy"><ShieldCheck size={17} /><span>Доступ по коду. История разговоров<br />сохраняется в вашем пространстве.<br />Используйте данные кейса. Не вводите и не произносите реальные персональные данные.</span></div></div><div className="login-bottom">DIR ECHOES <span>Русский / Қазақша</span></div></section></main>;
}
