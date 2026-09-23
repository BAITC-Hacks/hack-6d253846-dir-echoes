import { randomBytes } from "node:crypto";

type PrivateKind = "PHONE" | "IIN" | "EMAIL" | "IDENTIFIER";
type PrivateValue = { raw: string; kind: PrivateKind };
const MASK = "•••";
const placeholderPattern = /\[PRIVATE[^\]\r\n]*\]/giu;

// Recognizable written forms only: email, organizer record numbers, 12-digit IIN
// (optionally grouped), and Kazakhstan-shaped 10/11-digit phone numbers. Long unlabelled
// amounts may match conservatively; structured non-identity numbers stay numbers.
// This is not universal name/address detection or protection before audio STT.
const recognizablePattern = /(?<email>[\p{L}\d.!#$%&'*+\/=?^_`{|}~-]+@[\p{L}\d](?:[\p{L}\d.-]*[\p{L}\d])?\.[\p{L}]{2,})|(?<record>(?<![\p{L}\p{N}_])(?:SQ-(?:OGPO|CASCO|TRVL|PROP|NS|DMS)-\d{6}|CL-\d{6})(?![\p{L}\p{N}_]))|(?<iin>(?<![\p{L}\p{N}_])(?:\d{12}|\d{6}[ \t-]\d{6}|\d{3}(?:[ \t-]\d{3}){3}|\d{4}(?:[ \t-]\d{4}){2})(?![\p{L}\p{N}_]))|(?<phone>(?<![\p{L}\p{N}_])(?:\+?[78][ \t.-]*(?:\(\d{3}\)|\d{3})[ \t.-]*\d{3}[ \t.-]*\d{2}[ \t.-]*\d{2}|(?:\(7\d{2}\)|7\d{2})[ \t.-]*\d{3}[ \t.-]*\d{2}[ \t.-]*\d{2})(?![\p{L}\p{N}_]))/giu;
const publicSpanPattern = /\b(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}\.\d{2}\.\d{4})\b/giu;

function replaceRecognizable(text: string, replacement: (raw: string, groups: Record<string, string | undefined>) => string): string {
  const replace = (part: string) => part.replace(recognizablePattern, (...args: unknown[]) => replacement(args[0] as string, args.at(-1) as Record<string, string | undefined>));
  let result = "", offset = 0;
  // An IIN-shaped UUID suffix is part of the UUID, and two dates are never a
  // grouped identifier. Known private fields are handled separately by their keys.
  for (const match of text.matchAll(publicSpanPattern)) {
    result += replace(text.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return result + replace(text.slice(offset));
}

export class PrivacySlotError extends Error {
  constructor() { super("Unrecognized private-data placeholder in slot"); this.name = "PrivacySlotError"; }
}

function fieldKind(key: string): PrivateKind | null {
  const normalized = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).toLowerCase();
  if (["iin", "new_driver_iin", "drivers_iin"].includes(normalized)) return "IIN";
  if (["phone", "phone_number", "client_phone"].includes(normalized)) return "PHONE";
  if (["email", "email_address", "client_email"].includes(normalized)) return "EMAIL";
  if (["id", "client_id", "customer_id", "policy_number", "previous_policy_number", "claim_number", "vehicle_plate", "culprit_vehicle_plate", "payment_id", "request_id", "session_id", "operation_id", "ticket_id", "outbox_id"].includes(normalized)) return "IDENTIFIER";
  return null;
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** A reverse map exists only in memory for one router/composer request. Never log it. */
export function createPrivacyContext() {
  const namespace = randomBytes(12).toString("hex");
  const byRaw = new Map<string, string>();
  const byToken = new Map<string, PrivateValue>();

  function register(raw: string, kind: PrivateKind): string {
    const existing = byRaw.get(raw);
    if (existing) return existing;
    const token = `[PRIVATE_${namespace}_${kind}_${byRaw.size + 1}]`;
    byRaw.set(raw, token);
    byToken.set(token, { raw, kind });
    return token;
  }

  function sensitiveKind(key: string, parent?: Record<string, unknown>): PrivateKind | null {
    if (key === "new_value" && typeof parent?.contact_field === "string") return fieldKind(parent.contact_field);
    return fieldKind(key);
  }

  function collect(value: unknown, kind: PrivateKind | null = null): void {
    if ((typeof value === "string" || typeof value === "number") && kind) {
      if (String(value)) register(String(value), kind);
    } else if (Array.isArray(value)) {
      value.forEach(item => collect(item, kind));
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(object)) collect(item, sensitiveKind(key, object));
    }
  }

  function replaceKnown(text: string, redact: boolean): string {
    if (!byRaw.size) return text;
    // One replacement pass prevents a value from matching inside a newly created
    // token. Boundaries avoid replacing a short record ID inside an unrelated word.
    const alternatives = [...byRaw.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "gu");
    return text.replace(pattern, raw => redact ? MASK : byRaw.get(raw)!);
  }

  function transformText(text: string, redact: boolean): string {
    const known = replaceKnown(text, redact);
    const recognized = replaceRecognizable(known, (raw, groups) => {
      const kind: PrivateKind = groups.email ? "EMAIL" : groups.iin ? "IIN" : groups.phone ? "PHONE" : "IDENTIFIER";
      return redact ? MASK : register(raw, kind);
    });
    return redact ? recognized.replace(placeholderPattern, MASK) : recognized;
  }

  function transform(value: unknown, redact: boolean, kind: PrivateKind | null = null): unknown {
    if ((typeof value === "string" || typeof value === "number") && kind && String(value)) return redact ? MASK : register(String(value), kind);
    if (typeof value === "string") return transformText(value, redact);
    if (Array.isArray(value)) return value.map(item => transform(item, redact, kind));
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, transform(item, redact, sensitiveKind(key, object))]));
    }
    return value;
  }

  return {
    pseudonymize<T>(value: T): T { collect(value); return transform(value, false) as T; },
    pseudonymizeText(text: string): string { return transformText(text, false); },
    redact<T>(value: T): T { collect(value); return transform(value, true) as T; },
    redactText(text: string): string { return transformText(text, true); },
    /** Use only on an extracted slot, never a reason, clarification or reply. */
    restoreSlot(value: string, type: string): string {
      const restoreText = (text: string) => text.replace(placeholderPattern, token => {
        const entry = byToken.get(token);
        if (!entry) throw new PrivacySlotError();
        return entry.raw;
      });
      if (type === "list") {
        const list: unknown = JSON.parse(value);
        if (!Array.isArray(list)) throw new Error("Invalid list slot");
        // Restore after JSON parsing so quotes/backslashes in a value cannot
        // become JSON syntax or change the number of extracted list elements.
        return JSON.stringify(list.map(item => {
          if (typeof item !== "string") return item;
          const entry = byToken.get(item);
          // The organizer's IIN list contract expects contiguous digit strings.
          // Remove formatting only; never convert to Number or lose leading zeroes.
          if (entry?.kind === "IIN" && /^[\d \t-]+$/u.test(entry.raw)) return entry.raw.replace(/[ \t-]/g, "");
          return restoreText(item);
        }));
      }
      const entry = byToken.get(value);
      if (type === "integer" && entry && /^\d[\d \t]*$/u.test(entry.raw)) return entry.raw.replace(/[ \t]/g, "");
      return restoreText(value);
    },
  };
}

export type PrivacyContext = ReturnType<typeof createPrivacyContext>;

/** Outgoing factual prompts only: this also masks known identifier fields, not API DTOs. */
export function redactPrivateData<T>(value: T): T { return createPrivacyContext().redact(value); }

/** Text prompts, including recognizable organizer policy/claim record numbers. */
export function maskPrivateText(text: string): string { return createPrivacyContext().redactText(text); }

/** Repository/UI reuse: phones/IIN/email only; UUIDs, dates and record IDs survive. */
export function redactPersonalText(text: string): string {
  return replaceRecognizable(text, (raw, groups) => groups.record ? raw : MASK);
}
