import { detectSourceLanguage } from "./detect";

export const CONTEXT_MAX_CHARS = 300;

export function truncateContext(text: string, maxChars = CONTEXT_MAX_CHARS): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  const candidate = trimmed.slice(0, maxChars);
  const cutsMidWord = /\S/.test(candidate[candidate.length - 1]) && /\S/.test(trimmed[maxChars] ?? "");
  if (!cutsMidWord) return { text: candidate.trimEnd(), truncated: true };
  const lastSpace = candidate.lastIndexOf(" ");
  return { text: candidate.slice(0, lastSpace > 0 ? lastSpace : maxChars).trimEnd(), truncated: true };
}

export interface ContextValidation {
  text: string;
  truncated: boolean;
  languageMismatch: boolean;
  detectedCode?: string;
}

export async function validateContext(raw: string, sourceLang: string): Promise<ContextValidation> {
  const { text, truncated } = truncateContext(raw);
  if (!text || sourceLang === "auto") return { text, truncated, languageMismatch: false };
  const detected = await detectSourceLanguage([{ text }]);
  const languageMismatch = Boolean(detected && detected.reliable && detected.code.split("-")[0] !== sourceLang.split("-")[0]);
  return { text, truncated, languageMismatch, detectedCode: detected?.code };
}
