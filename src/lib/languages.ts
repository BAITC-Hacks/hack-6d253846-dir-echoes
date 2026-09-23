import type { DialogueState, Language, ReviewedLanguage, SpokenLanguage } from "./types";

export const SPOKEN_LANGUAGES = ["ru", "kk", "tr"] as const;
export function isReviewedLanguage(value: unknown): value is ReviewedLanguage {
  return value === "ru" || value === "kk" || value === "tr";
}
/** Syntax/canonicalization is validation of a code, not a promise of model quality. */
export function normalizeLanguageCode(value: unknown): SpokenLanguage | null {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(value) || value.length > 35) return null;
  try {
    const base = new Intl.Locale(value).language.toLowerCase();
    return /^[a-z]{2,3}$/u.test(base) && !["und", "mul", "zxx"].includes(base) ? base : null;
  } catch { return null; }
}
export function hasUnreviewedLanguages(values: readonly SpokenLanguage[]): boolean {
  return values.length === 0 || values.some(value => !isReviewedLanguage(value));
}
export function isLanguage(value: unknown): value is Language {
  return isReviewedLanguage(value) || value === "mixed" || value === "other";
}

export function uniqueLanguages(values: readonly unknown[] | undefined): SpokenLanguage[] {
  return [...new Set((values ?? []).map(normalizeLanguageCode).filter((value): value is SpokenLanguage => value !== null))].slice(0, 4);
}

export function languageFromList(values: readonly SpokenLanguage[]): Language {
  const valid = uniqueLanguages(values);
  return valid.length > 1 ? "mixed" : isReviewedLanguage(valid[0]) ? valid[0] : "other";
}

/** Missing mixed arrays are legacy RU/KK records, never the new router contract. */
export function spokenLanguages(language: Language, values?: readonly SpokenLanguage[]): SpokenLanguage[] {
  const valid = uniqueLanguages(values);
  if (valid.length && languageFromList(valid) === language) return valid;
  return language === "mixed" ? ["ru", "kk"] : isReviewedLanguage(language) ? [language] : [];
}

export function stateLanguages(state: Pick<DialogueState, "language" | "responseLanguages">): SpokenLanguage[] {
  return spokenLanguages(state.language, state.responseLanguages);
}

/** Reviewed short wording; callers supply distinct mixed phrases where appropriate. */
export function languagePhrase(languages: readonly SpokenLanguage[], phrases: {
  ru: string; kk: string; tr: string; ru_kk?: string; ru_tr?: string; kk_tr?: string; ru_kk_tr?: string; other?: string;
}): string {
  const set = uniqueLanguages(languages);
  if (hasUnreviewedLanguages(set)) return phrases.other ?? "Please choose a language for this step or ask for an operator. No change has been confirmed.";
  if (set.length === 3) return phrases.ru_kk_tr ?? phrases.kk_tr ?? phrases.tr;
  if (set.length === 2) {
    if (set.includes("tr")) return set.includes("kk") ? phrases.kk_tr ?? phrases.tr : phrases.ru_tr ?? phrases.tr;
    return phrases.ru_kk ?? phrases.ru;
  }
  const language = set[0];
  return isReviewedLanguage(language) ? phrases[language] : phrases.other ?? "Please specify your preferred language.";
}
