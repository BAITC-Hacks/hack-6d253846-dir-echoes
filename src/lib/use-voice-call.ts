"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type VoiceCallStatus = "idle" | "requesting" | "listening" | "speaking" | "processing";

export interface VoiceCallOptions {
  /** Keep true through STT, routing, synthesis AND the end of audio playback. */
  paused: boolean;
  /** speechEndedAt uses performance.now(), before the silence detection delay. */
  onUtterance: (blob: Blob, mime: string, speechEndedAt: number) => Promise<void>;
  onError: (error: Error) => void;
}

interface Snapshot {
  status: VoiceCallStatus;
  micLevel: number;
  elapsedMs: number;
}

interface Clip {
  recorder: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  discarded: boolean;
  startedAt: number;
  speechStartedAt: number;
  speechEndedAt: number;
  voicedMs: number;
}

interface Runtime {
  generation: number;
  live: boolean;
  ready: boolean;
  context: AudioContext;
  stream: MediaStream | null;
  outputStream: MediaStream | null;
  nodes: AudioNode[];
  gate: GainNode | null;
  timer: ReturnType<typeof setInterval> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
  clips: Set<Clip>;
  currentClip: Clip | null;
  syncPaused: (paused: boolean) => void;
}

const IDLE: Snapshot = { status: "idle", micLevel: 0, elapsedMs: 0 };
const PRE_ROLL_MS = 350;
const SILENCE_MS = 950;
const ECHO_GUARD_MS = 250;
const ATTACK_MS = 80;
const MIN_VOICED_MS = 140;
const MAX_CLIP_MS = 45_000;
const MAX_BYTES = 3_000_000;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function discardCurrent(runtime: Runtime) {
  const clip = runtime.currentClip;
  runtime.currentClip = null;
  if (!clip) return;
  clip.discarded = true;
  clip.chunks = [];
  if (clip.recorder.state !== "inactive") {
    try { clip.recorder.stop(); } catch { /* Already stopped by the browser. */ }
  }
}

function dispose(runtime: Runtime) {
  runtime.live = false;
  if (runtime.timer) clearInterval(runtime.timer);
  if (runtime.drainTimer) clearTimeout(runtime.drainTimer);
  if (runtime.gate) runtime.gate.gain.value = 0;
  for (const clip of runtime.clips) {
    clip.discarded = true;
    clip.chunks = [];
    clip.recorder.ondataavailable = null;
    clip.recorder.onstop = null;
    clip.recorder.onerror = null;
    if (clip.recorder.state !== "inactive") {
      try { clip.recorder.stop(); } catch { /* Cleanup is idempotent. */ }
    }
  }
  runtime.clips.clear();
  runtime.currentClip = null;
  runtime.stream?.getTracks().forEach((track) => track.stop());
  runtime.outputStream?.getTracks().forEach((track) => track.stop());
  for (const node of runtime.nodes) {
    try { node.disconnect(); } catch { /* Some browsers disconnect closed nodes. */ }
  }
  runtime.context.onstatechange = null;
  if (runtime.context.state !== "closed") void runtime.context.close().catch(() => {});
}

function microphoneError(value: unknown): Error {
  if (value instanceof Error) {
    if (value.name === "NotAllowedError") return new Error("Разрешите доступ к микрофону и начните разговор снова.");
    if (value.name === "NotFoundError") return new Error("Микрофон не найден. Подключите его и начните разговор снова.");
    if (value.name === "NotReadableError") return new Error("Микрофон недоступен или занят другим приложением.");
    return value;
  }
  return new Error("Не удалось продолжить голосовой разговор.");
}

/**
 * Half-duplex conversation: microphone permission is requested only by start().
 * Local energy VAD is a speech gate, not a speech/noise classifier. The caller
 * owns cancellation of an onUtterance request that was already dispatched.
 */
export function useVoiceCall(options: VoiceCallOptions) {
  const [snapshot, setSnapshot] = useState<Snapshot>(IDLE);
  const optionsRef = useRef(options);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const runtimeRef = useRef<Runtime | null>(null);

  const publish = useCallback((next: Snapshot) => {
    if (!mountedRef.current) return;
    setSnapshot((previous) => previous.status === next.status
      && previous.micLevel === next.micLevel && previous.elapsedMs === next.elapsedMs ? previous : next);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    const runtime = runtimeRef.current;
    runtimeRef.current = null;
    if (runtime) dispose(runtime);
    publish(IDLE);
  }, [publish]);

  // Runs before paint; the timer also checks this ref before capture and delivery.
  useLayoutEffect(() => {
    optionsRef.current = options;
    runtimeRef.current?.syncPaused(options.paused);
  }, [options]);

  useEffect(() => {
    mountedRef.current = true;
    const onHidden = () => { if (document.visibilityState === "hidden") stop(); };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", onHidden);
      stop();
    };
  }, [stop]);

  const start = useCallback(async () => {
    if (!mountedRef.current || runtimeRef.current) return;
    const generation = ++generationRef.current;
    const alive = () => mountedRef.current && generationRef.current === generation;
    const fail = (error: unknown) => {
      if (!alive()) return;
      stop();
      try { optionsRef.current.onError(microphoneError(error)); } catch { /* Resources are already closed. */ }
    };
    publish({ status: "requesting", micLevel: 0, elapsedMs: 0 });

    try {
      const AudioContextClass = window.AudioContext
        ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass || typeof MediaRecorder === "undefined") {
        throw new Error("Этот браузер не поддерживает голосовой разговор. Откройте сайт по HTTPS в современном браузере.");
      }
      const mime = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error("Браузер не поддерживает подходящий формат записи. Можно продолжить текстом.");

      const context = new AudioContextClass({ latencyHint: "interactive" });
      const runtime: Runtime = {
        generation, live: true, ready: false, context, stream: null, outputStream: null,
        nodes: [], gate: null, timer: null, drainTimer: null, clips: new Set(), currentClip: null,
        syncPaused: () => {},
      };
      runtimeRef.current = runtime;
      // Resume while still in the explicit user gesture; handle rejection even
      // while a microphone permission prompt remains open.
      const resumed = context.resume().then(() => null, (error: unknown) => ({ error }));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!alive()) { stream.getTracks().forEach((track) => track.stop()); return; }
      runtime.stream = stream;
      const resumeResult = await resumed;
      if (!alive()) return;
      if (resumeResult) throw resumeResult.error;
      if (context.state !== "running") throw new Error("Браузер приостановил звук. Нажмите начало разговора ещё раз.");

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const gate = context.createGain();
      gate.gain.value = 0;
      const delay = context.createDelay(1);
      delay.delayTime.value = PRE_ROLL_MS / 1000;
      const destination = context.createMediaStreamDestination();
      runtime.gate = gate;
      runtime.outputStream = destination.stream;
      runtime.nodes = [source, analyser, gate, delay, destination];
      source.connect(analyser);
      source.connect(gate);
      gate.connect(delay);
      delay.connect(destination);
      // Never connect microphone audio to context.destination (the speakers).
      const samples = new Float32Array(analyser.fftSize);
      let busy = false;
      let observedPaused = optionsRef.current.paused;
      let cooldownUntil = performance.now() + ECHO_GUARD_MS;
      let candidateSince: number | null = null;
      let candidateVoicedMs = 0;
      let candidateLastAt = 0;
      let noiseFloor = 0.003;
      let lastTick = performance.now();
      let lastPublishedAt = 0;
      let lastPublishedStatus: VoiceCallStatus = "requesting";

      const resetCandidate = () => { candidateSince = null; candidateVoicedMs = 0; candidateLastAt = 0; };
      const display = (status: VoiceCallStatus, level = 0, elapsedMs = 0) => {
        const now = performance.now();
        if (status === lastPublishedStatus && now - lastPublishedAt < 100) return;
        lastPublishedAt = now;
        lastPublishedStatus = status;
        publish({ status, micLevel: Math.round(level * 100) / 100, elapsedMs: Math.round(elapsedMs / 100) * 100 });
      };
      const rearm = () => {
        busy = false;
        resetCandidate();
        cooldownUntil = performance.now() + ECHO_GUARD_MS;
      };

      runtime.syncPaused = (paused) => {
        if (!alive() || !runtime.live) return;
        if (paused) {
          gate.gain.value = 0;
          resetCandidate();
          discardCurrent(runtime);
          cooldownUntil = performance.now() + ECHO_GUARD_MS;
          if (runtime.ready) display("processing");
        } else if (observedPaused) {
          cooldownUntil = performance.now() + ECHO_GUARD_MS;
        }
        observedPaused = paused;
      };

      const beginClip = (now: number) => {
        if (!alive() || optionsRef.current.paused || busy) return;
        const recorder = new MediaRecorder(destination.stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
        const clip: Clip = {
          recorder, chunks: [], bytes: 0, discarded: false, startedAt: now,
          speechStartedAt: candidateSince ?? now, speechEndedAt: now, voicedMs: candidateVoicedMs,
        };
        runtime.currentClip = clip;
        runtime.clips.add(clip);
        recorder.ondataavailable = (event) => {
          if (!alive() || clip.discarded || !event.data.size) return;
          clip.bytes += event.data.size;
          if (clip.bytes > MAX_BYTES) {
            fail(new Error("Реплика превысила 3 МБ. Начните разговор снова и говорите более короткими фразами."));
            return;
          }
          clip.chunks.push(event.data);
        };
        recorder.onerror = () => fail(new Error("Запись микрофона прервалась. Начните разговор снова."));
        recorder.onstop = () => {
          runtime.clips.delete(clip);
          if (!alive() || !runtime.live || clip.discarded) return;
          // An unexpected recorder stop must not leave the call stuck speaking.
          if (runtime.currentClip === clip) {
            fail(new Error("Браузер остановил запись. Начните разговор снова."));
            return;
          }
          const blob = new Blob(clip.chunks, { type: recorder.mimeType || mime });
          clip.chunks = [];
          if (clip.voicedMs < MIN_VOICED_MS || blob.size < 100) { rearm(); return; }
          if (blob.size > MAX_BYTES) { fail(new Error("Реплика превысила допустимый размер записи.")); return; }
          // This is a completed clip. A paused transition must not discard it:
          // the caller sets paused while this exact callback processes STT/TTS.
          void (async () => {
            try {
              if (!alive() || !runtime.live) return;
              await optionsRef.current.onUtterance(blob, blob.type, clip.speechEndedAt);
              if (alive() && runtime.live) rearm();
            } catch (error) { fail(error); }
          })();
        };
        // Every clip starts its own valid container. Delayed PCM supplies the
        // pre-roll; slicing arbitrary WebM/MP4 chunks would lose their headers.
        recorder.start(200);
        resetCandidate();
        display("speaking", 0, now - clip.speechStartedAt);
      };

      const finishClip = (clip: Clip, drain: boolean) => {
        if (!alive() || runtime.currentClip !== clip) return;
        runtime.currentClip = null;
        busy = true;
        gate.gain.value = 0;
        resetCandidate();
        display("processing");
        const finish = () => {
          runtime.drainTimer = null;
          if (!alive() || clip.discarded) return;
          try { clip.recorder.stop(); } catch (error) { fail(error); }
        };
        // Normal silence already drained the delay. At the duration limit,
        // leave enough time for the last delayed samples before stopping.
        if (drain) runtime.drainTimer = setTimeout(finish, PRE_ROLL_MS);
        else finish();
      };

      runtime.ready = true;
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (runtime.live) fail(new Error("Микрофон отключён. Подключите его и начните разговор снова."));
        }, { once: true });
      }
      context.onstatechange = () => {
        if (runtime.live && context.state !== "running") fail(new Error("Браузер приостановил микрофон. Начните разговор снова."));
      };
      runtime.timer = setInterval(() => {
        if (!alive() || !runtime.live) return;
        try {
          const now = performance.now();
          const frameMs = Math.min(80, Math.max(0, now - lastTick));
          lastTick = now;
          runtime.syncPaused(optionsRef.current.paused);
          if (optionsRef.current.paused || busy || now < cooldownUntil) {
            gate.gain.value = 0;
            resetCandidate();
            display("processing");
            return;
          }
          gate.gain.value = 1;
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);
          const openThreshold = Math.max(0.012, noiseFloor * 3);
          const closeThreshold = Math.max(0.007, noiseFloor * 1.7);
          const level = Math.min(1, rms * 8);
          const clip = runtime.currentClip;
          if (clip) {
            if (rms >= closeThreshold) {
              clip.voicedMs += frameMs;
              clip.speechEndedAt = now;
            }
            if (now - clip.startedAt >= MAX_CLIP_MS - PRE_ROLL_MS - 100) finishClip(clip, true);
            else if (now - clip.speechEndedAt >= SILENCE_MS) finishClip(clip, false);
            else display("speaking", level, now - clip.speechStartedAt);
            return;
          }
          if (rms >= openThreshold) {
            candidateSince ??= now - frameMs;
            candidateVoicedMs += frameMs;
            candidateLastAt = now;
            if (candidateVoicedMs >= ATTACK_MS) beginClip(now);
          } else {
            if (now - candidateLastAt > 100) resetCandidate();
            noiseFloor = Math.min(0.012, Math.max(0.001, noiseFloor * 0.97 + rms * 0.03));
          }
          if (!runtime.currentClip) display("listening", level);
        } catch (error) { fail(error); }
      }, 40);
    } catch (error) { fail(error); }
  }, [publish, stop]);

  return { ...snapshot, active: snapshot.status !== "idle", start, stop };
}
