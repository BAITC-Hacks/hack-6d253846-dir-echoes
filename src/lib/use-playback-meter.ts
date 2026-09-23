"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PlaybackMeter {
  audio: HTMLAudioElement;
  sourceUrl: string;
  envelope: Float32Array | null;
  frame: number | null;
  lastMeasuredAt: number;
  smoothed: number;
  decodeRevision: number;
  detachEvents: () => void;
  startMeasuring: () => void;
}

const FRAME_MS = 1000 / 15;
const ENVELOPE_SECONDS = 0.02;
const MAX_AUDIO_BYTES = 4_000_000;
const MAX_AUDIO_SECONDS = 180;

function stopFrames(meter: PlaybackMeter) {
  if (meter.frame !== null) cancelAnimationFrame(meter.frame);
  meter.frame = null;
  meter.smoothed = 0;
}

/**
 * Reads a decoded COPY of the completed response and follows audio.currentTime.
 * Never captures/reroutes the media element, connects to a speaker destination,
 * or calls play/pause/load. Native playback works independently of this meter.
 * During an unfinished stream or unsupported decoding, the real level is unknown
 * and remains zero rather than being replaced by invented audio activity.
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
    const previous = meterRef.current;
    if (previous?.audio === audio) return;
    if (previous) {
      previous.decodeRevision++;
      stopFrames(previous);
      previous.detachEvents();
    }
    const meter: PlaybackMeter = {
      audio, sourceUrl: "", envelope: null, frame: null, lastMeasuredAt: 0,
      smoothed: 0, decodeRevision: 0, detachEvents: () => {}, startMeasuring: () => {},
    };
    meterRef.current = meter;
    publish(0);
    const current = () => mountedRef.current && meterRef.current === meter;
    const canMeasure = () => current() && document.visibilityState !== "hidden"
      && !audio.paused && !audio.ended && !audio.muted && audio.volume > 0
      && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && meter.sourceUrl === audio.src && meter.envelope !== null;
    const reset = () => {
      if (!current()) return;
      stopFrames(meter);
      publish(0);
    };
    const measure = (at: number) => {
      meter.frame = null;
      if (!canMeasure() || !meter.envelope) { reset(); return; }
      if (at - meter.lastMeasuredAt >= FRAME_MS) {
        meter.lastMeasuredAt = at;
        const index = Math.max(0, Math.floor(audio.currentTime / ENVELOPE_SECONDS));
        // Cover the recent interval between UI frames, preserving short words.
        let rms = 0;
        for (let offset = 0; offset < 4; offset++) {
          rms = Math.max(rms, meter.envelope[Math.max(0, index - offset)] ?? 0);
        }
        const measured = Math.min(1, rms * 6 * audio.volume);
        meter.smoothed += (measured - meter.smoothed) * (measured > meter.smoothed ? 0.8 : 0.5);
        publish(meter.smoothed < 0.005 ? 0 : Math.round(meter.smoothed * 100) / 100);
      }
      meter.frame = requestAnimationFrame(measure);
    };
    meter.startMeasuring = () => {
      if (canMeasure() && meter.frame === null) {
        meter.lastMeasuredAt = 0;
        meter.frame = requestAnimationFrame(measure);
      }
    };
    const start = () => { if (current()) meter.startMeasuring(); };
    const sourceChanged = () => {
      if (!current()) return;
      reset();
      // load() events can arrive after a completed Blob was handed to analyse.
      // Do not discard a decode already associated with the current source URL.
      if (meter.sourceUrl !== audio.src) {
        meter.decodeRevision++;
        meter.sourceUrl = "";
        meter.envelope = null;
      }
    };
    const volumeChanged = () => { reset(); start(); };
    const startEvents = ["playing", "seeked", "timeupdate"];
    const resetEvents = ["pause", "ended", "waiting", "error"];
    for (const name of startEvents) audio.addEventListener(name, start);
    for (const name of resetEvents) audio.addEventListener(name, reset);
    audio.addEventListener("emptied", sourceChanged);
    audio.addEventListener("volumechange", volumeChanged);
    meter.detachEvents = () => {
      for (const name of startEvents) audio.removeEventListener(name, start);
      for (const name of resetEvents) audio.removeEventListener(name, reset);
      audio.removeEventListener("emptied", sourceChanged);
      audio.removeEventListener("volumechange", volumeChanged);
    };
  }, [publish]);

  const analyse = useCallback((blob: Blob, audio: HTMLAudioElement, sourceUrl: string): void => {
    if (!mountedRef.current || audio.src !== sourceUrl || !blob.size || blob.size > MAX_AUDIO_BYTES) return;
    prepare(audio);
    const meter = meterRef.current;
    if (!meter || meter.audio !== audio) return;
    const revision = ++meter.decodeRevision;
    meter.sourceUrl = sourceUrl;
    meter.envelope = null;
    stopFrames(meter);
    publish(0);
    const current = () => mountedRef.current && meterRef.current === meter
      && meter.decodeRevision === revision && audio.src === sourceUrl;
    void (async () => {
      try {
        const OfflineContext = window.OfflineAudioContext
          ?? (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
        if (!OfflineContext) return;
        const bytes = await blob.arrayBuffer();
        if (!current()) return;
        // Offline decoding does not create a live audio device or need resume().
        const decoder = new OfflineContext(1, 1, 24_000);
        const decoded = await decoder.decodeAudioData(bytes);
        if (!current() || decoded.duration > MAX_AUDIO_SECONDS || !decoded.length) return;
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
        const windowSize = Math.max(1, Math.round(decoded.sampleRate * ENVELOPE_SECONDS));
        const envelope = new Float32Array(Math.ceil(decoded.length / windowSize));
        for (let index = 0; index < envelope.length; index++) {
          const start = index * windowSize;
          const end = Math.min(decoded.length, start + windowSize);
          let sum = 0;
          for (const channel of channels) {
            for (let sample = start; sample < end; sample++) sum += channel[sample] * channel[sample];
          }
          envelope[index] = Math.sqrt(sum / ((end - start) * channels.length));
        }
        if (!current()) return;
        meter.envelope = envelope;
        meter.startMeasuring();
      } catch {
        // Native playback is unaffected by unsupported/failed optional decoding.
        if (current()) { meter.envelope = null; publish(0); }
      }
    })();
  }, [prepare, publish]);

  useEffect(() => {
    mountedRef.current = true;
    const onVisibility = () => {
      const meter = meterRef.current;
      if (!meter) return;
      if (document.visibilityState === "hidden") { stopFrames(meter); publish(0); }
      else meter.startMeasuring();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      const meter = meterRef.current;
      meterRef.current = null;
      if (!meter) return;
      meter.decodeRevision++;
      stopFrames(meter);
      meter.detachEvents();
      meter.envelope = null;
      // Playback ownership stays with audio-playback/workspace, even at unmount.
    };
  }, [publish]);

  return { level, prepare, analyse };
}
