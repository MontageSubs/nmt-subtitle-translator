import { OutputMode } from "./types";
import { TranslateJobResponse } from "./workerClient";

function formatSrtTime(value: string): string {
  return value.replace(".", ",");
}

export function renderSrt(cues: TranslateJobResponse["cues"], mode: OutputMode): string {
  const blocks = cues.map((cue, i) => {
    const translation = cue.translation || "";
    const lines = mode === "bilingual" ? (translation ? [translation, cue.text] : [cue.text]) : [translation || cue.text];
    return `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${lines.join("\n")}`;
  });
  return blocks.join("\n\n") + "\n";
}
