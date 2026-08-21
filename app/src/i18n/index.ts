import { zh } from "./locales/zh";
import { en } from "./locales/en";

export type LocaleCode = "zh" | "en";
export type TranslationKey = keyof typeof zh;
export type TextDirection = "ltr" | "rtl";

const DICTIONARIES: Record<LocaleCode, Record<TranslationKey, string>> = { zh, en };
const LOCALE_DIRECTIONS: Record<LocaleCode, TextDirection> = { zh: "ltr", en: "ltr" };
const LOCALE_STORAGE_KEY = "nmt_locale";

function detectInitialLocale(): LocaleCode {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function applyDocumentDirection(locale: LocaleCode): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = LOCALE_DIRECTIONS[locale];
}

let currentLocale: LocaleCode = detectInitialLocale();
applyDocumentDirection(currentLocale);
const listeners = new Set<(locale: LocaleCode) => void>();

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function getDirection(): TextDirection {
  return LOCALE_DIRECTIONS[currentLocale];
}

export function setLocale(locale: LocaleCode): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  applyDocumentDirection(locale);
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
