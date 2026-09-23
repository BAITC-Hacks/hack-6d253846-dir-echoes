"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PlaybackMeter {
  context: AudioContext;
  sources: Map<HTMLAudioElement, MediaElementAudioSourceNode>;
  analyser: AnalyserNode | null;
  analyserSource: MediaElementAudioSourceNode | null;
  samples: Float32Array<ArrayBuffer> | null;
  audio: HTMLAudioElement | null;
  detachEvents: (() => void) | null;
  frame: number | null;
  lastMeasuredAt: number;
  smoothed: number;
  revision: number;
  disposed: boolean;
  startMeasuring: () => void;
}

const FRAME_MS = 1000 / 15;

function stopFrames(meter: PlaybackMeter) {
  if (meter.frame !== null) cancelAnimationFrame(meter.frame);
  meter.frame = null;
  meter.smoothed = 0;
}

function detachAnalyser(meter: PlaybackMeter) {
  if (meter.analyserSource && meter.analyser) {
    try { meter.analyserSource.disconnect(meter.analyser); } catch { /* The direct speaker path remains connected. */ }
  }
  meter.analyserSource = null;
}

/**
 * Real playback RMS, normalized to 0..1 for a visual indicator, not a loudness
 * measurement. Call prepare(audio) synchronously in the user gesture BEFORE
 * unlockAudioPlayback(audio), and retain that same audio element for playback.
 */
export function usePlaybackMeter() {
  const [level, setLevel] = useState(0);
  const mountedRef = useRef(true);
  const meterRef = useRef<PlaybackMeter | null>(null);
  const publish = useCallback((value: number) => {
    if (mountedRef.current) setLevel(previous => previous === value ? previous : value);
  }, []);

  const prepare = useCallback((audio: HTMLAudioElement): void => {
    if (!mountedRef.current) return;
    let meter = meterRef.current;
    try {
      if (!meter) {
        const AudioContextClass = window.AudioContext
          ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass({ latencyHint: "interactive" });
        meter = {
          context, sources: new Map(), analyser: null, analyserSource: null,
          samples: null, audio: null, detachEvents: null, frame: null,
          lastMeasuredAt: 0, smoothed: 0, revision: 0, disposed: false,
          startMeasuring: () => {},
        };
        meterRef.current = meter;
      }
      const active = meter;
      if (active.disposed || active.context.state === "closed") return;
      const revision = ++active.revision;
      stopFrames(active);
      active.detachEvents?.();
      active.detachEvents = null;
      detachAnalyser(active);
      active.audio = audio;
      publish(0);
      const current = () => !active.disposed && mountedRef.current
        && meterRef.current === active && active.revision === revision && active.audio === audio;
      const canMeasure = () => current() && document.visibilityState !== "hidden"
        && !audio.paused && !audio.ended && active.context.state === "running";

      const measure = (at: number) => {
        active.frame = null;
        if (!canMeasure() || !active.analyser || !active.samples || !active.analyserSource) {
          active.smoothed = 0;
          publish(0);
          return;
        }
        try {
          if (at - active.lastMeasuredAt >= FRAME_MS) {
            active.lastMeasuredAt = at;
            active.analyser.getFloatTimeDomainData(active.samples);
            let sum = 0;
            for (const sample of active.samples) sum += sample * sample;
            const rms = Math.sqrt(sum / active.samples.length);
            const measured = Math.min(1, Math.max(0, rms * 6));
            // Fast attack and gentle release retain actual word pauses.
            active.smoothed += (measured - active.smoothed) * (measured > active.smoothed ? 0.8 : 0.5);
            publish(active.smoothed < 0.005 ? 0 : Math.round(active.smoothed * 100) / 100);
          }
          active.frame = requestAnimationFrame(measure);
        } catch {
          // Meter failure must not disconnect source -> destination.
          detachAnalyser(active);
          active.smoothed = 0;
          publish(0);
        }
      };
      active.startMeasuring = () => {
        if (canMeasure() && active.analyserSource && active.frame === null) {
          active.lastMeasuredAt = 0;
          active.frame = requestAnimationFrame(measure);
        }
      };
      const reset = () => { if (current()) { stopFrames(active); publish(0); } };
      let resumingAfterInterruption = false;
      const recoverContext = () => {
        if (!current() || document.visibilityState === "hidden" || audio.paused
          || active.context.state === "running" || active.context.state === "closed"
          || resumingAfterInterruption) return;
        resumingAfterInterruption = true;
        // Some browsers interrupt a running context after an output-device
        // change. A rejected recovery remains retryable by the next user tap.
        void active.context.resume().then(() => {
          if (current()) active.startMeasuring();
        }, () => { if (current()) publish(0); }).finally(() => { resumingAfterInterruption = false; });
      };
      const playing = () => {
        if (!current()) return;
        recoverContext();
        active.startMeasuring();
      };
      audio.addEventListener("playing", playing);
      for (const name of ["pause", "ended", "emptied", "error"]) audio.addEventListener(name, reset);
      active.detachEvents = () => {
        audio.removeEventListener("playing", playing);
        for (const name of ["pause", "ended", "emptied", "error"]) audio.removeEventListener(name, reset);
      };
      active.context.onstatechange = () => {
        if (!current()) return;
        if (active.context.state === "running") active.startMeasuring();
        else { reset(); recoverContext(); }
      };

      // resume() itself stays inside the click, not inside a deferred callback.
      const resumed = active.context.resume();
      void resumed.then(() => {
        if (!current() || active.context.state !== "running") return;
        try {
          let source = active.sources.get(audio);
          if (!source) {
            // Until resume succeeded, the element kept its native speaker path.
            source = active.context.createMediaElementSource(audio);
            active.sources.set(audio, source);
          }
          // Repeating an identical connection is harmless and retries a setup
          // interrupted by a browser context transition on an earlier prepare.
          source.connect(active.context.destination);
          // The analyser is a side branch. Its creation/reads cannot mute sound.
          if (!active.analyser) {
            active.analyser = active.context.createAnalyser();
            active.analyser.fftSize = 1024;
            active.samples = new Float32Array(active.analyser.fftSize);
          }
          source.connect(active.analyser);
          active.analyserSource = source;
          active.startMeasuring();
        } catch { detachAnalyser(active); publish(0); }
      }, () => {
        // If the browser refuses initial resume, no source was created and
        // normal HTMLAudioElement playback remains available.
        if (current()) publish(0);
      });
    } catch {
      // Web Audio is optional. Never propagate meter setup errors into speech.
      publish(0);
    }
  }, [publish]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => {
      const meter = meterRef.current;
      if (!meter) return;
      if (document.visibilityState === "hidden") {
        stopFrames(meter);
        publish(0);
        // Do not suspend/close the context or disconnect the speaker path.
      } else meter.startMeasuring();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      const meter = meterRef.current;
      meterRef.current = null;
      if (!meter) return;
      meter.disposed = true;
      meter.revision++;
      stopFrames(meter);
      meter.detachEvents?.();
      meter.context.onstatechange = null;
      // Retire these elements with the workspace: a media element cannot be
      // attached to a second MediaElementSource after its context is closed.
      for (const [audio, source] of meter.sources) {
        audio.pause();
        try { source.disconnect(); } catch { /* Already detached. */ }
      }
      meter.sources.clear();
      try { meter.analyser?.disconnect(); } catch { /* Already detached. */ }
      if (meter.context.state !== "closed") void meter.context.close().catch(() => {});
    };
  }, [publish]);

  return { level, prepare };
}
