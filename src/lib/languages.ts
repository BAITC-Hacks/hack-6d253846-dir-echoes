import type { DialogueState, Language, SpokenLanguage } from "./types";

export const SPOKEN_LANGUAGES = ["ru", "kk", "tr"] as const;
export function isLanguage(value: unknown): value is Language {
  return value === "ru" || value === "kk" || value === "tr" || value === "mixed";
}

export function uniqueLanguages(values: readonly unknown[] | undefined): SpokenLanguage[] {
  return [...new Set((values ?? []).filter((value): value is SpokenLanguage => value === "ru" || value === "kk" || value === "tr"))];
}

export function languageFromList(values: readonly SpokenLanguage[]): Language {
  return values.length > 1 ? "mixed" : values[0] ?? "ru";
}

/** Missing mixed arrays are legacy RU/KK records, never the new router contract. */
export function spokenLanguages(language: Language, values?: readonly SpokenLanguage[]): SpokenLanguage[] {
  const valid = uniqueLanguages(values);
  if (valid.length && (language === "mixed" ? valid.length > 1 : valid.length === 1 && valid[0] === language)) return valid;
  return language === "mixed" ? ["ru", "kk"] : [language];
}

export function stateLanguages(state: Pick<DialogueState, "language" | "responseLanguages">): SpokenLanguage[] {
  return spokenLanguages(state.language, state.responseLanguages);
}

/** Reviewed short wording; callers supply distinct mixed phrases where appropriate. */
export function languagePhrase(languages: readonly SpokenLanguage[], phrases: {
  ru: string; kk: string; tr: string; ru_kk?: string; ru_tr?: string; kk_tr?: string; ru_kk_tr?: string;
}): string {
  const set = uniqueLanguages(languages);
  if (set.length === 3) return phrases.ru_kk_tr ?? phrases.kk_tr ?? phrases.tr;
  if (set.length === 2) {
    if (set.includes("tr")) return set.includes("kk") ? phrases.kk_tr ?? phrases.tr : phrases.ru_tr ?? phrases.tr;
    return phrases.ru_kk ?? phrases.ru;
  }
  return phrases[set[0] ?? "ru"];
}
