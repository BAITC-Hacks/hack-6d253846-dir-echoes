"use client";

interface AudioOwner {
  epoch: number;
  unlocking?: Promise<boolean>;
}

const owners = new WeakMap<HTMLAudioElement, AudioOwner>();
let silenceUrl: string | undefined;

function ownerOf(audio: HTMLAudioElement) {
  let owner = owners.get(audio);
  if (!owner) { owner = { epoch: 0 }; owners.set(audio, owner); }
  return owner;
}

function cancelled() { return new DOMException("Playback cancelled", "AbortError"); }

function clearHandlers(audio: HTMLAudioElement) {
  // The previous turn must not receive events from silent priming or a new turn.
  audio.onplaying = null;
  audio.onended = null;
  audio.onerror = null;
}

function silentAudioUrl() {
  if (silenceUrl) return silenceUrl;
  // A valid, local 80 ms PCM WAV. It has no network or microphone dependency.
  const samples = 640;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index);
  };
  label(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true);
  label(8, "WAVE"); label(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, samples * 2, true);
  silenceUrl = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
  return silenceUrl;
}

/** Create lazily in a browser event handler, then retain this element per workspace. */
export function createPersistentAudio(): HTMLAudioElement {
  const audio = new Audio();
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");
  ownerOf(audio);
  return audio;
}

/**
 * Invoke directly in the click handler, before its first await. The same element
 * must be passed to createAudioPlayback later. A false result is not permission
 * to ignore an actual play() error: browser policy can still require another tap.
 */
export function unlockAudioPlayback(audio: HTMLAudioElement): Promise<boolean> {
  const owner = ownerOf(audio);
  if (owner.unlocking) return owner.unlocking;
  const epoch = ++owner.epoch;
  clearHandlers(audio);
  audio.pause();
  audio.muted = false;
  const url = silentAudioUrl();
  audio.src = url;
  audio.load();
  // Do not move play() into a promise callback: that would lose the user gesture.
  try {
    const pending = audio.play().then(() => {
      // A real response may have replaced this source while play() was pending.
      if (owner.epoch === epoch && audio.src === url) audio.pause();
      return true;
    }, () => false).finally(() => {
      if (owner.epoch === epoch) owner.unlocking = undefined;
    });
    owner.unlocking = pending;
    return pending;
  } catch {
    return Promise.resolve(false);
  }
}

function eventOnce(target: EventTarget, name: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      target.removeEventListener(name, done);
      target.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      if (timer) clearTimeout(timer);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Не удалось декодировать поток аудио.")); };
    const aborted = () => { cleanup(); reject(cancelled()); };
    if (signal.aborted) return aborted();
    target.addEventListener(name, done, { once: true });
    target.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Браузер не начал обработку аудио. Попробуйте прослушать ответ ещё раз."));
    }, 15_000);
  });
}

/** MSE starts playback before download ends. Other browsers use the same response as a Blob. */
export async function createAudioPlayback(
  response: Response,
  signal: AbortSignal,
  onStreamError: (error: unknown) => void,
  audio = createPersistentAudio(),
) {
  if (signal.aborted) throw cancelled();
  const owner = ownerOf(audio);
  const epoch = ++owner.epoch;
  owner.unlocking = undefined;
  const assertCurrent = () => {
    if (signal.aborted || owner.epoch !== epoch) throw cancelled();
  };
  const install = (url: string) => {
    assertCurrent();
    clearHandlers(audio);
    audio.pause();
    audio.preload = "auto";
    audio.src = url;
    audio.load();
  };
  const play = () => {
    assertCurrent();
    return audio.play().then(() => { assertCurrent(); });
  };
  const mime = (response.headers.get("Content-Type") || "audio/mpeg").split(";")[0];
  if (!response.body || typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime)) {
    const blob = await response.blob();
    assertCurrent();
    if (!blob.size) throw new Error("Сервис озвучивания вернул пустой ответ.");
    if (blob.size > 4_000_000) throw new Error("Превышен размер голосового ответа.");
    const url = URL.createObjectURL(blob);
    try { install(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
    return { audio, url, streamed: false, start: play };
  }
  const source = new MediaSource();
  const opened = eventOnce(source, "sourceopen", signal);
  void opened.catch(() => {}); // Cancellation may arrive before the caller starts playback.
  const url = URL.createObjectURL(source);
  try { install(url); } catch (error) { URL.revokeObjectURL(url); throw error; }
  const body = response.body;
  let started: Promise<void> | undefined;
  return { audio, url, streamed: true, start: () => {
    if (started) return started;
    started = new Promise<void>((resolve, reject) => {
      let playbackRequested = false;
      let playbackReady = false;
      const feed = async () => {
        await opened;
        assertCurrent();
        const buffer = source.addSourceBuffer(mime);
        const reader = body.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        let total = 0;
        try {
          while (true) {
            assertCurrent();
            const next = await reader.read();
            assertCurrent();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > 4_000_000) throw new Error("Превышен размер голосового ответа.");
            const appended = eventOnce(buffer, "updateend", signal);
            try { buffer.appendBuffer(new Uint8Array(next.value)); }
            catch (error) { void appended.catch(() => {}); throw error; }
            await appended;
            assertCurrent();
            if (!playbackRequested) {
              playbackRequested = true;
              // Do not await play here: the decoder may need more than one chunk.
              void play().then(() => { playbackReady = true; resolve(); }, reject);
            }
          }
          if (!total) throw new Error("Сервис озвучивания вернул пустой ответ.");
          if (source.readyState === "open") source.endOfStream();
        } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
        finally {
          signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      };
      void feed().catch(error => {
        if (source.readyState === "open") { try { source.endOfStream("decode"); } catch { /* Already closed. */ } }
        if (playbackReady && !signal.aborted && owner.epoch === epoch) onStreamError(error);
        else reject(error);
      });
    });
    return started;
  } };
}
