"use client";

import { ArrowUpRight, GitBranch, Headphones, ShieldCheck, X } from "lucide-react";
import type { Scenario, SessionDetail } from "@/lib/types";
import { languageLabel, scenarioDisplayName } from "./workspace-ui";

export function ConversationContext({ detail, catalog, busy, onClose, onTrace, onResumeTopic }: {
  detail: SessionDetail | null;
  catalog: Scenario[];
  busy: boolean;
  onClose: () => void;
  onTrace: () => void;
  onResumeTopic: (text: string) => void;
}) {
  const state = detail?.session.state;
  const latest = detail?.turns.at(-1);
  const selectedId = state?.activeScenarioId ?? latest?.trace.scenarios[0]?.scenarioId;
  const name = (id: string) => scenarioDisplayName(id, catalog.find(item => item.scenario_id === id)?.name);
  const pendingTopics = [...new Set([...(state?.suspendedScenarioIds ?? []), ...(state?.pendingScenarioIds ?? [])])].filter(id => id !== state?.activeScenarioId);

  return <aside className="context-rail" id="conversation-details" aria-label="Подсказки по разговору">
    <header><strong>Сейчас в разговоре</strong><button className="icon-button" onClick={onClose} aria-label="Скрыть подсказки"><X size={18} /></button></header>
    <section className="context-card"><span className="rail-label">Текущая тема</span><h3>{selectedId ? name(selectedId) : "Начнём с вашего вопроса"}</h3><p>{latest ? `Язык: ${languageLabel(latest.trace.language, latest.trace.inputLanguages)}` : "Расскажите, с чем нужна помощь. Можно менять тему — контекст сохранится."}</p></section>
    {state?.pendingConfirmation && <section className="context-card context-confirmation"><span className="rail-label"><ShieldCheck size={14} />Нужно ваше решение</span><p>{state.pendingConfirmation.summary}</p><strong>Скажите «да» или «нет».</strong><small>До подтверждения действие не выполняется.</small></section>}
    {state?.status === "handoff" && <section className="context-card"><span className="rail-label"><Headphones size={14} />У оператора</span><p>Контекст передан специалисту. Его ответ появится в этом разговоре.</p></section>}
    {state?.status === "closed" && <section className="context-card"><span className="rail-label">Разговор завершён</span><p>История сохранена. Для следующего вопроса создайте новый разговор.</p></section>}
    {pendingTopics.length > 0 && <section className="context-card"><span className="rail-label">Вернуться к вопросу</span><div className="context-topics">{pendingTopics.map(id => <button key={id} disabled={busy || state?.status !== "active"} onClick={() => onResumeTopic(`Вернёмся к вопросу: ${name(id)}`)}><span>{name(id)}</span><ArrowUpRight size={15} /></button>)}</div><small>Выберите тему и отправьте сообщение, чтобы продолжить.</small></section>}
    <section className="context-card context-privacy"><span className="rail-label"><ShieldCheck size={14} />Данные кейса</span><p>Используйте предоставленные тестовые данные. Не называйте реальные ИИН, телефоны и номера полисов.</p></section>
    <footer className="context-rail-footer"><button className="button button-secondary" onClick={onTrace} disabled={!latest}><GitBranch size={16} />Показать логику ответа</button><small>Сценарий, причины выбора и время каждого этапа.</small></footer>
  </aside>;
}
