import { Unit, Chapter, Cue, ProgressEvent } from "./types";
import { postTranslateHtml, postTranslateBatch, getMaxChars, WorkerRequestError } from "./workerClient";
import { languageProfile } from "./languageProfiles";
import { uiLog } from "./uiLog";

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
const VARIANT_PRIORITY = ["bracketed", "embedded", "placeholder", "plain"] as const;

// 拉丁语系目标语言下，术语表的目标译词有时与源文拼写恰好雷同/相近，直接嵌入原文（embedded 变体）
// 可能被 Google 误判为拼写错误而"纠正"掉。这里改为把原词原样括起来发送，回收时校验括号数量是否
// 与发送前一致——一致则说明位置未被打乱，安全地替换成术语表译词；数量对不上则放弃，交给同批并发
// 请求的 placeholder 变体兜底。方括号选用生僻的 QUILL 变体，正常字幕文本内容不会自然出现。
const BRACKET_OPEN = "\u2045";
const BRACKET_CLOSE = "\u2046";
const BRACKETED_TERM_PATTERN = /\u2045([^\u2045\u2046]*)\u2046/g;
const STYLE_TAG_PATTERN = /<\/?(i|b|u)>/gi;

const BATCH_PACK_RATIO = 0.9;
const INDEX_DIGITS_ESTIMATE = 4;
const SPAN_MARKUP_OVERHEAD = "<span id=></span>".length + INDEX_DIGITS_ESTIMATE + groupMarker("0".repeat(INDEX_DIGITS_ESTIMATE)).length;
const CHAPTER_WRAPPER_OVERHEAD = "<div></div>".length;

function escapedLength(text: string): number {
  let extra = 0;
  for (const ch of text) {
    if (ch === "&") extra += 4;
    else if (ch === "<" || ch === ">") extra += 3;
  }
  return text.length + extra;
}

function itemMarkupChars(item: Item): number {
  return SPAN_MARKUP_OVERHEAD + escapedLength(item.text);
}

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
  uiLog(`[translate] ${message}`);
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
  let pieceChars = CHAPTER_WRAPPER_OVERHEAD;
  for (const item of items) {
    const itemChars = itemMarkupChars(item);
    if (itemChars > batchChars) {
      oversized.push(item);
      continue;
    }
    if (piece.length && pieceChars + itemChars > batchChars) {
      pieces.push(piece);
      piece = [];
      pieceChars = CHAPTER_WRAPPER_OVERHEAD;
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
    const groupChars = CHAPTER_WRAPPER_OVERHEAD + groupItems.reduce((s, i) => s + itemMarkupChars(i), 0);
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

async function sendHtml(html: string, sourceLang: string, targetLang: string): Promise<string> {
  const { translatedHtml } = await postTranslateHtml(html, sourceLang, targetLang);
  return translatedHtml;
}

function rethrowIfFatal(e: unknown): void {
  if (e instanceof WorkerRequestError && e.fatal) throw e;
}

function prepareBatch(batch: Item[][]): { items: Item[]; idByIndex: Map<number, string>; html: string } {
  const items = batch.flat();
  const indices = new Map(items.map((item, i) => [item.id, i + 1]));
  const idByIndex = new Map(Array.from(indices, ([id, i]) => [i, id]));
  const html = batch.map((group) => buildChapterHtml(group, indices)).join("");
  return { items, idByIndex, html };
}

function extractTranslations(translatedHtml: string, items: Item[], idByIndex: Map<number, string>): Map<string, string> {
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

async function sendBatch(batch: Item[][], sourceLang: string, targetLang: string): Promise<Map<string, string>> {
  const { items, idByIndex, html } = prepareBatch(batch);
  try {
    const translatedHtml = await sendHtml(html, sourceLang, targetLang);
    return extractTranslations(translatedHtml, items, idByIndex);
  } catch (e) {
    rethrowIfFatal(e);
    log(`batch request failed: ${e}`);
    return new Map();
  }
}

async function sendBatchesSequentially(
  batches: Item[][][], sourceLang: string, targetLang: string,
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, string>> {
  const translations = new Map<string, string>();
  let completed = 0;
  for (const batch of batches) {
    for (const [id, text] of await sendBatch(batch, sourceLang, targetLang)) translations.set(id, text);
    completed += 1;
    onProgress?.(completed, batches.length);
  }
  return translations;
}

async function sendBatchesMerged(
  batches: Item[][][], sourceLang: string, targetLang: string,
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, string>> {
  if (!batches.length) return new Map();
  const prepared = batches.map(prepareBatch);
  onProgress?.(0, batches.length);

  let results: (string | null)[];
  try {
    results = await postTranslateBatch(prepared.map((p) => p.html), sourceLang, targetLang);
  } catch (e) {
    rethrowIfFatal(e);
    log(`merged batch request failed: ${e}`);
    results = prepared.map(() => null);
  }

  const translations = new Map<string, string>();
  prepared.forEach(({ items, idByIndex }, i) => {
    const translatedHtml = results[i];
    if (translatedHtml === null || translatedHtml === undefined) {
      log(`batch ${i + 1}/${prepared.length}: no result from worker, will retry missing units individually`);
      return;
    }
    for (const [id, text] of extractTranslations(translatedHtml, items, idByIndex)) translations.set(id, text);
  });
  onProgress?.(batches.length, batches.length);
  return translations;
}

function cueRef(itemId: string): string {
  return itemId.split(":", 1)[0];
}

async function translate(
  items: Item[], chapterGroups: string[][], sourceLang: string, targetLang: string,
  maxChars: number, onProgress?: (event: ProgressEvent) => void
): Promise<{ translations: Map<string, string>; skipped: string[] }> {
  const { batches, oversized } = buildBatches(items, chapterGroups, maxChars);
  for (const item of oversized) log(`unit ${item.id}: ${item.text.length} chars exceeds maxChars (${maxChars}), cue-level content cannot be split further, skipping without truncation`);

  const translations = await sendBatchesMerged(batches, sourceLang, targetLang, (completed, total) =>
    onProgress?.({ stage: "translate", completed, total })
  );

  const oversizedIds = new Set(oversized.map((i) => i.id));
  let missing = items.map((i) => i.id).filter((id) => !translations.has(id) && !oversizedIds.has(id));

  if (missing.length) {
    const missingCues = [...new Set(missing.map(cueRef))].sort();
    log(`retry round: resending ${missing.length} missing unit(s) individually, cues: ${missingCues.join(", ")}`);
    const missingSet = new Set(missing);
    const filteredGroups = chapterGroups.map((g) => g.filter((id) => missingSet.has(id))).filter((g) => g.length);
    const filteredItems = items.filter((i) => missingSet.has(i.id));
    const { batches: retryBatches } = buildBatches(filteredItems, filteredGroups, maxChars);
    for (const [id, text] of await sendBatchesSequentially(retryBatches, sourceLang, targetLang)) translations.set(id, text);
    missing = missing.filter((id) => !translations.has(id));
  }

  return { translations, skipped: [...oversized.map((i) => i.id), ...missing] };
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

interface VariantPayload {
  sourceText: string;
  mapping: Record<string, string>;
  bracketOrder?: string[];
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

function applyTermMatchesBracketed(text: string, termMatches: TermMatch[]): [string, string[]] {
  const pieces: string[] = [];
  const order: string[] = [];
  let cursor = 0;
  termMatches.forEach((match) => {
    pieces.push(text.slice(cursor, match.start), BRACKET_OPEN, match.source, BRACKET_CLOSE);
    order.push(match.target);
    cursor = match.end;
  });
  pieces.push(text.slice(cursor));
  return [pieces.join(""), order];
}

function resolveBracketed(result: string, order: string[]): string | null {
  const matches = [...result.matchAll(BRACKETED_TERM_PATTERN)];
  if (matches.length !== order.length) return null;
  let cursor = 0;
  const pieces: string[] = [];
  matches.forEach((m, idx) => {
    pieces.push(result.slice(cursor, m.index), order[idx]);
    cursor = m.index! + m[0].length;
  });
  pieces.push(result.slice(cursor));
  return pieces.join("");
}

function styleTagsIntact(sourceText: string, translatedText: string): boolean {
  if (!STYLE_TAG_PATTERN.test(sourceText)) return true;
  const openCount = (translatedText.match(/<(i|b|u)>/gi) || []).length;
  const closeCount = (translatedText.match(/<\/(i|b|u)>/gi) || []).length;
  return openCount > 0 && openCount === closeCount;
}

function stripStyleTags(text: string): string {
  return text.replace(STYLE_TAG_PATTERN, "");
}

function buildVariants(unit: Unit, targetLang: string): Record<string, VariantPayload> {
  const { text, term_matches: matches = [], embed_ratio: ratio = 0 } = unit;
  if (!matches.length) return { plain: { sourceText: text, mapping: {} } };
  const [placeholderText, placeholderMapping] = applyTermMatches(text, matches, "placeholder");
  if (ratio > EMBED_RATIO_THRESHOLD) return { placeholder: { sourceText: placeholderText, mapping: placeholderMapping } };
  if (languageProfile(targetLang).usesLatinPunctuation) {
    const [bracketedText, order] = applyTermMatchesBracketed(text, matches);
    return {
      bracketed: { sourceText: bracketedText, mapping: {}, bracketOrder: order },
      placeholder: { sourceText: placeholderText, mapping: placeholderMapping },
    };
  }
  const [embeddedText, embeddedMapping] = applyTermMatches(text, matches, "embedded");
  return {
    embedded: { sourceText: embeddedText, mapping: embeddedMapping },
    placeholder: { sourceText: placeholderText, mapping: placeholderMapping },
  };
}

function flattenUnits(units: Unit[], chapterOfUnit: Map<number, number>, targetLang: string) {
  const items: Item[] = [];
  const chapterItems = new Map<number | undefined, string[]>();
  for (const unit of units) {
    const chapterId = chapterOfUnit.get(unit.id);
    for (const [variant, payload] of Object.entries(buildVariants(unit, targetLang))) {
      const itemId = `${unit.id}:${variant}`;
      items.push({ id: itemId, text: payload.sourceText });
      if (!chapterItems.has(chapterId)) chapterItems.set(chapterId, []);
      chapterItems.get(chapterId)!.push(itemId);
    }
  }
  return { items, chapterGroups: [...chapterItems.values()] };
}

function restorePlaceholders(text: string, mapping: Record<string, string>): string {
  let result = text;
  for (const [placeholder, target] of Object.entries(mapping)) result = result.split(placeholder).join(target);
  return result;
}

function resolveTranslation(unit: Unit, translations: Map<string, string>, sourceLang: string, targetLang: string): [string | null, string | null, Record<string, string> | null] {
  const variants = buildVariants(unit, targetLang);
  for (const variant of VARIANT_PRIORITY) {
    const payload = variants[variant];
    if (!payload) continue;
    const result = translations.get(`${unit.id}:${variant}`);
    if (result === undefined) continue;

    let resolved: string | null;
    if (variant === "bracketed") {
      resolved = payload.bracketOrder ? resolveBracketed(result, payload.bracketOrder) : null;
      if (resolved === null) continue;
    } else if (variant === "embedded" && "placeholder" in variants && isUntranslated(result, sourceLang, targetLang)) {
      continue;
    } else {
      resolved = restorePlaceholders(result, payload.mapping);
    }

    if (!styleTagsIntact(unit.text, resolved)) {
      log(`unit ${unit.id}: inline style tags lost or unbalanced after translation, stripping to avoid broken markup`);
      resolved = stripStyleTags(resolved);
    }
    return [resolved, payload.sourceText, payload.mapping];
  }
  return [null, null, null];
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

interface UntranslatedCandidate {
  unit: Unit;
  sourceText: string;
  mapping: Record<string, string>;
}

async function retryUntranslated(
  candidates: UntranslatedCandidate[], sourceLang: string, targetLang: string, maxChars: number
): Promise<Map<number, string>> {
  if (!candidates.length) return new Map();
  const items = candidates.map((c) => ({ id: String(c.unit.id), text: c.sourceText }));
  const { batches } = buildBatches(items, items.map((i) => [i.id]), maxChars);
  const raw = await sendBatchesSequentially(batches, sourceLang, targetLang);
  const recovered = new Map<number, string>();
  for (const c of candidates) {
    const text = raw.get(String(c.unit.id));
    if (text !== undefined) recovered.set(c.unit.id, restorePlaceholders(text, c.mapping));
  }
  return recovered;
}

interface WindowPlan {
  suspectId: number;
  windowedText: string;
  expectedIds: number[];
  keepIds: Set<number>;
  window: Unit[];
}

function buildWindowPlan(units: Unit[], suspectId: number, batchChars: number): WindowPlan | null {
  const index = new Map(units.map((u, i) => [u.id, i]));
  const i = index.get(suspectId)!;
  const window = units.slice(Math.max(0, i - WINDOW_CONTEXT_RADIUS), i + WINDOW_CONTEXT_RADIUS + 1);
  if (window.length < 2) return null;
  const pieces = [window[0].text];
  for (const unit of window.slice(1)) pieces.push(` ${UNIT_MARKER_TEMPLATE(unit.id)} `, unit.text);
  const windowedText = pieces.join("");
  if (!withinBudget(windowedText, batchChars)) return null;
  const expectedIds = window.slice(1).map((u) => u.id);
  const keepIds = new Set(units.slice(Math.max(0, i - WINDOW_KEEP_RADIUS), i + WINDOW_KEEP_RADIUS + 1).map((u) => u.id));
  return { suspectId, windowedText, expectedIds, keepIds, window };
}

function parseWindowResult(response: string | undefined, plan: WindowPlan): Map<number, string> {
  if (response === undefined) return new Map();
  const foundIds = [...response.matchAll(UNIT_MARKER_PATTERN)].map((m) => Number(m[1]));
  if (JSON.stringify(foundIds) !== JSON.stringify(plan.expectedIds)) return new Map();
  const chunks = response.split(UNIT_MARKER_PATTERN).filter((_, idx) => idx % 2 === 0);
  const recovered = new Map<number, string>();
  plan.window.forEach((unit, idx) => {
    if (plan.keepIds.has(unit.id)) recovered.set(unit.id, (chunks[idx] || "").trim());
  });
  return recovered;
}

async function retryWindowedMerged(
  units: Unit[], suspectIds: number[], sourceLang: string, targetLang: string, maxChars: number
): Promise<Map<number, string>> {
  const plans = suspectIds.map((id) => buildWindowPlan(units, id, maxChars)).filter((p): p is WindowPlan => p !== null);
  if (!plans.length) return new Map();
  const items = plans.map((p) => ({ id: String(p.suspectId), text: p.windowedText }));
  const { batches } = buildBatches(items, items.map((i) => [i.id]), maxChars);
  const raw = await sendBatchesSequentially(batches, sourceLang, targetLang);
  const recovered = new Map<number, string>();
  for (const plan of plans) {
    for (const [uid, text] of parseWindowResult(raw.get(String(plan.suspectId)), plan)) recovered.set(uid, text);
  }
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

async function retryIsolatedCuesMerged(
  missingByUnit: Map<number, number[]>, cueOrder: number[], cueTextById: Map<number, string>,
  sourceLang: string, targetLang: string, maxChars: number
): Promise<Map<number, string>> {
  const position = new Map(cueOrder.map((cid, i) => [cid, i]));
  const positions = new Set<number>();
  for (const cueIds of missingByUnit.values()) {
    for (const cid of cueIds) {
      const p = position.get(cid);
      if (p === undefined) continue;
      for (let k = Math.max(0, p - ISOLATED_CUE_RADIUS); k <= Math.min(cueOrder.length - 1, p + ISOLATED_CUE_RADIUS); k++) positions.add(k);
    }
  }
  if (!positions.size) return new Map();

  const html = buildIsolatedDivs([...positions].sort((a, b) => a - b).map((p) => cueOrder[p]), cueTextById);
  if (!withinBudget(html, maxChars)) return new Map();

  let translatedHtml: string;
  try {
    translatedHtml = await sendHtml(html, sourceLang, targetLang);
  } catch (e) {
    rethrowIfFatal(e);
    log(`isolated cue retry failed: ${e}`);
    return new Map();
  }

  const flat = unescapeHtml(translatedHtml.replace(TAG_PATTERN, ""));
  const recovered = splitCueChunks(flat);
  const allMissing = new Set([...missingByUnit.values()].flat());
  const out = new Map<number, string>();
  for (const [cid, text] of recovered) {
    if (allMissing.has(cid) && hasContent(text) && isLengthPlausible(cueTextById.get(cid) || "", text)) out.set(cid, text);
  }
  return out;
}

export interface TranslateUnitsOptions {
  maxChars?: number;
  onProgress?: (event: ProgressEvent) => void;
}

export async function translateUnits(
  units: Unit[], chapters: Chapter[], cues: Cue[],
  sourceLang: string, targetLang: string, options: TranslateUnitsOptions = {}
): Promise<{ translations: Record<string, string>; skipped: (string | number)[] }> {
  const maxChars = Math.floor((options.maxChars ?? getMaxChars()) * BATCH_PACK_RATIO);
  const resolved = new Map(units.filter((u) => u.resolved !== null).map((u) => [u.id, u.resolved as string]));
  const pending = units.filter((u) => u.resolved === null);
  const chapterOfUnit = new Map<number, number>();
  for (const chapter of chapters) for (const uid of chapter.unit_ids) chapterOfUnit.set(uid, chapter.id);

  const { items, chapterGroups } = flattenUnits(pending, chapterOfUnit, targetLang);
  const { translations: translationsRaw } = items.length
    ? await translate(items, chapterGroups, sourceLang, targetLang, maxChars, options.onProgress)
    : { translations: new Map<string, string>() };

  const results = new Map<number, string | null>(resolved);
  const untranslatedCandidates: UntranslatedCandidate[] = [];
  for (const unit of pending) {
    const [finalText, sourceText, mapping] = resolveTranslation(unit, translationsRaw, sourceLang, targetLang);
    results.set(unit.id, finalText);
    if (finalText !== null && isUntranslated(finalText, sourceLang, targetLang)) {
      untranslatedCandidates.push({ unit, sourceText: sourceText || "", mapping: mapping || {} });
    }
  }

  if (untranslatedCandidates.length) {
    log(`untranslated-script retry: resending ${untranslatedCandidates.length} unit(s) in one merged request`);
    const recovered = await retryUntranslated(untranslatedCandidates, sourceLang, targetLang, maxChars);
    for (const { unit } of untranslatedCandidates) {
      const candidate = recovered.get(unit.id);
      if (candidate !== undefined && candidate !== results.get(unit.id)) {
        log(`unit ${unit.id}: retry changed result`);
        results.set(unit.id, candidate);
      }
    }
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
  const suspects = [...new Set([...lengthSuspects, ...cueSuspects])].sort((a, b) => a - b);

  if (suspects.length) {
    log(`windowed retry: resending context around ${suspects.length} suspect unit(s) in one merged request`);
    const recovered = await retryWindowedMerged(units, suspects, sourceLang, targetLang, maxChars);
    for (const [uid, text] of recovered) results.set(uid, text);

    const cueOrder = cues.map((c) => c.id);
    const cueTextById = new Map(cues.map((c) => [c.id, c.text]));
    const missingByUnit = new Map<number, number[]>();
    for (const uid of suspects) {
      const remaining = missingCueIds(unitById.get(uid)!, results.get(uid));
      if (remaining.length) missingByUnit.set(uid, remaining);
    }

    if (missingByUnit.size) {
      log(`isolated cue retry: resending cues for ${missingByUnit.size} unit(s) in one merged request`);
      const recoveredCues = await retryIsolatedCuesMerged(missingByUnit, cueOrder, cueTextById, sourceLang, targetLang, maxChars);
      for (const [uid, cueIds] of missingByUnit) {
        const unitRecovered = new Map([...recoveredCues].filter(([cid]) => cueIds.includes(cid)));
        if (unitRecovered.size) {
          results.set(uid, patchMissingCues(results.get(uid) as string, expectedCueIds(unitById.get(uid)!), unitRecovered));
          log(`isolated cue retry: unit ${uid} recovered cues ${[...unitRecovered.keys()].sort((a, b) => a - b)}`);
        }
      }
    }
  }

  const skipped: (string | number)[] = [...results.entries()].filter(([, text]) => text === null).map(([uid]) => uid);
  const translations: Record<string, string> = {};
  for (const [uid, text] of results) if (text !== null) translations[String(uid)] = text;
  return { translations, skipped };
}
