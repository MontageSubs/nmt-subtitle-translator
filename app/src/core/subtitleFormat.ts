import { Cue, OutputMode, BilingualStacking, SubtitleFormat } from "./types";
import { TranslateJobResponse } from "./workerClient";
import { parseSrt } from "./srtParse";
import { renderSrt } from "./srtRender";
import { parseVtt } from "./vttParse";
import { renderVtt } from "./vttRender";

export const ACCEPTED_EXTENSIONS = [".srt", ".vtt"];

export function detectFormat(filename: string): SubtitleFormat {
  return filename.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
}

export function parseSubtitle(format: SubtitleFormat, content: string): Cue[] {
  return format === "vtt" ? parseVtt(content) : parseSrt(content);
}

export function renderSubtitle(
  format: SubtitleFormat, cues: TranslateJobResponse["cues"], originalById: Map<number, Cue>, mode: OutputMode, stacking: BilingualStacking
): string {
  return format === "vtt" ? renderVtt(cues, originalById, mode, stacking) : renderSrt(cues, originalById, mode, stacking);
}

export function withExtension(filename: string, format: SubtitleFormat, targetLang: string): string {
  return filename.replace(/\.(srt|vtt)$/i, "") + `.${targetLang}.${format}`;
}
