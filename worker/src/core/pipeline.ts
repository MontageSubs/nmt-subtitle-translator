import { Env } from "../env";
import { extract, Glossary } from "./srtExtract";
import { translateUnits } from "./retryEscalation";
import { merge, MergeResult } from "./bilingualMerge";
import { ProtocolCue } from "../protocol";

export interface TranslateJobRequest {
  cues: ProtocolCue[];
  glossary: Glossary;
  source: string;
  target: string;
  sceneChangeSeconds?: number;
}

export interface TranslateJobResult extends MergeResult {
  success: boolean;
  resolved_source_lang: string;
}

export async function runTranslateJob(
  env: Env, job: TranslateJobRequest, maxChars: number, startedAt: number
): Promise<TranslateJobResult> {
  const extracted = extract(job.cues, job.glossary, { sourceLang: job.source, sceneChangeSeconds: job.sceneChangeSeconds });
  if (!extracted.success) {
    return { success: false, resolved_source_lang: job.source, cues: [], approx_splits: [], missing_count: 0, missing_cues: [] };
  }

  const { translations, resolvedSourceLang } = await translateUnits(
    env, extracted.units, extracted.chapters, extracted.cues, job.source, job.target, { maxChars, startedAt }
  );
  const merged = await merge(extracted.cues, extracted.units, translations, job.source, job.target);

  return { success: true, resolved_source_lang: resolvedSourceLang, ...merged };
}
