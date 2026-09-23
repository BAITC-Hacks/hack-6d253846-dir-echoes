"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Check, Headphones, LockKeyhole, MessageSquare, Moon, ShieldCheck, Sun } from "lucide-react";
import type { Role } from "@/lib/types";
import { BrandMark } from "./brand-mark";
import { api, ErrorNotice, readableError, Spinner } from "./workspace-ui";
import styles from "./auth-gate.module.css";

export function AuthGate({ onSuccess, initialError, theme, onToggleTheme }: {
  onSuccess: () => Promise<void>;
  initialError: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [code, setCode] = useState("");
  const [role, setRole] = useState<Role>("participant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      await api("/api/auth", { method: "POST", body: JSON.stringify({ code: code.trim(), role }) });
      setCode(""); await onSuccess();
    } catch (err) { setError(readableError(err)); }
    finally { setBusy(false); }
  }
  return <main className={styles.page} data-theme={theme}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.brandIcon}><BrandMark size={46} /></span><span>DIR ECHOES<small>VOICE ROUTER</small></span></div>
      <button className={styles.theme} type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === "dark" ? "Светлая тема" : "Тёмная тема"}</span></button>
    </header>
    <div className={styles.layout}>
      <section className={styles.story} aria-labelledby="welcome-title">
        <span className={styles.eyebrow}><i />ГОЛОСОВОЙ КОНТАКТ-ЦЕНТР</span>
        <h1 id="welcome-title" className={styles.headline}>Разговор,<br />который ведёт<br /><em>к решению.</em></h1>
        <p className={styles.description}>Расскажите о своём вопросе.<br />Ассистент сохранит контекст, а человек<br className={styles.desktopBreak} /> подключится, когда это нужно.</p>
        <div className={styles.signature} aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
        <div className={styles.storyNote}><ShieldCheck size={17} /><span>Действия — только с вашего согласия.</span></div>
      </section>
      <section className={styles.access} aria-labelledby="access-title">
        <div className={styles.accessHeader}><span className={styles.step}>ВАШЕ ПРОСТРАНСТВО</span><h2 id="access-title">Добро пожаловать</h2><p>Выберите роль и введите выданный код.</p></div>
        <form onSubmit={submit} className={styles.form}>
          <fieldset className={styles.roles} disabled={busy}><legend>Как вы хотите войти?</legend>
            <button type="button" className={styles.role} data-selected={role === "participant"} aria-pressed={role === "participant"} onClick={() => { setRole("participant"); setError(null); }}><MessageSquare size={21} /><span><strong>Клиент</strong><small>Разговор с ассистентом</small></span><i>{role === "participant" && <Check size={12} />}</i></button>
            <button type="button" className={styles.role} data-selected={role === "supervisor"} aria-pressed={role === "supervisor"} onClick={() => { setRole("supervisor"); setError(null); }}><Headphones size={21} /><span><strong>Супервизор</strong><small>Диалоги и помощь клиентам</small></span><i>{role === "supervisor" && <Check size={12} />}</i></button>
          </fieldset>
          <p className={styles.roleHint} aria-live="polite">{role === "supervisor" ? "Наблюдайте за диалогами и подключайтесь к клиенту своим голосом." : "Задайте вопрос голосом или текстом. История разговора сохранится."}</p>
          <label className={styles.label} htmlFor="access-code">Код доступа <span>{role === "supervisor" ? "супервизора" : "клиента"}</span></label>
          <div className={styles.code}><LockKeyhole size={18} /><input id="access-code" type="password" autoComplete="current-password" placeholder="Введите ваш код" value={code} onChange={event => setCode(event.target.value)} disabled={busy} required maxLength={200} /></div>
          {error && <ErrorNotice message={error} onDismiss={() => setError(null)} />}
          <button className={styles.submit} type="submit" disabled={!code.trim() || busy}>{busy ? <Spinner label="Подключаемся…" /> : <><span>{role === "supervisor" ? "Открыть Live · Диалоги" : "Начать общение"}</span><ArrowRight size={19} /></>}</button>
          <p className={styles.privacy}><LockKeyhole size={13} />Используйте данные кейса. Не вводите и не произносите реальные персональные данные.</p>
        </form>
      </section>
    </div>
    <footer className={styles.footer}><span>DIR ECHOES · Voice Router</span><span>Голос. Контекст. Решение.</span></footer>
  </main>;
}
