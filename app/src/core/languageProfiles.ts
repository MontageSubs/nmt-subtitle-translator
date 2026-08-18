export type WritingSystem = "cjk" | "latin" | "other";

export interface LanguageProfile {
  code: string;
  label: string;
  script: "latin" | "cjk" | "cyrillic" | "arabic" | "devanagari" | "hebrew" | "greek" | "thai" | "other";
  writingSystem: WritingSystem;
  usesLatinPunctuation: boolean;
  stripsCjkTerminalPunctuation: boolean;
  preserveInlineStyleTags: boolean;
  enableSpeakerTagStrip: boolean;
  enableStutterResolution: boolean;
  enableDashDialogueSplit: boolean;
  defaultBilingualWithChinese: boolean;
  dictionaryFile: string;
}

interface ProfileOverrides {
  script?: LanguageProfile["script"];
  writingSystem?: WritingSystem;
  usesLatinPunctuation?: boolean;
  stripsCjkTerminalPunctuation?: boolean;
  preserveInlineStyleTags?: boolean;
  enableSpeakerTagStrip?: boolean;
  enableStutterResolution?: boolean;
  enableDashDialogueSplit?: boolean;
  defaultBilingualWithChinese?: boolean;
}

function profile(code: string, label: string, writingSystem: WritingSystem, overrides: ProfileOverrides = {}): LanguageProfile {
  const isLatin = writingSystem === "latin";
  return {
    code, label, writingSystem,
    script: overrides.script ?? (writingSystem === "cjk" ? "cjk" : writingSystem === "latin" ? "latin" : "other"),
    usesLatinPunctuation: overrides.usesLatinPunctuation ?? isLatin,
    stripsCjkTerminalPunctuation: overrides.stripsCjkTerminalPunctuation ?? false,
    preserveInlineStyleTags: overrides.preserveInlineStyleTags ?? isLatin,
    enableSpeakerTagStrip: overrides.enableSpeakerTagStrip ?? isLatin,
    enableStutterResolution: overrides.enableStutterResolution ?? isLatin,
    enableDashDialogueSplit: overrides.enableDashDialogueSplit ?? true,
    defaultBilingualWithChinese: overrides.defaultBilingualWithChinese ?? false,
    dictionaryFile: `${code}.json`,
  };
}

const SOURCE_PROFILES: Record<string, LanguageProfile> = {
  en: profile("en", "English", "latin", { defaultBilingualWithChinese: true }),
  es: profile("es", "Español", "latin"), fr: profile("fr", "Français", "latin"),
  de: profile("de", "Deutsch", "latin"), it: profile("it", "Italiano", "latin"),
  pt: profile("pt", "Português", "latin"), nl: profile("nl", "Nederlands", "latin"),
  pl: profile("pl", "Polski", "latin"), sv: profile("sv", "Svenska", "latin"),
  da: profile("da", "Dansk", "latin"), no: profile("no", "Norsk", "latin"),
  fi: profile("fi", "Suomi", "latin"), ro: profile("ro", "Română", "latin"),
  cs: profile("cs", "Čeština", "latin"), hu: profile("hu", "Magyar", "latin"),
  tr: profile("tr", "Türkçe", "latin"), id: profile("id", "Indonesia", "latin"),
  vi: profile("vi", "Tiếng Việt", "latin"), ms: profile("ms", "Melayu", "latin"),
  tl: profile("tl", "Tagalog", "latin"), ca: profile("ca", "Català", "latin"),
  eu: profile("eu", "Euskara", "latin"), gl: profile("gl", "Galego", "latin"),
  la: profile("la", "Latina", "latin"),
  zh: profile("zh", "中文", "cjk", { stripsCjkTerminalPunctuation: true }),
  ja: profile("ja", "日本語", "cjk", { defaultBilingualWithChinese: true }),
  ko: profile("ko", "한국어", "cjk"),
  ru: profile("ru", "Русский", "other", { script: "cyrillic", enableDashDialogueSplit: true }),
  uk: profile("uk", "Українська", "other", { script: "cyrillic" }),
  bg: profile("bg", "Български", "other", { script: "cyrillic" }),
  ar: profile("ar", "العربية", "other", { script: "arabic" }),
  fa: profile("fa", "فارسی", "other", { script: "arabic" }),
  ur: profile("ur", "اردو", "other", { script: "arabic" }),
  hi: profile("hi", "हिन्दी", "other", { script: "devanagari" }),
  ne: profile("ne", "नेपाली", "other", { script: "devanagari" }),
  mr: profile("mr", "मराठी", "other", { script: "devanagari" }),
  th: profile("th", "ไทย", "other", { script: "thai" }),
  he: profile("he", "עברית", "other", { script: "hebrew" }),
  el: profile("el", "Ελληνικά", "other", { script: "greek" }),
};

const FALLBACK_PROFILE: LanguageProfile = profile("en", "Unknown", "latin");

export function languageProfile(code: string | undefined | null): LanguageProfile {
  const key = (code || "en").split("-")[0].toLowerCase();
  return SOURCE_PROFILES[key] || FALLBACK_PROFILE;
}

export function isChineseTarget(code: string | undefined | null): boolean {
  return (code || "").split("-")[0].toLowerCase() === "zh";
}

export function scriptOf(code: string | undefined | null): LanguageProfile["script"] | null {
  return code ? languageProfile(code).script : null;
}

export function defaultOutputMode(sourceLang: string, targetLang: string): "bilingual" | "monolingual" {
  if (!isChineseTarget(targetLang)) return "monolingual";
  return languageProfile(sourceLang).defaultBilingualWithChinese ? "bilingual" : "monolingual";
}

export const AUTO_DETECT_CODE = "auto";

export const TARGET_LANGUAGES: LanguageProfile[] = [
  SOURCE_PROFILES.zh, SOURCE_PROFILES.en,
  profile("es", "Español", "latin"),
  SOURCE_PROFILES.ja, SOURCE_PROFILES.ko, SOURCE_PROFILES.fr, SOURCE_PROFILES.de,
  SOURCE_PROFILES.ru, SOURCE_PROFILES.ar, SOURCE_PROFILES.pt,
];

export const SOURCE_LANGUAGES: LanguageProfile[] = Object.values(SOURCE_PROFILES);
