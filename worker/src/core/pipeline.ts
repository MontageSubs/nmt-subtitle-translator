import { Env } from "../env";
import { extract, Glossary } from "./srtExtract";
import { translateUnits, resolveContext } from "./retryEscalation";
import { merge, MergeResult } from "./bilingualMerge";
import { ProtocolCue } from "../protocol";

export interface TranslateJobRequest {
  cues: ProtocolCue[];
  glossary: Glossary;
  source: string;
  target: string;
  sceneChangeSeconds?: number;
  caseSensitiveTerms?: boolean;
  contextText?: string;
  contextNeedsTranslation?: boolean;
}

export interface TranslateJobResult extends MergeResult {
  success: boolean;
  resolved_source_lang: string;
}

export async function runTranslateJob(
  env: Env, job: TranslateJobRequest, maxChars: number, startedAt: number, onLog?: (message: string) => void
): Promise<TranslateJobResult> {
  const extracted = extract(job.cues, job.glossary, {
    sourceLang: job.source, targetLang: job.target, sceneChangeSeconds: job.sceneChangeSeconds, caseSensitiveTerms: job.caseSensitiveTerms,
  });
  if (!extracted.success) {
    return { success: false, resolved_source_lang: job.source, cues: [], approx_splits: [], missing_count: 0, missing_cues: [] };
  }

  const { sourceLang, contextText } = await resolveContext(
    env, job.contextText, job.contextNeedsTranslation, job.source, job.target, extracted.cues, maxChars, startedAt, onLog
  );

  const { translations, resolvedSourceLang } = await translateUnits(
    env, extracted.units, extracted.chapters, extracted.cues, sourceLang, job.target,
    { maxChars, startedAt, onLog, contextText }
  );
  const merged = await merge(extracted.cues, extracted.units, translations, sourceLang, job.target);

  return { success: true, resolved_source_lang: resolvedSourceLang, ...merged };
}
