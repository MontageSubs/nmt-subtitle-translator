import { zh } from "./locales/zh";
import { en } from "./locales/en";

export type LocaleCode = "zh" | "en";
export type TranslationKey = keyof typeof zh;

const DICTIONARIES: Record<LocaleCode, Record<TranslationKey, string>> = { zh, en };
const LOCALE_STORAGE_KEY = "nmt_locale";

function detectInitialLocale(): LocaleCode {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let currentLocale: LocaleCode = detectInitialLocale();
const listeners = new Set<(locale: LocaleCode) => void>();

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function setLocale(locale: LocaleCode): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  listeners.forEach((fn) => fn(locale));
}

export function onLocaleChange(fn: (locale: LocaleCode) => void): void {
  listeners.add(fn);
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  let text = DICTIONARIES[currentLocale][key] ?? DICTIONARIES.zh[key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  return text;
}
