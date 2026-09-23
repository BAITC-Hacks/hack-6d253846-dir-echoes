export const SPEECH_VOICES = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova",
  "onyx", "sage", "shimmer", "verse", "marin", "cedar",
] as const;

export type SpeechVoice = typeof SPEECH_VOICES[number];
export type SpeechProfile = { model: string; voice: SpeechVoice; styleVersion: "natural-v3" };

/** Shared by generation and cache keys; invalid configuration never starts a paid call. */
export function getSpeechProfile(): SpeechProfile {
  const model = process.env.TTS_MODEL?.trim() || "gpt-4o-mini-tts";
  const configured = process.env.TTS_VOICE?.trim().toLowerCase() || "marin";
  const voice = SPEECH_VOICES.find(candidate => candidate === configured);
  if (!voice) throw new Error("TTS_VOICE_INVALID: select a supported built-in voice.");
  if ((model === "tts-1" || model === "tts-1-hd") && ["ballad", "verse", "marin", "cedar"].includes(voice)) {
    throw new Error("TTS_VOICE_UNSUPPORTED_BY_MODEL: select a voice supported by the configured TTS model.");
  }
  return { model, voice, styleVersion: "natural-v3" };
}
