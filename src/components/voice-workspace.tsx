"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, ChevronRight, CircleHelp, GitBranch, Headphones, History, LockKeyhole, LogOut, Menu, MessageSquare, Mic, Moon, Phone, PhoneOff, Plus, RefreshCw, ShieldCheck, Square, Sun, Volume2, VolumeX, X } from "lucide-react";
import type { Role, SessionDetail, Turn } from "@/lib/types";
import { createAudioPlayback, createPersistentAudio, unlockAudioPlayback } from "@/lib/audio-playback";
import { useVoiceCall } from "@/lib/use-voice-call";
import { usePlaybackMeter } from "@/lib/use-playback-meter";
import { CatalogView, HistoryView, OperatorsView, TracePanel } from "./workspace-panels";
import { SupervisorDashboard } from "./supervisor-tools";
import { VoiceParticles } from "./voice-particles";
import { BackgroundStarfield } from "./background-starfield";
import { ConversationContext } from "./conversation-context";
import { ConversationThread } from "./conversation-thread";
import { OperatorVoiceControls } from "./operator-voice-controls";
import { api, ApiError, type Bootstrap, duration, ErrorNotice, readableError, sessionStatus, Spinner, type WorkspaceView } from "./workspace-ui";
import { BrandMark as Logo } from "./brand-mark";

type Phase = "transcribing" | "routing" | "synthesizing" | null;
const SESSION_KEY = "dir-echoes:last-session";
const THEME_KEY = "dir-echoes:theme";
const viewCopy: Record<WorkspaceView, { title: string; subtitle: string }> = {
  conversation: { title: "Разговор с AI", subtitle: "Говорите на удобном языке. Мы сохраним контекст разговора." },
  history: { title: "История разговоров", subtitle: "Все обращения, решения и контекст. Продолжайте с места остановки." },
  catalog: { title: "Каталог сценариев", subtitle: "Доступные маршруты, условия и действия из подключённого каталога." },
  operators: { title: "Live · Диалоги", subtitle: "Разговоры всех участников, состояние AI и подключение оператора." },
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
  const [loadingSession, setLoadingSession] = useState(false);
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [playingTurnId, setPlayingTurnId] = useState<string | null>(null);
  const [audioLoadingId, setAudioLoadingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const voiceGenerationRef = useRef(0);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const persistentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioAbortRef = useRef<AbortController | null>(null);
  const speechSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const sessionChangeRef = useRef(false);
  const refreshingRef = useRef(false);
  const autoSpeakRef = useRef(true);
  const operatorDraftsRef = useRef(new Map<string, string>());
  const operatorRequestsRef = useRef(new Map<string, string>());
  const pendingRequestRef = useRef<{ sessionId: string; text: string; mode: "text" | "voice"; requestId: string } | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const requestedTurnRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const traceToggleRef = useRef<HTMLButtonElement | null>(null);
  const helpModalRef = useRef<HTMLElement | null>(null);
  const helpButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<SessionDetail | null>(null);
  const mountedRef = useRef(true);
  const stopCallRef = useRef<() => void>(() => {});
  const playbackMeter = usePlaybackMeter();
  const voiceCall = useVoiceCall({
    paused: phase !== null || playingTurnId !== null || audioLoadingId !== null || loadingSession || operatorBusy || view !== "conversation" || helpOpen || !authenticated,
    onUtterance: (blob, mime, speechEndedAt) => transcribe(blob, mime, speechEndedAt),
    onError: err => { stopVoiceCall(); setError(readableError(err)); },
  });
  stopCallRef.current = stopVoiceCall;

  useEffect(() => {
    const applyPreference = () => {
      let saved: string | null = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch { /* Theme still works without storage. */ }
      const selected = saved === "dark" || saved === "light" ? saved : "dark";
      document.documentElement.dataset.theme = selected;
      setTheme(selected);
    };
    applyPreference();
    if (window.matchMedia("(max-width: 900px)").matches) setRemindersOpen(false);
  }, []);

  function toggleTheme() {
    const selected = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = selected;
    setTheme(selected);
    try { localStorage.setItem(THEME_KEY, selected); } catch { /* Optional persistence. */ }
  }

  const rememberSession = useCallback((value: SessionDetail) => {
    const current = detailRef.current;
    if (current?.session.id === value.session.id && (value.session.version < current.session.version || (value.session.version === current.session.version && value.turns.length < current.turns.length))) return current;
    detailRef.current = value;
    setDetail(value);
    if (value.session.state.status === "handoff") setShowChat(true);
    setSelectedTurnId(value.turns.at(-1)?.id ?? null);
    try { localStorage.setItem(SESSION_KEY, value.session.id); } catch { /* Storage may be unavailable in private browsing. */ }
    setBootstrap(current => current ? { ...current, sessions: [value.session, ...current.sessions.filter(s => s.id !== value.session.id)] } : current);
    return value;
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
        const initialized = await refreshBootstrap();
        setView(initialized.viewer.role === "supervisor" ? "operators" : "conversation");
        let savedId: string | null = null;
        try { savedId = localStorage.getItem(SESSION_KEY); } catch { /* Optional convenience only. */ }
        if (savedId && initialized.viewer.role !== "supervisor") {
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
      voiceGenerationRef.current += 1;
      transcribeAbortRef.current?.abort();
      audioRef.current?.pause();
      audioAbortRef.current?.abort();
      if (persistentAudioRef.current) {
        const audio = persistentAudioRef.current;
        audio.onended = null; audio.onplaying = null; audio.onerror = null;
        audio.pause(); audio.removeAttribute("src"); audio.load();
        persistentAudioRef.current = null;
      }
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [initialize]);

  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [detail?.turns.length, phase, view]);
  useEffect(() => {
    if (loadingSession || !showChat || !requestedTurnRef.current) return;
    const element = document.getElementById(`conversation-turn-${requestedTurnRef.current}`);
    if (!element) return;
    requestedTurnRef.current = null;
    element.scrollIntoView({ behavior: "instant", block: "center" });
  }, [loadingSession, showChat, transcriptExpanded, detail?.session.id, view, selectedTurnId]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") stopCallRef.current(); };
    const leave = () => stopCallRef.current();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", leave); };
  }, []);
  useEffect(() => {
    if (!authenticated || !detail?.session.id || detail.session.state.status === "closed" || view !== "conversation") return;
    let stopped = false;
    let inFlight = false;
    const poll = setInterval(async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      const sessionId = detailRef.current?.session.id;
      if (!sessionId) return;
      inFlight = true;
      try {
        const updated = await api<SessionDetail>(`/api/sessions/${sessionId}`);
        const current = detailRef.current;
        if (!stopped && current?.session.id === sessionId && updated.session.version >= current.session.version && (updated.session.version !== current.session.version || updated.turns.length !== current.turns.length || JSON.stringify(updated.handoffs) !== JSON.stringify(current.handoffs))) {
          const controlChanged = updated.session.state.status !== current.session.state.status;
          if (controlChanged && updated.session.state.status !== "active") stopCallRef.current();
          if (submittingRef.current && !controlChanged) return;
          rememberSession(updated);
          await refreshBootstrap();
        }
      } catch { /* A manual refresh remains available when polling cannot reach the server. */ }
      finally { inFlight = false; }
    }, 2000);
    return () => { stopped = true; clearInterval(poll); };
  }, [authenticated, detail?.session.id, detail?.session.state.status, view, refreshBootstrap, rememberSession]);
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
    if (audioRef.current) {
      audioRef.current.onended = null; audioRef.current.onplaying = null; audioRef.current.onerror = null;
      audioRef.current.pause(); audioRef.current = null;
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    setPlayingTurnId(null); setAudioLoadingId(null);
    setPhase(current => current === "synthesizing" ? null : current);
  }

  function stopVoiceCall() {
    voiceGenerationRef.current += 1;
    transcribeAbortRef.current?.abort(); transcribeAbortRef.current = null;
    voiceCall.stop();
    stopAudio();
    setPhase(current => current === "transcribing" ? null : current);
  }

  function navigateView(next: WorkspaceView) {
    if (next !== "conversation") stopVoiceCall();
    setView(next);
  }

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateViewport = () => {
      // Safari may resize only its visual viewport when the keyboard opens.
      // Preserve pinch zoom instead of treating it as a keyboard resize.
      const usable = viewport && Math.abs(viewport.scale - 1) < 0.05;
      const height = usable ? viewport.height : window.innerHeight;
      const inset = usable ? Math.max(0, window.innerHeight - height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty("--voice-viewport-height", `${Math.round(height)}px`);
      document.documentElement.style.setProperty("--voice-keyboard-inset", `${Math.round(inset)}px`);
      document.documentElement.dataset.voiceCompact = String(height <= 500);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.documentElement.style.removeProperty("--voice-viewport-height");
      document.documentElement.style.removeProperty("--voice-keyboard-inset");
      delete document.documentElement.dataset.voiceCompact;
    };
  }, []);

  function prepareAudioGesture() {
    const audio = persistentAudioRef.current ??= createPersistentAudio();
    playbackMeter.prepare(audio);
    // Called directly from a click/keyboard handler, before network awaits.
    void unlockAudioPlayback(audio).catch(() => {});
  }

  function sendTextMessage() {
    if (autoSpeakRef.current) { stopAudio(); prepareAudioGesture(); }
    void sendTurn(draft, "text");
  }

  async function startVoiceCall() {
    if (phase || submittingRef.current || loadingSession || operatorBusy || voiceCall.active || detailRef.current?.session.state.status === "closed" || detailRef.current?.session.state.status === "handoff") return;
    stopAudio(); setError(null);
    prepareAudioGesture();
    voiceGenerationRef.current += 1;
    autoSpeakRef.current = true; setAutoSpeak(true);
    setTranscriptExpanded(false);
    await voiceCall.start();
  }

  function handleError(err: unknown) {
    stopVoiceCall();
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
        setError("Аудиопоток прервался. Текст ответа сохранён."); stopVoiceCall();
      }, persistentAudioRef.current ??= createPersistentAudio(), playbackMeter.analyse);
      const { audio, url } = playback;
      if (sequence !== speechSequenceRef.current || controller.signal.aborted || detailRef.current?.session.id !== sessionId) { audio.pause(); URL.revokeObjectURL(url); return; }
      audioUrlRef.current = url;
      audioRef.current = audio;
      audio.onended = () => {
        if (sequence !== speechSequenceRef.current || detailRef.current?.session.id !== sessionId) return;
        setPlayingTurnId(null); audioRef.current = null;
        URL.revokeObjectURL(url); audioUrlRef.current = null;
      };
      audio.onerror = () => { if (sequence === speechSequenceRef.current) { setError("Браузер не смог воспроизвести ответ. Текст сохранён; попробуйте воспроизвести его ещё раз."); stopVoiceCall(); } };
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
      stopVoiceCall();
      if (err instanceof ApiError && err.status === 401) { handleError(err); return; }
      if (err instanceof DOMException && err.name === "NotAllowedError") setShowChat(true);
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

  async function sendTurn(text: string, mode: "text" | "voice", sttMs?: number, cycleStartedAt = performance.now(), voiceGeneration?: number) {
    if (!text.trim() || submittingRef.current || sessionChangeRef.current || operatorBusy) return;
    const deliveryGeneration = voiceGeneration ?? voiceGenerationRef.current;
    if (text.trim().length > 3000) { setError("Сообщение слишком длинное. Сократите его до 3000 символов."); setPhase(null); return; }
    if (detailRef.current?.session.state.status === "closed") { setError("Этот разговор завершён. Нажмите «Новый разговор», чтобы продолжить с новым обращением."); setPhase(null); return; }
    submittingRef.current = true;
    setPhase("routing"); setError(null); stopAudio();
    let result: SessionDetail | null = null;
    try {
      const active = await ensureSession();
      if (!mountedRef.current || (mode === "voice" && deliveryGeneration !== voiceGenerationRef.current)) return;
      const previous = pendingRequestRef.current;
      const requestId = previous?.sessionId === active.session.id && previous.text === text.trim() && previous.mode === mode ? previous.requestId : crypto.randomUUID();
      pendingRequestRef.current = { sessionId: active.session.id, text: text.trim(), mode, requestId };
      result = await api<SessionDetail>(`/api/sessions/${active.session.id}/turn`, { method: "POST", body: JSON.stringify({ text: text.trim(), requestId, mode, ...(sttMs != null ? { sttMs } : {}) }) });
      result = rememberSession(result); pendingRequestRef.current = null;
      if (result.session.state.status === "closed" || result.session.state.status === "handoff") voiceCall.stop();
      setDraft(current => current.trim() === text.trim() ? "" : current);
      void refreshBootstrap().catch(() => { /* The saved response is authoritative; the refresh button can retry summaries. */ });
    } catch (err) { handleError(err); } finally { submittingRef.current = false; setPhase(null); }
    if (result && result.session.state.status !== "handoff" && detailRef.current?.session.state.status !== "handoff" && autoSpeakRef.current && deliveryGeneration === voiceGenerationRef.current && document.visibilityState === "visible" && detailRef.current?.session.id === result.session.id && !sessionChangeRef.current && result.turns.length && result.turns.at(-1)?.mode !== "operator" && result.turns.at(-1)?.assistantText) await playSpeech(result.session.id, result.turns.at(-1)!, cycleStartedAt);
    if (mode === "text") textareaRef.current?.focus();
  }

  async function transcribe(blob: Blob, mime: string, cycleStartedAt: number) {
    const generation = voiceGenerationRef.current;
    const controller = new AbortController();
    transcribeAbortRef.current?.abort(); transcribeAbortRef.current = controller;
    setPhase("transcribing"); setError(null);
    try {
      const data = new FormData();
      const extension = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      data.append("audio", new File([blob], `voice-message.${extension}`, { type: mime }));
      const result = await api<{ text: string; language: string; elapsedMs: number }>("/api/transcribe", { method: "POST", body: data, signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted || generation !== voiceGenerationRef.current) return;
      if (!result.text.trim()) throw new Error("Речь не распознана. Попробуйте записать ещё раз или введите обращение текстом.");
      setDraft(result.text);
      await sendTurn(result.text, "voice", result.elapsedMs, cycleStartedAt, generation);
    } catch (err) { if (!controller.signal.aborted && generation === voiceGenerationRef.current) { handleError(err); setPhase(null); } }
    finally { if (transcribeAbortRef.current === controller) transcribeAbortRef.current = null; }
  }

  async function newSession() {
    if (phase || sessionChangeRef.current || submittingRef.current || operatorBusy) return;
    sessionChangeRef.current = true;
    stopVoiceCall(); setLoadingSession(true); setError(null); setView("conversation");
    try {
      const result = await api<SessionDetail>("/api/sessions", { method: "POST", body: "{}" });
      rememberSession(result); setDraft(""); pendingRequestRef.current = null; setTranscriptExpanded(false);
      void refreshBootstrap().catch(() => {});
    } catch (err) { handleError(err); } finally { sessionChangeRef.current = false; setLoadingSession(false); }
    textareaRef.current?.focus();
  }

  async function openSession(id: string, turnId?: string) {
    if (phase || sessionChangeRef.current || submittingRef.current || operatorBusy) return;
    sessionChangeRef.current = true;
    stopVoiceCall(); setLoadingSession(true); setError(null);
    try {
      const opened = await api<SessionDetail>(`/api/sessions/${id}`);
      rememberSession(opened);
      if (bootstrap?.viewer.role === "supervisor") { setShowChat(true); setTranscriptExpanded(true); setNavigationOpen(true); }
      requestedTurnRef.current = null;
      if (turnId && opened.turns.some(turn => turn.id === turnId)) {
        setSelectedTurnId(turnId); setShowChat(true); setTranscriptExpanded(true); setTraceOpen(true);
        requestedTurnRef.current = turnId;
      }
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
    if (phase || sessionChangeRef.current || submittingRef.current || operatorBusy) return;
    try {
      stopVoiceCall();
      await api("/api/auth", { method: "DELETE" });
      stopAudio(); setAuthenticated(false); setBootstrap(null); setDetail(null); detailRef.current = null; setDraft(""); setView("conversation");
      operatorDraftsRef.current.clear(); operatorRequestsRef.current.clear(); pendingRequestRef.current = null;
      try { localStorage.removeItem(SESSION_KEY); } catch { /* Optional convenience only. */ }
    } catch (err) { handleError(err); }
  }

  function useExample(text: string) {
    if (detailRef.current?.session.state.status === "closed") { setView("conversation"); setError("Этот разговор завершён. Создайте новый разговор, затем выберите пример."); return; }
    setView("conversation"); setShowChat(true); setDraft(text); requestAnimationFrame(() => textareaRef.current?.focus());
  }

  if (booting) return <main className="boot-screen"><Logo /><Spinner label="Подключаем рабочее пространство…" /></main>;
  if (!authenticated) return <Login onSuccess={initialize} initialError={error} theme={theme} onToggleTheme={toggleTheme} />;
  if (!bootstrap) return <main className="boot-screen"><Logo /><ErrorNotice message={error || "Не удалось загрузить рабочее пространство."} /><button className="button button-primary" onClick={() => void initialize()}><RefreshCw size={16} />Повторить подключение</button><button className="button button-ghost" onClick={() => void logout()}>Выйти</button></main>;

  const busy = phase !== null || loadingSession || operatorBusy;
  const currentSession = detail?.session;
  const visibleTurns = transcriptExpanded ? detail?.turns ?? [] : detail?.turns.slice(-1) ?? [];
  const canSendText = currentSession?.state.status !== "closed" && bootstrap.configured.database && (bootstrap.configured.ai || currentSession?.state.status === "handoff");
  const pendingCount = bootstrap.handoffs.filter(h => h.status !== "closed").length;
  const title = bootstrap.viewer.role === "supervisor" && view === "conversation" ? { title: "Просмотр разговора", subtitle: "История клиента и решения AI. Для перехвата откройте Live · Диалоги." } : viewCopy[view];

  const phaseLabel = phase === "transcribing" ? "Распознаём речь" : phase === "routing" ? "Выбираем сценарий и готовим ответ" : phase === "synthesizing" ? "Подготавливаем голосовой ответ" : "Готовы слушать";

  const callLabel = phase === "transcribing" ? "Распознаю вашу фразу" : phase === "routing" ? "Разбираюсь в вопросе" : phase === "synthesizing" ? "Готовлю голосовой ответ" : playingTurnId ? "AI отвечает" : voiceCall.status === "requesting" ? "Разрешите доступ к микрофону" : voiceCall.status === "calibrating" ? "Настраиваю микрофон" : voiceCall.status === "settling" ? "Включаю микрофон" : voiceCall.status === "speaking" ? "Слушаю вас" : voiceCall.active ? "Говорите, я слушаю" : "Голосовой разговор";
  const callHint = voiceCall.active ? playingTurnId ? "После ответа микрофон снова включится" : phase ? "Текст и решение появятся в истории" : voiceCall.status === "requesting" ? "Микрофон включается только с вашего разрешения" : voiceCall.status === "calibrating" || voiceCall.status === "settling" ? "Подождите появления надписи «Говорите»" : "Сделайте паузу в конце фразы — ответ придёт автоматически" : currentSession?.state.status === "handoff" ? "Продолжите общение с оператором текстом" : currentSession?.state.status === "closed" ? "Для нового обращения создайте разговор" : "Нажмите один раз и общайтесь без отправки каждой реплики";
  const particleMode = error ? "error" : playingTurnId ? "replying" : phase || voiceCall.status === "processing" || voiceCall.status === "requesting" ? "processing" : voiceCall.status === "speaking" ? "speaking" : voiceCall.active ? "listening" : "idle";

  const callControls = <>
    <div className="voice-control-buttons">
      {voiceCall.active && (playingTurnId || phase === "synthesizing") && <button className="button button-secondary" onClick={stopAudio}><Square size={14} />Перебить ответ</button>}
      {voiceCall.active ? <button className="button button-call is-ending" onClick={stopVoiceCall}><PhoneOff size={18} />Завершить звонок</button> : <button className="button button-call" onClick={() => void startVoiceCall()} disabled={busy || currentSession?.state.status === "closed" || currentSession?.state.status === "handoff" || !bootstrap.configured.ai || !bootstrap.configured.database}><Phone size={18} />Начать разговор</button>}
    </div>
    {voiceCall.active && <div className="mic-level" role="meter" aria-label="Уровень микрофона" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(voiceCall.micLevel * 100)}><span style={{ transform: `scaleX(${voiceCall.micLevel})` }} /></div>}
  </>;

  return <div className={`app-shell view-${view} ${view === "conversation" ? `immersive-voice ${navigationOpen ? "" : "nav-hidden"}` : ""}`}>
    {view === "conversation" && <BackgroundStarfield theme={theme} />}
    <aside className="sidebar" id="workspace-navigation"><div className="sidebar-brand"><Logo /></div><div className="workspace-label"><span className="workspace-avatar">DE</span><div>Контакт-центр<span>Рабочее пространство</span></div><span className="workspace-online" title="Рабочее пространство загружено" /></div>
      <div className="sidebar-section-label">РАБОТА С ОБРАЩЕНИЯМИ</div><nav className="primary-nav" aria-label="Основная навигация">
        {bootstrap.viewer.role !== "supervisor" && <NavItem icon={<AudioLines size={19} />} label="Разговор с AI" active={view === "conversation"} disabled={busy} onClick={() => navigateView("conversation")} />}
        <NavItem icon={<History size={19} />} label="История" count={bootstrap.sessions.length} active={view === "history"} disabled={busy} onClick={() => navigateView("history")} />
        <NavItem icon={<BookOpen size={19} />} label="Сценарии" active={view === "catalog"} disabled={busy} onClick={() => navigateView("catalog")} />
        {bootstrap.viewer.role === "supervisor" && <NavItem icon={<Headphones size={19} />} label="Live · Диалоги" count={pendingCount} active={view === "operators"} disabled={busy} onClick={() => navigateView("operators")} />}
        {bootstrap.viewer.role === "supervisor" && <NavItem icon={<ShieldCheck size={19} />} label="Контроль качества" active={view === "supervision"} disabled={busy} onClick={() => navigateView("supervision")} />}
      </nav><div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><GitBranch size={18} /></span><strong>Голос. Контекст. Решение.</strong><p>Говорите на удобном вам языке.</p></div><button ref={helpButtonRef} className="sidebar-help" onClick={() => { stopVoiceCall(); setHelpOpen(true); }}><CircleHelp size={18} />Как работать с линией<ChevronRight size={14} /></button><div className="sidebar-profile"><span className="profile-avatar">{bootstrap.viewer.role === "supervisor" ? "С" : "У"}</span><span><strong>{bootstrap.viewer.role === "supervisor" ? "Супервизор" : "Клиент"}</strong><small>Защищённый доступ</small></span><button onClick={() => void logout()} disabled={busy} aria-label="Выйти" title="Выйти"><LogOut size={16} /></button></div></div>
    </aside>
    <div className="main-shell"><header className="topbar">{view === "conversation" && <button className="button button-ghost navigation-toggle" onClick={() => setNavigationOpen(open => !open)} aria-expanded={navigationOpen} aria-controls="workspace-navigation"><Menu size={18} /><span>Меню</span></button>}<div className="breadcrumb"><span>Контакт-центр</span><ChevronRight size={13} /><strong>{title.title}</strong></div><div className="topbar-right"><ThemeToggle theme={theme} onToggle={toggleTheme} /><span className={`connection-status ${bootstrap.configured.database && bootstrap.configured.ai ? "" : "connection-warning"}`}><i />{bootstrap.configured.database && bootstrap.configured.ai ? "Система подключена" : "Требуется настройка"}</span><span className="topbar-divider" /><button className="icon-button" onClick={() => void refresh()} disabled={busy || refreshing} aria-label="Обновить данные" title="Обновить данные"><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button><span className="topbar-product">VOICE ROUTER <span>01</span></span></div></header>
      <main className={`main-content view-${view}`} id="main-content"><div className="page-heading"><div><div className="page-eyebrow"><span /> DIR ECHOES / VOICE OPERATIONS</div><h1>{title.title}</h1><p>{title.subtitle}</p></div>{bootstrap.viewer.role !== "supervisor" && <button className="button button-primary new-conversation" onClick={() => void newSession()} disabled={busy}>{loadingSession ? <Spinner /> : <Plus size={17} />}Новый разговор</button>}</div>
        <div className="stats-grid"><Stat label="Разговоров" value={bootstrap.stats.sessions} icon={<MessageSquare size={17} />} note="В вашем рабочем пространстве" /><Stat label="Обработано реплик" value={bootstrap.stats.turns} icon={<AudioLines size={17} />} note="С сохранённым результатом" /><Stat label="У оператора" value={bootstrap.stats.handoffs} icon={<Headphones size={17} />} note="Открытые обращения с контекстом" /><Stat label="Выбор маршрута" value={bootstrap.stats.turns ? duration(bootstrap.stats.medianRoutingMs) : "—"} icon={<GitBranch size={17} />} note="Медиана времени маршрутизации" /></div>
        {error && <div className="global-error"><ErrorNotice message={error} onDismiss={() => setError(null)} /></div>}
        {(!bootstrap.configured.ai || !bootstrap.configured.database) && <div className="configuration-notice"><ShieldCheck size={17} /><span>{!bootstrap.configured.database ? "Хранилище не подключено. Сохранение разговоров недоступно." : "AI-сервис не подключён. Обработка новых обращений пока недоступна."}</span></div>}
        {view === "conversation" ? <div className={`conversation-layout immersive-layout ${traceOpen ? "trace-open" : ""}`}><section className="conversation-panel voice-focused" aria-label="Разговор"><div className="conversation-heading"><span className="conversation-heading-icon"><AudioLines size={21} /></span><div className="conversation-title"><h2>{currentSession?.title || "Новый разговор"}</h2><span>{currentSession ? <><i className={`state-dot state-${currentSession.state.status}`} />{sessionStatus(currentSession.state.status)}</> : <>Готовы к первому обращению</>}</span></div>{bootstrap.viewer.role !== "supervisor" && <button className="button button-secondary conversation-new" onClick={() => void newSession()} disabled={busy} title="Создать новый разговор"><Plus size={16} /><span>Новый разговор</span></button>}{currentSession && <a href={`/api/sessions/${currentSession.id}/export`} download className="icon-button" aria-label="Скачать историю разговора в JSON" title="Скачать историю в JSON"><ArrowDownToLine size={18} /></a>}<button className="button button-secondary chat-toggle" onClick={() => setShowChat(open => !open)} aria-expanded={showChat} aria-controls="voice-chat"><MessageSquare size={16} />Чат</button><button ref={traceToggleRef} className="button button-secondary trace-toggle" onClick={() => { if (traceOpen || remindersOpen) { setTraceOpen(false); setRemindersOpen(false); } else setRemindersOpen(true); }} aria-expanded={traceOpen || remindersOpen} aria-controls={traceOpen ? "response-logic" : "conversation-details"}><GitBranch size={16} />Подсказки</button><button className={`icon-button ${autoSpeak ? "audio-enabled" : ""}`} onClick={() => { autoSpeakRef.current = !autoSpeakRef.current; setAutoSpeak(autoSpeakRef.current); if (!autoSpeakRef.current) stopVoiceCall(); }} aria-label={autoSpeak ? "Выключить автоматическое озвучивание" : "Включить автоматическое озвучивание"} aria-pressed={autoSpeak} title={autoSpeak ? "Автоматическое озвучивание включено" : "Автоматическое озвучивание выключено"}>{autoSpeak ? <Volume2 size={18} /> : <VolumeX size={18} />}</button></div>
          <div className="voice-conversation-space"><div className="voice-stage" data-active={voiceCall.active || undefined}><VoiceParticles mode={particleMode} level={voiceCall.micLevel} replyLevel={playbackMeter.level} callActive={voiceCall.active} theme={theme} variant="stage" /><div className="voice-stage-copy"><strong role="status" aria-live="polite">{bootstrap.viewer.role === "supervisor" ? "Просмотр разговора клиента" : callLabel}</strong><span>{bootstrap.viewer.role === "supervisor" ? "Перехват и живой голос доступны в Live · Диалоги" : callHint}</span>{bootstrap.viewer.role !== "supervisor" && callControls}</div></div>
          {showChat && <aside className="voice-chat-panel" id="voice-chat" aria-label="Чат и расшифровка"><div className="transcript-toolbar"><span>Расшифровка</span>{!!detail?.turns.length && <button onClick={() => setTranscriptExpanded(open => !open)}>{transcriptExpanded ? "Последняя реплика" : `Весь разговор · ${detail.turns.length}`}</button>}<button className="icon-button" onClick={() => setShowChat(false)} aria-label="Скрыть чат"><X size={17} /></button></div>
          <div className="conversation-body" aria-live="polite" aria-relevant="additions text">{loadingSession ? <div className="conversation-loading"><Spinner label="Открываем разговор…" /></div> : (!detail || !detail.turns.length) ? <div className="conversation-empty"><MessageSquare size={22} /><h3>Здесь — ваш разговор</h3><p>Речь и ответы появятся автоматически. Можно также написать сообщение.</p></div> : <ConversationThread detail={detail} turns={visibleTurns} viewerRole={bootstrap.viewer.role} selectedTurnId={selectedTurnId} playingTurnId={playingTurnId} audioLoadingId={audioLoadingId} busy={busy} voiceCallActive={voiceCall.active} onAudio={turn => {
            if (playingTurnId === turn.id || audioLoadingId === turn.id) stopAudio();
            else { stopAudio(); prepareAudioGesture(); void playSpeech(detail.session.id, turn); }
          }} onTrace={id => { setSelectedTurnId(id); setTraceOpen(true); }} />}
          {phase && <div className="processing-message" role="status"><span className="assistant-avatar"><AudioLines size={17} /></span><Spinner label={phaseLabel} /></div>}<div ref={messageEndRef} /></div>
          {currentSession?.state.pendingConfirmation && <div className="conversation-confirmation"><ShieldCheck size={17} /><span>Перед выполнением операции нужно ваше подтверждение.</span></div>}
          {currentSession?.state.status === "handoff" && <div className="conversation-handoff"><Headphones size={17} /><span>Обращение передано оператору вместе с контекстом.</span><button onClick={() => void refresh()} disabled={busy || refreshing}>Проверить ответ</button></div>}
          {bootstrap.viewer.role === "participant" && currentSession?.state.status === "handoff" && <div style={{ pointerEvents: "auto", padding: "12px 0", flexShrink: 0 }}><OperatorVoiceControls sessionId={currentSession.id} role="participant" enabled={detail?.handoffs?.some(handoff => handoff.status === "active") ?? false} /></div>}
          {bootstrap.viewer.role === "participant" && <div className="composer">
            <div className="conversation-tools"><span>Говорите на удобном вам языке</span>{voiceCall.active && <button className="text-input-toggle" onClick={() => { stopVoiceCall(); requestAnimationFrame(() => textareaRef.current?.focus()); }}>Перейти к тексту</button>}</div>
            <form className="text-composer" onSubmit={event => { event.preventDefault(); if (!busy && !voiceCall.active) sendTextMessage(); }}>
              <label className="visually-hidden" htmlFor="message-input">{currentSession?.state.status === "handoff" ? "Сообщение оператору" : "Текст обращения"}</label>
              <textarea ref={textareaRef} id="message-input" placeholder={currentSession?.state.status === "closed" ? "Разговор завершён. Начните новый." : currentSession?.state.status === "handoff" ? "Сообщение оператору…" : voiceCall.active ? "Здесь появится распознанная фраза…" : "Написать сообщение…"} value={draft} rows={1} maxLength={3000} disabled={busy || voiceCall.active || !canSendText} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy && !voiceCall.active) sendTextMessage(); } }} />
              <button className="send-button" type="submit" aria-label={currentSession?.state.status === "handoff" ? "Отправить сообщение оператору" : "Отправить обращение"} title="Отправить · Enter" disabled={busy || voiceCall.active || !draft.trim() || !canSendText}><ArrowRight size={20} /></button>
            </form>
            <div className="composer-footnote"><span><LockKeyhole size={12} />История сохраняется автоматически</span><span>Используйте данные кейса без реальных персональных данных</span></div>
          </div>}
          </aside>}</div>
        </section>{traceOpen && <aside className="trace-drawer" id="response-logic" aria-label="Логика ответа"><header><strong>Логика ответа</strong><button className="icon-button" onClick={() => { setTraceOpen(false); setRemindersOpen(false); traceToggleRef.current?.focus(); }} aria-label="Скрыть логику ответа"><X size={18} /></button></header><TracePanel detail={detail} catalog={bootstrap.catalog} selectedTurnId={selectedTurnId} onSelectTurn={setSelectedTurnId} isSupervisor={bootstrap.viewer.role === "supervisor"} /></aside>}{!traceOpen && remindersOpen && <ConversationContext detail={detail} catalog={bootstrap.catalog} busy={busy} onClose={() => { setRemindersOpen(false); traceToggleRef.current?.focus(); }} onTrace={() => setTraceOpen(true)} onResumeTopic={text => { stopVoiceCall(); useExample(text); }} />}</div> : view === "history" ? <HistoryView sessions={bootstrap.sessions} onOpen={id => void openSession(id)} onNew={bootstrap.viewer.role === "supervisor" ? undefined : () => void newSession()} currentId={currentSession?.id} /> : view === "catalog" ? <CatalogView catalog={bootstrap.catalog} onExample={useExample} canEdit={bootstrap.viewer.role === "supervisor"} catalogHash={bootstrap.datasetHash} onCatalogChanged={refreshBootstrap} /> : view === "supervision" && bootstrap.viewer.role === "supervisor" ? <SupervisorDashboard catalog={bootstrap.catalog} onOpen={(id, turnId) => void openSession(id, turnId)} /> : <OperatorsView sessions={bootstrap.sessions} catalog={bootstrap.catalog} handoffs={bootstrap.handoffs} onChanged={refreshBootstrap} onOpen={id => void openSession(id)} drafts={operatorDraftsRef.current} requests={operatorRequestsRef.current} onBusyChange={setOperatorBusy} />}
        <footer className="page-footer"><span>DIR ECHOES <span>Гибридный голосовой маршрутизатор</span></span><span>Данные кейса на {bootstrap.businessDate} <span className="footer-dot">·</span> Каталог {bootstrap.datasetHash.slice(0, 8)}</span></footer>
      </main>
    </div>
    {helpOpen && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section ref={helpModalRef} className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="modal-close icon-button" autoFocus onClick={() => setHelpOpen(false)} aria-label="Закрыть справку"><X size={19} /></button><span className="empty-icon"><AudioLines size={26} /></span><span className="section-eyebrow">РАБОТА С ЛИНИЕЙ</span><h2 id="help-title">От обращения к действию</h2><ol><li><span>01</span><div><strong>Расскажите о вопросе</strong><p>Нажмите «Начать разговор» и говорите. После паузы приложение само отправит реплику, озвучит ответ и снова включит прослушивание. Для выхода нажмите «Завершить звонок».</p></div></li><li><span>02</span><div><strong>Следите за решением</strong><p>В панели «Подсказки» нажмите «Показать логику ответа»: там показаны сценарий, объяснение выбора, параметры, действия и задержки. Панель можно скрыть в любой момент.</p></div></li><li><span>03</span><div><strong>Подтвердите действие</strong><p>Маршрутизатор попросит подтверждение перед любым изменением данных или запросом внешнего действия. Если нужен человек, контекст будет передан оператору.</p></div></li></ol><p className="help-note">История сохраняется. Вернитесь к разговору из раздела «История». Голосовые ответы создаются AI.</p><button className="button button-primary" onClick={() => setHelpOpen(false)}>Понятно<ArrowRight size={16} /></button></section></div>}
  </div>;
}

function NavItem({ icon, label, active, disabled, count, onClick }: { icon: React.ReactNode; label: string; active: boolean; disabled: boolean; count?: number; onClick: () => void }) {
  return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} disabled={disabled} aria-current={active ? "page" : undefined}>{icon}<span>{label}</span>{count != null && count > 0 && <span className="nav-count">{count}</span>}</button>;
}

function Stat({ label, value, icon, note }: { label: string; value: string | number; icon: React.ReactNode; note: string }) {
  return <div className="stat-card"><div className="stat-heading"><span>{label}</span>{icon}</div><strong>{value}</strong><small>{note}</small></div>;
}

function ThemeToggle({ theme, onToggle, className = "" }: { theme: "light" | "dark"; onToggle: () => void; className?: string }) {
  return <button className={`button button-secondary theme-toggle ${className}`} onClick={onToggle} title={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}{theme === "dark" ? "Светлая тема" : "Тёмная тема"}</button>;
}

function Login({ onSuccess, initialError, theme, onToggleTheme }: { onSuccess: () => Promise<void>; initialError: string | null; theme: "light" | "dark"; onToggleTheme: () => void }) {
  const [code, setCode] = useState("");
  const [role, setRole] = useState<Role>("participant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!code.trim() || busy) return;
    setBusy(true); setError(null);
    try { await api("/api/auth", { method: "POST", body: JSON.stringify({ code: code.trim(), role }) }); setCode(""); await onSuccess(); } catch (err) { setError(readableError(err)); } finally { setBusy(false); }
  }
  return <main className="login-page"><ThemeToggle theme={theme} onToggle={onToggleTheme} className="login-theme-toggle" /><section className="login-story"><div className="login-story-main"><span className="login-eyebrow"><span />VOICE OPERATIONS PLATFORM</span><h1>Слышать запрос.<br />Понимать контекст.<br /><span>Находить решение.</span></h1><p>Гибридный голосовой маршрутизатор.<br />Говорите на удобном вам языке.</p><div className="login-flow"><span><Mic size={19} />Голос</span><i /><span><GitBranch size={19} />Сценарий</span><i /><span><Check size={19} />Действие</span></div></div><div className="login-story-footer"><span>DIR ECHOES</span><span>VOICE ROUTER / 01</span></div></section><section className="login-form-side"><div className="login-card"><Logo size={64} /><span className="section-eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h2>{role === "supervisor" ? "Рабочее место супервизора" : "Разговор с ассистентом"}</h2><p>{role === "supervisor" ? "Все диалоги, контроль AI и подключение к клиенту своим голосом." : "Задайте вопрос голосом или текстом. При необходимости подключится человек."}</p><form onSubmit={submit}><fieldset className="login-role"><legend>Выберите, как войти</legend><button type="button" className={role === "participant" ? "selected" : ""} aria-pressed={role === "participant"} onClick={() => setRole("participant")} disabled={busy}><MessageSquare size={16} />Клиент</button><button type="button" className={role === "supervisor" ? "selected" : ""} aria-pressed={role === "supervisor"} onClick={() => setRole("supervisor")} disabled={busy}><Headphones size={16} />Супервизор</button></fieldset><label htmlFor="access-code">Код доступа</label><div className="login-code"><LockKeyhole size={17} /><input id="access-code" type="password" autoComplete="current-password" placeholder="Введите выданный код" value={code} onChange={e => setCode(e.target.value)} disabled={busy} required maxLength={200} /></div>{error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}<button className="button button-primary login-submit" type="submit" disabled={!code.trim() || busy}>{busy ? <Spinner label="Подключаемся…" /> : <>Войти в рабочее пространство<ArrowRight size={17} /></>}</button></form><div className="login-privacy"><ShieldCheck size={17} /><span>Доступ по коду. История разговоров<br />сохраняется в вашем пространстве.<br />Используйте данные кейса. Не вводите и не произносите реальные персональные данные.</span></div></div><div className="login-bottom">DIR ECHOES <span>Говорите на удобном вам языке</span></div></section></main>;
}
