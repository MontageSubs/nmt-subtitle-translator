import { Cue, OutputMode, BilingualStacking } from "./types";
import { TranslateJobResponse } from "./workerClient";

export function msToVttTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hh = Math.floor(clamped / 3_600_000);
  const mm = Math.floor((clamped % 3_600_000) / 60_000);
  const ss = Math.floor((clamped % 60_000) / 1_000);
  const msRemainder = clamped % 1_000;
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(msRemainder, 3)}`;
}

export function renderVtt(
  cues: TranslateJobResponse["cues"], originalById: Map<number, Cue>, mode: OutputMode, stacking: BilingualStacking = "translation_top"
): string {
  const blocks = cues.map((cue) => {
    const settings = originalById.get(cue.id)?.cueSettings;
    const translation = cue.translation || "";
    const bilingualLines = stacking === "original_top" ? [cue.text, translation] : [translation, cue.text];
    const lines = mode === "bilingual" ? (translation ? bilingualLines : [cue.text]) : [translation || cue.text];
    const timing = `${msToVttTime(cue.start_ms)} --> ${msToVttTime(cue.end_ms)}${settings ? ` ${settings}` : ""}`;
    return `${timing}\n${lines.join("\n")}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}
