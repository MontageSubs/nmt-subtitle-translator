type WritingSystem = "cjk" | "latin" | "other";

export interface LanguageProfile {
  code: string;
  script: "latin" | "cjk" | "cyrillic" | "arabic" | "devanagari" | "hebrew" | "greek" | "thai" | "other";
  writingSystem: WritingSystem;
  usesLatinPunctuation: boolean;
  stripsCjkTerminalPunctuation: boolean;
  preserveInlineStyleTags: boolean;
  enableSpeakerTagStrip: boolean;
  enableStutterResolution: boolean;
  enableDashDialogueSplit: boolean;
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
}

function profile(code: string, writingSystem: WritingSystem, overrides: ProfileOverrides = {}): LanguageProfile {
  const isLatin = writingSystem === "latin";
  return {
    code, writingSystem,
    script: overrides.script ?? (writingSystem === "cjk" ? "cjk" : writingSystem === "latin" ? "latin" : "other"),
    usesLatinPunctuation: overrides.usesLatinPunctuation ?? isLatin,
    stripsCjkTerminalPunctuation: overrides.stripsCjkTerminalPunctuation ?? false,
    preserveInlineStyleTags: overrides.preserveInlineStyleTags ?? isLatin,
    enableSpeakerTagStrip: overrides.enableSpeakerTagStrip ?? isLatin,
    enableStutterResolution: overrides.enableStutterResolution ?? isLatin,
    enableDashDialogueSplit: overrides.enableDashDialogueSplit ?? true,
  };
}

const SOURCE_PROFILES: Record<string, LanguageProfile> = {
  en: profile("en", "latin"),
  es: profile("es", "latin"), fr: profile("fr", "latin"),
  de: profile("de", "latin"), it: profile("it", "latin"),
  pt: profile("pt", "latin"), nl: profile("nl", "latin"),
  pl: profile("pl", "latin"), sv: profile("sv", "latin"),
  da: profile("da", "latin"), no: profile("no", "latin"),
  fi: profile("fi", "latin"), ro: profile("ro", "latin"),
  cs: profile("cs", "latin"), hu: profile("hu", "latin"),
  tr: profile("tr", "latin"), id: profile("id", "latin"),
  vi: profile("vi", "latin"), ms: profile("ms", "latin"),
  tl: profile("tl", "latin"), ca: profile("ca", "latin"),
  eu: profile("eu", "latin"), gl: profile("gl", "latin"),
  la: profile("la", "latin"),
  zh: profile("zh", "cjk", { stripsCjkTerminalPunctuation: true }),
  ja: profile("ja", "cjk"),
  ko: profile("ko", "cjk"),
  ru: profile("ru", "other", { script: "cyrillic", enableDashDialogueSplit: true }),
  uk: profile("uk", "other", { script: "cyrillic" }),
  bg: profile("bg", "other", { script: "cyrillic" }),
  ar: profile("ar", "other", { script: "arabic" }),
  fa: profile("fa", "other", { script: "arabic" }),
  ur: profile("ur", "other", { script: "arabic" }),
  hi: profile("hi", "other", { script: "devanagari" }),
  ne: profile("ne", "other", { script: "devanagari" }),
  mr: profile("mr", "other", { script: "devanagari" }),
  th: profile("th", "other", { script: "thai" }),
  he: profile("he", "other", { script: "hebrew" }),
  el: profile("el", "other", { script: "greek" }),
};

const FALLBACK_PROFILE: LanguageProfile = profile("en", "latin");

export function languageProfile(code: string | undefined | null): LanguageProfile {
  const key = (code || "en").split("-")[0].toLowerCase();
  return SOURCE_PROFILES[key] || FALLBACK_PROFILE;
}

export function isChineseTarget(code: string | undefined | null): boolean {
  return (code || "").split("-")[0].toLowerCase() === "zh";
}
