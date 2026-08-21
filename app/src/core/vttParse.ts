import { Cue } from "./types";

const TIME_LINE_PATTERN = /((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*(.*)$/;
const WHITESPACE_PATTERN = /[^\S\n]+/g;
const SKIPPED_BLOCK_PATTERN = /^(NOTE|STYLE|REGION)(\s|$)/;

function timeToMs(value: string): number {
  const parts = value.split(":");
  const [ss, ms] = parts.pop()!.split(".");
  const mm = parts.pop() ?? "0";
  const hh = parts.pop() ?? "0";
  return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms);
}

function normalizeText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(WHITESPACE_PATTERN, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function parseVtt(content: string): Cue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
  const blocks = normalized.trim().split(/\n\s*\n/);
  const cues: Cue[] = [];

  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    if (!lines.length || SKIPPED_BLOCK_PATTERN.test(lines[0].trim())) continue;
    const timeLineIdx = [0, 1].find((idx) => idx < lines.length && TIME_LINE_PATTERN.test(lines[idx].trim()));
    if (timeLineIdx === undefined) continue;
    const timeMatch = TIME_LINE_PATTERN.exec(lines[timeLineIdx].trim())!;
    const text = normalizeText(lines.slice(timeLineIdx + 1).join("\n"));
    if (!text) continue;
    cues.push({
      id: cues.length + 1,
      start_ms: timeToMs(timeMatch[1]),
      end_ms: timeToMs(timeMatch[2]),
      text,
      cueSettings: timeMatch[3] || undefined,
    });
  }
  return cues;
}
