export interface LanguageProfile {
  code: string;
  label: string;
  script: "latin" | "cjk" | "cyrillic" | "arabic" | "devanagari" | "hebrew" | "greek" | "thai" | "other";
  usesLatinPunctuation: boolean;
  enableSpeakerTagStrip: boolean;
  enableStutterResolution: boolean;
  enableDashDialogueSplit: boolean;
}

const SOURCE_PROFILES: Record<string, LanguageProfile> = {
  en: { code: "en", label: "English", script: "latin", usesLatinPunctuation: true, enableSpeakerTagStrip: true, enableStutterResolution: true, enableDashDialogueSplit: true },
  es: base("es", "Español"), fr: base("fr", "Français"), de: base("de", "Deutsch"),
  it: base("it", "Italiano"), pt: base("pt", "Português"), nl: base("nl", "Nederlands"),
  pl: base("pl", "Polski"), sv: base("sv", "Svenska"), da: base("da", "Dansk"),
  no: base("no", "Norsk"), fi: base("fi", "Suomi"), ro: base("ro", "Română"),
  cs: base("cs", "Čeština"), hu: base("hu", "Magyar"), tr: base("tr", "Türkçe"),
  id: base("id", "Indonesia"), vi: base("vi", "Tiếng Việt"), ms: base("ms", "Melayu"),
  tl: base("tl", "Tagalog"), ca: base("ca", "Català"), eu: base("eu", "Euskara"),
  gl: base("gl", "Galego"), la: base("la", "Latina"),
  zh: { code: "zh", label: "中文", script: "cjk", usesLatinPunctuation: false, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: false },
  ja: { code: "ja", label: "日本語", script: "cjk", usesLatinPunctuation: false, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: false },
  ko: { code: "ko", label: "한국어", script: "cjk", usesLatinPunctuation: false, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: false },
  ru: cyr("ru", "Русский"), uk: cyr("uk", "Українська"), bg: cyr("bg", "Български"),
  ar: other("ar", "العربية", "arabic"), fa: other("fa", "فارسی", "arabic"), ur: other("ur", "اردو", "arabic"),
  hi: other("hi", "हिन्दी", "devanagari"), ne: other("ne", "नेपाली", "devanagari"), mr: other("mr", "मराठी", "devanagari"),
  th: other("th", "ไทย", "thai"), he: other("he", "עברית", "hebrew"), el: other("el", "Ελληνικά", "greek"),
};

function base(code: string, label: string): LanguageProfile {
  return { code, label, script: "latin", usesLatinPunctuation: true, enableSpeakerTagStrip: true, enableStutterResolution: true, enableDashDialogueSplit: true };
}
function cyr(code: string, label: string): LanguageProfile {
  return { code, label, script: "cyrillic", usesLatinPunctuation: false, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: true };
}
function other(code: string, label: string, script: LanguageProfile["script"]): LanguageProfile {
  return { code, label, script, usesLatinPunctuation: false, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: true };
}

const FALLBACK_PROFILE: LanguageProfile = base("en", "Unknown");

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

export const TARGET_LANGUAGES: LanguageProfile[] = [
  SOURCE_PROFILES.zh, SOURCE_PROFILES.en, { code: "es", label: "Español", script: "latin", usesLatinPunctuation: true, enableSpeakerTagStrip: false, enableStutterResolution: false, enableDashDialogueSplit: false },
  SOURCE_PROFILES.ja, SOURCE_PROFILES.ko, SOURCE_PROFILES.fr, SOURCE_PROFILES.de,
  SOURCE_PROFILES.ru, SOURCE_PROFILES.ar, SOURCE_PROFILES.pt,
];

export const SOURCE_LANGUAGES: LanguageProfile[] = Object.values(SOURCE_PROFILES);
