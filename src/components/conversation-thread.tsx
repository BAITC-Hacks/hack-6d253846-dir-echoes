"use client";

import { AudioLines, ChevronRight, Clock3, GitBranch, Headphones, MessageSquare, Mic, Square, UserRound, Volume2 } from "lucide-react";
import type { Role, SessionDetail, Turn } from "@/lib/types";
import { duration, Spinner, time } from "./workspace-ui";

type ConversationThreadProps = {
  detail: SessionDetail;
  turns: Turn[];
  viewerRole: Role;
  selectedTurnId: string | null;
  playingTurnId: string | null;
  audioLoadingId: string | null;
  busy: boolean;
  voiceCallActive: boolean;
  onAudio: (turn: Turn) => void;
  onTrace: (turnId: string) => void;
};

/** Presentation only: scrolling and audio ownership stay in VoiceWorkspace. */
export function ConversationThread({ detail, turns, viewerRole, selectedTurnId, playingTurnId, audioLoadingId, busy, voiceCallActive, onAudio, onTrace }: ConversationThreadProps) {
  const customerLabel = viewerRole === "supervisor" ? "Клиент" : "Вы";
  return <div className="messages conversation-thread">
    <div className="conversation-date"><span>{new Date(detail.session.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}</span></div>
    {turns.map(turn => {
      const speaker = turn.mode === "operator" ? "operator" : turn.trace.source === "operator" ? "system" : "assistant";
      const speakerLabel = speaker === "operator" ? "Оператор" : speaker === "system" ? "Система" : "AI-ассистент";
      const playing = playingTurnId === turn.id;
      const loading = audioLoadingId === turn.id;
      return <div className="turn-group" id={`conversation-turn-${turn.id}`} key={turn.id}>
        {turn.mode !== "operator" && turn.userText && <article className="message message-user transcript-message" data-speaker="user" aria-label={`Реплика: ${customerLabel}`}>
          <span className="transcript-avatar" aria-hidden="true"><UserRound size={14} /></span>
          <div className="transcript-message-content">
            <div className="message-meta"><strong className="transcript-speaker">{customerLabel}</strong><time dateTime={turn.createdAt}>{time(turn.createdAt)}</time>{turn.mode === "voice" && <Mic size={12} aria-label="Голосовая реплика" />}</div>
            <div className="message-bubble" dir="auto">{turn.userText}</div>
          </div>
        </article>}
        <article className={`message message-assistant transcript-message ${selectedTurnId === turn.id ? "message-selected" : ""}`} data-speaker={speaker} aria-label={`Реплика: ${speakerLabel}`}>
          <span className="transcript-avatar" aria-hidden="true">{speaker === "operator" ? <Headphones size={14} /> : speaker === "system" ? <MessageSquare size={14} /> : <AudioLines size={15} />}</span>
          <div className="assistant-message-content transcript-message-content">
            <div className="message-meta"><strong className="transcript-speaker">{speakerLabel}</strong><time dateTime={turn.createdAt}>{time(turn.createdAt)}</time>{speaker === "operator" && <span className="transcript-human-label">Человек</span>}</div>
            <div className="message-bubble" dir="auto">{turn.assistantText}</div>
            <div className="message-actions">
              <button type="button" onClick={() => onAudio(turn)} disabled={voiceCallActive || (busy && !loading)} aria-label={playing ? "Остановить озвучивание" : "Слушать ответ"}>
                {loading ? <Spinner /> : playing ? <Square size={12} fill="currentColor" /> : <Volume2 size={13} />}{loading ? "Подготовка…" : playing ? "Остановить" : "Слушать ответ"}
              </button>
              <button type="button" className={selectedTurnId === turn.id ? "selected" : ""} onClick={() => onTrace(turn.id)}><GitBranch size={13} />Решение {detail.turns.indexOf(turn) + 1}<ChevronRight size={12} /></button>
              <span className="message-duration"><Clock3 size={11} />{duration(turn.trace.timings.serverTotal)}</span>
            </div>
          </div>
        </article>
      </div>;
    })}
  </div>;
}
