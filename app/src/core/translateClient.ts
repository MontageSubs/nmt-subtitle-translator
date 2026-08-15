import { Unit, Chapter, Cue, ProgressEvent } from "./types";
import { postTranslateHtml } from "./workerClient";
import { MAX_ATTEMPTS, RETRY_DELAY_MS, DEFAULT_CONCURRENCY } from "../config";

const GROUP_MARKER_PATTERN = /\u27e6g([^\u27e6\u27e7]+)\u27e7/g;
const groupMarker = (id: number | string) => `\u27e6g${id}\u27e7`;
const CUE_MARKER_TEMPLATE = (id: number) => `\u27e6c${String(id).padStart(4, "0")}\u27e7`;
const CUE_MARKER_PATTERN = /\u27e6c(\d+)\u27e7/g;
const UNIT_MARKER_TEMPLATE = (id: number) => `\u27e6u${id}\u27e7`;
const UNIT_MARKER_PATTERN = /\u27e6u([^\u27e6\u27e7]+)\u27e7/g;
const TAG_PATTERN = /<[^>]+>/g;
const ITALIC_PATTERN = /<i>.*?<\/i>/gs;
const CONTENT_CHAR_PATTERN = /[\p{L}\p{N}_]/u;

const EMBED_RATIO_THRESHOLD = 0.3;
const TERM_PLACEHOLDER_TEMPLATE = (idx: number) => `\u27e6T${String(idx).padStart(2, "0")}\u27e7`;
const VARIANT_PRIORITY = ["embedded", "placeholder", "plain"] as const;

const WINDOW_CONTEXT_RADIUS = 20;
const WINDOW_KEEP_RADIUS = 2;
const ISOLATED_CUE_RADIUS = 5;
const LENGTH_RATIO_MIN = 0.15;
const LENGTH_RATIO_MAX = 6.0;

type WordScript = "latin" | "cyrillic" | "arabic" | "devanagari" | "hebrew" | "greek";
const WORD_BASED_SCRIPTS = new Set<WordScript>(["latin", "cyrillic", "arabic", "devanagari", "hebrew", "greek"]);
const SCRIPT_CHAR_RANGES: Record<string, string> = {
  latin: "A-Za-z", cyrillic: "\u0400-\u04ff", arabic: "\u0600-\u06ff", devanagari: "\u0900-\u097f",
  hebrew: "\u0590-\u05ff", greek: "\u0370-\u03ff", cjk: "\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af", thai: "\u0e00-\u0e7f",
};
const SCRIPT_LEAK_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  Object.entries(SCRIPT_CHAR_RANGES).map(([name, chars]) => [
    name,
    new RegExp(WORD_BASED_SCRIPTS.has(name as WordScript) ? `[${chars}]{2,}` : `[${chars}]`, "g"),
  ])
);
const LANGUAGE_SCRIPTS: Record<string, string> = {
  en: "latin", es: "latin", fr: "latin", de: "latin", it: "latin", pt: "latin", nl: "latin", pl: "latin",
  sv: "latin", da: "latin", no: "latin", fi: "latin", ro: "latin", cs: "latin", hu: "latin", tr: "latin",
  id: "latin", vi: "latin", ms: "latin", tl: "latin", ca: "latin", eu: "latin", gl: "latin", la: "latin",
  zh: "cjk", ja: "cjk", ko: "cjk", ru: "cyrillic", uk: "cyrillic", bg: "cyrillic",
  ar: "arabic", fa: "arabic", ur: "arabic", hi: "devanagari", ne: "devanagari", mr: "devanagari",
  th: "thai", he: "hebrew", el: "greek",
};

function log(message: string) {
  console.log(`[translate] ${message}`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeHtml(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function hasContent(text: string | null | undefined): boolean {
  return Boolean(text) && CONTENT_CHAR_PATTERN.test(text as string);
}

function withinBudget(text: string, limit: number): boolean {
  if (text.length <= limit) return true;
  log(`payload of ${text.length} chars exceeds budget (${limit}), refusing to truncate, skipping`);
  return false;
}

interface Item {
  id: string;
  text: string;
}

function splitOversizedChapter(items: Item[], batchChars: number) {
  const pieces: Item[][] = [];
  const oversized: Item[] = [];
  let piece: Item[] = [];
  let pieceChars = 0;
  for (const item of items) {
    const itemChars = item.text.length;
    if (itemChars > batchChars) {
      oversized.push(item);
      continue;
    }
    if (piece.length && pieceChars + itemChars > batchChars) {
      pieces.push(piece);
      piece = [];
      pieceChars = 0;
    }
    piece.push(item);
    pieceChars += itemChars;
  }
  if (piece.length) pieces.push(piece);
  return { pieces, oversized };
}

function buildBatches(items: Item[], chapterGroups: string[][], batchChars: number) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const batches: Item[][][] = [];
  const oversized: Item[] = [];
  let current: Item[][] = [];
  let currentChars = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    currentChars = 0;
  };
  for (const group of chapterGroups) {
    const groupItems = group.map((id) => byId.get(id)).filter((x): x is Item => Boolean(x));
    if (!groupItems.length) continue;
    const groupChars = groupItems.reduce((s, i) => s + i.text.length, 0);
    if (groupChars > batchChars) {
      flush();
      const { pieces, oversized: groupOversized } = splitOversizedChapter(groupItems, batchChars);
      for (const piece of pieces) batches.push([piece]);
      oversized.push(...groupOversized);
    } else if (currentChars + groupChars > batchChars) {
      flush();
      current = [groupItems];
      currentChars = groupChars;
    } else {
      current.push(groupItems);
      currentChars += groupChars;
    }
  }
  flush();
  return { batches, oversized };
}

function buildChapterHtml(group: Item[], indices: Map<string, number>): string {
  const spans = group
    .map((item) => {
      const idx = indices.get(item.id)!;
      return `<span id=${idx}>${groupMarker(idx)}${escapeHtml(item.text)}</span>`;
    })
    .join("");
  return `<div>${spans}</div>`;
}

function parseByMarkers(html: string): Map<number, string> {
  const flat = unescapeHtml(html.replace(ITALIC_PATTERN, "").replace(TAG_PATTERN, ""));
  const parts = flat.split(GROUP_MARKER_PATTERN);
  const result = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) {
    if (/^\d+$/.test(parts[i])) result.set(Number(parts[i]), (parts[i + 1] || "").trim());
  }
  return result;
}

async function callWorker(batch: Item[][], sourceLang: string, targetLang: string): Promise<Map<string, string>> {
  const items = batch.flat();
  const indices = new Map(items.map((item, i) => [item.id, i + 1]));
  const idByIndex = new Map(Array.from(indices, ([id, i]) => [i, id]));
  const html = batch.map((group) => buildChapterHtml(group, indices)).join("");
  const translatedHtml = await postTranslateHtml(html, sourceLang, targetLang);
  const parsed = parseByMarkers(translatedHtml);
  const sourceById = new Map(items.map((item) => [item.id, item.text]));
  const result = new Map<string, string>();
  for (const [idx, text] of parsed) {
    const itemId = idByIndex.get(idx);
    if (itemId === undefined) continue;
    if (hasContent(text) || !hasContent(sourceById.get(itemId))) result.set(itemId, text);
  }
  return result;
}

function cueRef(itemId: string): string {
  return itemId.split(":", 1)[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateBatch(batch: Item[][], sourceLang: string, targetLang: string): Promise<{ result: Map<string, string>; missing: string[] }> {
  const items = batch.flat();
  const expectedIds = new Set(items.map((i) => i.id));
  let result = new Map<string, string>();
  let missing = new Set(expectedIds);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await callWorker(batch, sourceLang, targetLang);
    } catch (e) {
      log(`attempt ${attempt} failed: ${e}`);
      result = new Map();
    }
    missing = new Set([...expectedIds].filter((id) => !result.has(id)));
    if (!missing.size) return { result, missing: [] };

    const missingCues = [...new Set([...missing].map(cueRef))].sort();
    log(`attempt ${attempt}: missing ${missing.size} of ${items.length} units, cues: ${missingCues.join(", ")}`);
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  if (items.length > 1) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const missingCues = [...new Set([...missing].map(cueRef))].sort();
    log(`isolating ${missing.size} unit(s) still missing, cues: ${missingCues.join(", ")}`);
    for (const uid of [...missing].sort()) {
      const { result: soloResult } = await translateBatch([[byId.get(uid)!]], sourceLang, targetLang);
      if (soloResult.has(uid)) result.set(uid, soloResult.get(uid)!);
    }
    missing = new Set([...expectedIds].filter((id) => !result.has(id)));
  }
  return { result, missing: [...missing].sort() };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>, onDone?: (result: R, index: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      const result = await worker(items[index]);
      results[index] = result;
      onDone?.(result, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

async function translate(
  items: Item[],
  chapterGroups: string[][],
  sourceLang: string,
  targetLang: string,
  batchChars: number,
  concurrency: number,
  onProgress?: (event: ProgressEvent) => void
): Promise<{ translations: Map<string, string>; skipped: string[] }> {
  const translations = new Map<string, string>();
  const skipped: string[] = [];
  const { batches, oversized } = buildBatches(items, chapterGroups, batchChars);
  for (const item of oversized) {
    log(`unit ${item.id}: ${item.text.length} chars exceeds batch_chars (${batchChars}), cue-level content cannot be split further, skipping without truncation`);
    skipped.push(item.id);
  }

  let completed = 0;
  await mapWithConcurrency(batches, concurrency, (batch) => translateBatch(batch, sourceLang, targetLang), ({ result, missing }) => {
    for (const [id, text] of result) translations.set(id, text);
    skipped.push(...missing);
    completed += 1;
    onProgress?.({ stage: "translate", completed, total: batches.length });
  });
  return { translations, skipped };
}

function scriptOf(lang: string | undefined | null): string | undefined {
  return LANGUAGE_SCRIPTS[(lang || "").split("-")[0].toLowerCase()];
}

function isUntranslated(text: string, sourceLang: string, targetLang: string): boolean {
  if (!text) return false;
  const sourceScript = scriptOf(sourceLang);
  const targetScript = scriptOf(targetLang);
  if (!sourceScript || !targetScript || sourceScript === targetScript) return false;
  const pattern = SCRIPT_LEAK_PATTERNS[sourceScript];
  return (text.match(pattern) || []).length > 1;
}

interface TermMatch {
  start: number;
  end: number;
  source: string;
  target: string;
}

function applyTermMatches(text: string, termMatches: TermMatch[], variant: "embedded" | "placeholder"): [string, Record<string, string>] {
  const pieces: string[] = [];
  const mapping: Record<string, string> = {};
  let cursor = 0;
  termMatches.forEach((match, idx) => {
    pieces.push(text.slice(cursor, match.start));
    if (variant === "embedded") {
      pieces.push(match.target);
    } else {
      const placeholder = TERM_PLACEHOLDER_TEMPLATE(idx);
      mapping[placeholder] = match.target;
      pieces.push(placeholder);
    }
    cursor = match.end;
  });
  pieces.push(text.slice(cursor));
  return [pieces.join(""), mapping];
}

function buildVariants(unit: Unit): Record<string, [string, Record<string, string>]> {
  const { text, term_matches: matches = [], embed_ratio: ratio = 0 } = unit;
  if (!matches.length) return { plain: [text, {}] };
  if (ratio > EMBED_RATIO_THRESHOLD) return { placeholder: applyTermMatches(text, matches, "placeholder") };
  return {
    embedded: applyTermMatches(text, matches, "embedded"),
    placeholder: applyTermMatches(text, matches, "placeholder"),
  };
}

function flattenUnits(units: Unit[], chapterOfUnit: Map<number, number>) {
  const items: Item[] = [];
  const chapterItems = new Map<number | undefined, string[]>();
  for (const unit of units) {
    const chapterId = chapterOfUnit.get(unit.id);
    for (const [variant, [text]] of Object.entries(buildVariants(unit))) {
      const itemId = `${unit.id}:${variant}`;
      items.push({ id: itemId, text });
      if (!chapterItems.has(chapterId)) chapterItems.set(chapterId, []);
      chapterItems.get(chapterId)!.push(itemId);
    }
  }
  return { items, chapterGroups: [...chapterItems.values()] };
}

function restorePlaceholders(text: string, mapping: Record<string, string>): string {
  let result = text;
  for (const [placeholder, target] of Object.entries(mapping)) {
    result = result.split(placeholder).join(target);
  }
  return result;
}

function resolveTranslation(unit: Unit, translations: Map<string, string>, sourceLang: string, targetLang: string): [string | null, string | null, Record<string, string> | null] {
  const variants = buildVariants(unit);
  for (const variant of VARIANT_PRIORITY) {
    if (!(variant in variants)) continue;
    const [sourceText, mapping] = variants[variant];
    const result = translations.get(`${unit.id}:${variant}`);
    if (result === undefined) continue;
    if (variant === "embedded" && "placeholder" in variants && isUntranslated(result, sourceLang, targetLang)) continue;
    return [restorePlaceholders(result, mapping), sourceText, mapping];
  }
  return [null, null, null];
}

async function retrySingle(text: string, sourceLang: string, targetLang: string): Promise<string | undefined> {
  if (!text || !text.trim()) return undefined;
  const { result } = await translateBatch([[{ id: "retry", text }]], sourceLang, targetLang);
  return result.get("retry");
}

function contentLength(text: string | null | undefined): number {
  return (text || "").match(/[\p{L}\p{N}_]/gu)?.length || 0;
}

function isLengthPlausible(sourceText: string, translatedText: string): boolean {
  const sourceLen = contentLength(sourceText);
  if (sourceLen === 0) return true;
  const ratio = contentLength(translatedText) / sourceLen;
  return ratio >= LENGTH_RATIO_MIN && ratio <= LENGTH_RATIO_MAX;
}

async function retryWindowed(units: Unit[], suspectId: number, sourceLang: string, targetLang: string, batchChars: number): Promise<Map<number, string>> {
  const index = new Map(units.map((u, i) => [u.id, i]));
  const i = index.get(suspectId)!;
  const window = units.slice(Math.max(0, i - WINDOW_CONTEXT_RADIUS), i + WINDOW_CONTEXT_RADIUS + 1);
  if (window.length < 2) return new Map();
  const pieces = [window[0].text];
  for (const unit of window.slice(1)) {
    pieces.push(` ${UNIT_MARKER_TEMPLATE(unit.id)} `, unit.text);
  }
  const windowedText = pieces.join("");
  if (!withinBudget(windowedText, batchChars)) return new Map();

  const { result } = await translateBatch([[{ id: "window", text: windowedText }]], sourceLang, targetLang);
  const response = result.get("window");
  if (response === undefined) return new Map();

  const expectedIds = window.slice(1).map((u) => u.id);
  const foundIds = [...response.matchAll(UNIT_MARKER_PATTERN)].map((m) => Number(m[1]));
  if (JSON.stringify(foundIds) !== JSON.stringify(expectedIds)) return new Map();

  const chunks = response.split(UNIT_MARKER_PATTERN).filter((_, idx) => idx % 2 === 0);
  const keepIds = new Set(units.slice(Math.max(0, i - WINDOW_KEEP_RADIUS), i + WINDOW_KEEP_RADIUS + 1).map((u) => u.id));
  const recovered = new Map<number, string>();
  window.forEach((unit, idx) => {
    if (keepIds.has(unit.id)) recovered.set(unit.id, chunks[idx].trim());
  });
  return recovered;
}

function expectedCueIds(unit: Unit): number[] {
  return unit.spans.filter((s) => s.boundary === "marker").map((s) => s.id);
}

function splitCueChunks(text: string | null | undefined): Map<number, string> {
  const parts = (text || "").split(CUE_MARKER_PATTERN);
  const chunks = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) chunks.set(Number(parts[i]), (parts[i + 1] || "").trim());
  return chunks;
}

function missingCueIds(unit: Unit, text: string | null | undefined): number[] {
  const expected = expectedCueIds(unit);
  if (!expected.length) return [];
  const present = splitCueChunks(text);
  return expected.filter((cid) => !present.has(cid));
}

function patchMissingCues(text: string, expectedIds: number[], recovered: Map<number, string>): string {
  if (!recovered.size) return text;
  const chunks = splitCueChunks(text);
  for (const [cid, chunk] of recovered) chunks.set(cid, chunk);
  return expectedIds
    .filter((cid) => chunks.has(cid))
    .map((cid) => `${CUE_MARKER_TEMPLATE(cid)} ${chunks.get(cid)}`)
    .join(" ");
}

function buildIsolatedDivs(cueIds: number[], cueTextById: Map<number, string>): string {
  return cueIds
    .filter((cid) => cueTextById.has(cid))
    .map((cid) => `<div>${CUE_MARKER_TEMPLATE(cid)} ${escapeHtml(cueTextById.get(cid)!)}</div>`)
    .join("");
}

async function retryIsolatedCues(
  missingIds: number[], cueOrder: number[], cueTextById: Map<number, string>,
  sourceLang: string, targetLang: string, batchChars: number
): Promise<Map<number, string>> {
  const position = new Map(cueOrder.map((cid, i) => [cid, i]));
  const positions = missingIds.map((cid) => position.get(cid)).filter((p): p is number => p !== undefined).sort((a, b) => a - b);
  if (!positions.length) return new Map();
  const lo = Math.max(0, positions[0] - ISOLATED_CUE_RADIUS);
  const hi = Math.min(cueOrder.length - 1, positions[positions.length - 1] + ISOLATED_CUE_RADIUS);
  const html = buildIsolatedDivs(cueOrder.slice(lo, hi + 1), cueTextById);
  if (!withinBudget(html, batchChars)) return new Map();

  let translatedHtml: string;
  try {
    translatedHtml = await postTranslateHtml(html, sourceLang, targetLang);
  } catch (e) {
    log(`isolated cue retry failed: ${e}`);
    return new Map();
  }
  const flat = unescapeHtml(translatedHtml.replace(TAG_PATTERN, ""));
  const recovered = splitCueChunks(flat);
  const missingSet = new Set(missingIds);
  const out = new Map<number, string>();
  for (const [cid, text] of recovered) {
    if (missingSet.has(cid) && hasContent(text) && isLengthPlausible(cueTextById.get(cid) || "", text)) out.set(cid, text);
  }
  return out;
}

export interface TranslateUnitsOptions {
  batchChars: number;
  concurrency?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export async function translateUnits(
  units: Unit[], chapters: Chapter[], cues: Cue[],
  sourceLang: string, targetLang: string, options: TranslateUnitsOptions
): Promise<{ translations: Record<string, string>; skipped: (string | number)[] }> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const resolved = new Map(units.filter((u) => u.resolved !== null).map((u) => [u.id, u.resolved as string]));
  const pending = units.filter((u) => u.resolved === null);
  const chapterOfUnit = new Map<number, number>();
  for (const chapter of chapters) for (const uid of chapter.unit_ids) chapterOfUnit.set(uid, chapter.id);

  const { items, chapterGroups } = flattenUnits(pending, chapterOfUnit);
  const { translations: translationsRaw } = items.length
    ? await translate(items, chapterGroups, sourceLang, targetLang, options.batchChars, concurrency, options.onProgress)
    : { translations: new Map<string, string>() };

  const results = new Map<number, string | null>(resolved);
  for (const unit of pending) {
    let [finalText, sourceText, mapping] = resolveTranslation(unit, translationsRaw, sourceLang, targetLang);
    if (finalText !== null && isUntranslated(finalText, sourceLang, targetLang)) {
      const retried = await retrySingle(sourceText || "", sourceLang, targetLang);
      if (retried) {
        const candidate = restorePlaceholders(retried, mapping || {});
        if (candidate !== finalText) {
          log(`unit ${unit.id}: retry changed result`);
          finalText = candidate;
        }
      }
    }
    results.set(unit.id, finalText);
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  const lengthSuspects = new Set(
    [...results.entries()]
      .filter(([uid, text]) => text !== null && hasContent(unitById.get(uid)!.text) && (!hasContent(text) || !isLengthPlausible(unitById.get(uid)!.text, text)))
      .map(([uid]) => uid)
  );
  const cueSuspects = new Set(
    [...results.entries()].filter(([uid, text]) => text !== null && missingCueIds(unitById.get(uid)!, text).length > 0).map(([uid]) => uid)
  );
  const cueOrder = cues.map((c) => c.id);
  const cueTextById = new Map(cues.map((c) => [c.id, c.text]));

  const suspects = [...new Set([...lengthSuspects, ...cueSuspects])].sort((a, b) => a - b);
  for (const uid of suspects) {
    const recovered = await retryWindowed(units, uid, sourceLang, targetLang, options.batchChars);
    if (recovered.size) {
      log(`windowed retry around unit ${uid}: recovered ${[...recovered.keys()].sort((a, b) => a - b)}`);
      for (const [rid, text] of recovered) results.set(rid, text);
    } else {
      log(`windowed retry around unit ${uid}: markers did not align, left as-is`);
    }

    const remaining = missingCueIds(unitById.get(uid)!, results.get(uid));
    if (!remaining.length) continue;
    const recoveredCues = await retryIsolatedCues(remaining, cueOrder, cueTextById, sourceLang, targetLang, options.batchChars);
    if (recoveredCues.size) {
      results.set(uid, patchMissingCues(results.get(uid) as string, expectedCueIds(unitById.get(uid)!), recoveredCues));
      log(`isolated cue retry for unit ${uid}: recovered cues ${[...recoveredCues.keys()].sort((a, b) => a - b)}`);
    } else {
      log(`isolated cue retry for unit ${uid}: cues ${remaining} still missing, left as-is`);
    }
  }

  const skipped: (string | number)[] = [...results.entries()].filter(([, text]) => text === null).map(([uid]) => uid);
  const translations: Record<string, string> = {};
  for (const [uid, text] of results) if (text !== null) translations[String(uid)] = text;
  return { translations, skipped };
}
