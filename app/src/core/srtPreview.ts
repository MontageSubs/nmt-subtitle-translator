import { Cue } from "./types";

const TIME_LINE_PATTERN = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;
const TAG_PATTERN = /<[^>]+>|\{[^}]*\}/g;
const WHITESPACE_PATTERN = /\s+/g;

function timeToMs(value: string): number {
  const [hh, mm, rest] = value.replace(".", ",").split(":");
  const [ss, ms] = rest.split(",");
  return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms);
}

function foldLine(raw: string): string {
  return raw.split("\n").map((line) => line.replace(TAG_PATTERN, "").replace(WHITESPACE_PATTERN, " ").trim()).filter(Boolean).join(" ");
}

export function parseSrtPreview(content: string): Cue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cues: Cue[] = [];
  for (const block of normalized.trim().split(/\n\s*\n/)) {
    const lines = block.replace(/^\n+|\n+$/g, "").split("\n");
    if (!lines.length) continue;
    const timeLineIdx = [0, 1].find((idx) => idx < lines.length && TIME_LINE_PATTERN.test(lines[idx].trim()));
    if (timeLineIdx === undefined) continue;
    const timeMatch = TIME_LINE_PATTERN.exec(lines[timeLineIdx].trim())!;
    const text = foldLine(lines.slice(timeLineIdx + 1).join("\n"));
    if (text) cues.push({ id: cues.length + 1, start: timeMatch[1], end: timeMatch[2], text });
  }
  return cues;
}

export const DEFAULT_SCENE_CHANGE_SECONDS = 30;

export function previewChapterCount(cues: Cue[], sceneChangeMs: number): number {
  if (!cues.length) return 0;
  let count = 1;
  let threadEnd = timeToMs(cues[0].end);
  for (let i = 1; i < cues.length; i++) {
    const startMs = timeToMs(cues[i].start);
    if (startMs - threadEnd > sceneChangeMs) count += 1;
    threadEnd = Math.max(threadEnd, timeToMs(cues[i].end));
  }
  return count;
}
