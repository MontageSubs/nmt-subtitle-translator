import { WORKER_URL, TURNSTILE_SITE_KEY, FALLBACK_MAX_CHARS, REQUEST_TIMEOUT_MS, IDLE_STANDBY_MARGIN_MS, assertConfigured } from "../config";
import { computeProbeBitmap } from "./envProbe";

const PENDING_SUCCESS_KEY = "nmt_pending_success";
const STANDBY_TTL_MS = 60_000;
const ACTIVE_TTL_MS = 20_000;

export interface Stats {
  total: number;
  last24h: number;
}

interface Session {
  token: string;
  challengeKey: string;
  nonce: number;
  maxChars: number;
  issuedAt: number;
  ttl: number;
}

export class WorkerRequestError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly triggerTurnstile = false, public readonly fatal = false) {
    super(message);
  }
}

let session: Session | null = null;
let clearance: string | null = null;

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string };
  }
}

function readPendingSuccess(): number {
  return Number(localStorage.getItem(PENDING_SUCCESS_KEY) || 0) || 0;
}

export function bufferSuccess(): void {
  localStorage.setItem(PENDING_SUCCESS_KEY, String(readPendingSuccess() + 1));
}

function clearPendingSuccess(): void {
  localStorage.removeItem(PENDING_SUCCESS_KEY);
}

async function request(path: string, body: unknown): Promise<any> {
  assertConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fatal = payload?.error === "output_blocked";
      const retryable = !fatal && (response.status === 429 || response.status >= 500);
      const message = fatal ? "响应内容安全校验未通过，任务已中止" : payload?.error || `worker responded ${response.status}`;
      throw new WorkerRequestError(message, retryable, Boolean(payload?.trigger_turnstile), fatal);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function isSessionFresh(candidate: Session | null): boolean {
  if (!candidate) return false;
  return Date.now() - candidate.issuedAt < candidate.ttl - IDLE_STANDBY_MARGIN_MS;
}

function adoptSession(payload: { token: string; challengeKey: string; nonce: number; maxChars?: number }, ttl: number): void {
  session = {
    token: payload.token,
    challengeKey: payload.challengeKey,
    nonce: payload.nonce,
    maxChars: payload.maxChars || session?.maxChars || FALLBACK_MAX_CHARS,
    issuedAt: Date.now(),
    ttl,
  };
}

export async function handshake(): Promise<Stats & { maxChars: number }> {
  const pending = readPendingSuccess();
  const payload = await request("/handshake", pending ? { pendingSuccess: pending } : {});
  if (pending) clearPendingSuccess();
  adoptSession(payload, STANDBY_TTL_MS);
  return { total: payload.stats?.total ?? 0, last24h: payload.stats?.last24h ?? 0, maxChars: payload.maxChars || FALLBACK_MAX_CHARS };
}

async function ensureSession(): Promise<Session> {
  if (!isSessionFresh(session)) await handshake();
  return session!;
}

export function getMaxChars(): number {
  return session?.maxChars || FALLBACK_MAX_CHARS;
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function signChallenge(challengeKey: string, message: string): Promise<number> {
  const key = await crypto.subtle.importKey(
    "raw", decodeBase64Url(challengeKey) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new DataView(signature).getUint32(0);
}

function computeAnswer(challengeKey: string, nonce: number, text: string, probeBitmap: number): Promise<number> {
  return signChallenge(challengeKey, `${nonce}:${probeBitmap}:${text}`);
}

let turnstileLoad: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileLoad) {
    turnstileLoad = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("turnstile script failed to load"));
      document.head.appendChild(script);
    });
  }
  return turnstileLoad;
}

async function resolveTurnstile(): Promise<void> {
  if (!TURNSTILE_SITE_KEY) throw new WorkerRequestError("触发限流，但未配置 Turnstile site key", false);
  await loadTurnstileScript();
  const backdrop = document.getElementById("captcha-backdrop");
  const widget = document.getElementById("captcha-widget");
  if (!backdrop || !widget) throw new WorkerRequestError("触发限流，但页面缺少验证码弹层容器", false);

  backdrop.hidden = false;
  widget.innerHTML = "";
  try {
    const turnstileToken = await new Promise<string>((resolve, reject) => {
      window.turnstile!.render(widget, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => resolve(token),
        "error-callback": () => reject(new Error("turnstile challenge failed")),
      });
    });
    const payload = await request("/turnstile", { turnstileToken });
    clearance = payload.clearance;
  } finally {
    backdrop.hidden = true;
  }
}

async function attemptTranslate(text: string, source: string, target: string): Promise<{ translatedHtml: string; maxChars: number; detectedLang: string | null }> {
  const active = await ensureSession();
  session = null;
  const probeBitmap = computeProbeBitmap();
  const answer = await computeAnswer(active.challengeKey, active.nonce, text, probeBitmap);
  const pending = readPendingSuccess();
  const payload = await request("/translate", {
    token: active.token,
    answer,
    probeBitmap,
    text,
    source,
    target,
    ...(pending ? { pendingSuccess: pending } : {}),
    ...(clearance ? { clearance } : {}),
  });
  if (pending) clearPendingSuccess();
  adoptSession(payload, ACTIVE_TTL_MS);
  return { translatedHtml: payload.translatedHtml, maxChars: payload.maxChars || active.maxChars, detectedLang: payload.detectedLang ?? null };
}

async function attemptTranslateJob(job: TranslateJobPayload): Promise<TranslateJobResponse> {
  const active = await ensureSession();
  session = null;
  const probeBitmap = computeProbeBitmap();
  const answer = await computeAnswer(active.challengeKey, active.nonce, job.content, probeBitmap);
  const pending = readPendingSuccess();
  const payload = await request("/translate-job", {
    token: active.token,
    answer,
    probeBitmap,
    ...job,
    ...(pending ? { pendingSuccess: pending } : {}),
    ...(clearance ? { clearance } : {}),
  });
  if (pending) clearPendingSuccess();
  adoptSession(payload, ACTIVE_TTL_MS);
  return payload as TranslateJobResponse;
}

const RATE_LIMIT_BASE_BACKOFF_MS = 5_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

let rateLimitedUntil = 0;
let rateLimitBackoffMs = RATE_LIMIT_BASE_BACKOFF_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimitCooldown(): Promise<void> {
  const remaining = rateLimitedUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

function noteRateLimited(): void {
  rateLimitedUntil = Date.now() + rateLimitBackoffMs;
  rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, RATE_LIMIT_MAX_BACKOFF_MS);
}

function noteRateLimitCleared(): void {
  rateLimitBackoffMs = RATE_LIMIT_BASE_BACKOFF_MS;
}

async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  await waitForRateLimitCooldown();
  try {
    const result = await attempt();
    noteRateLimitCleared();
    return result;
  } catch (e) {
    if (!(e instanceof WorkerRequestError)) throw e;
    if (e.triggerTurnstile) {
      await resolveTurnstile();
      await waitForRateLimitCooldown();
      return attempt();
    }
    if (e.retryable) {
      noteRateLimited();
      await waitForRateLimitCooldown();
      return attempt();
    }
    throw e;
  }
}

export function postTranslateHtml(text: string, source: string, target: string): Promise<{ translatedHtml: string; maxChars: number }> {
  return withRetry(() => attemptTranslate(text, source, target));
}

export interface TranslateJobPayload {
  content: string;
  glossary: Record<string, string>;
  source: string;
  target: string;
  stripSdhEnabled?: boolean;
  sceneChangeSeconds?: number;
}

export interface TranslateJobResponse {
  success: boolean;
  resolved_source_lang: string;
  sdh_removed: { dropped: number; stripped: number };
  cues: { id: number; start: string; end: string; text: string; translation: string | null }[];
  approx_splits: { unit_id: number; cues: number[]; method: string }[];
  missing_count: number;
  missing_cues: number[];
}

export function postTranslateJob(job: TranslateJobPayload): Promise<TranslateJobResponse> {
  return withRetry(() => attemptTranslateJob(job));
}

const DETECT_SAMPLE_TARGET = "en";
const DETECT_SAMPLE_MAX_CHARS = 600;

/**
 * 借助 translateHtml 端点自带的 source="auto" 探测能力识别字幕语言：
 * 未经实测确认上游响应是否稳定携带检测结果——如果始终拿到 null，说明这条路径在生产环境不可用，
 * 需要改回纯手动选择语言，而不是假装探测成功。
 */
export async function detectLanguage(sampleText: string): Promise<string | null> {
  if (!sampleText.trim()) return null;
  const sample = sampleText.slice(0, DETECT_SAMPLE_MAX_CHARS);
  try {
    const { detectedLang } = await withRetry(() => attemptTranslate(sample, "auto", DETECT_SAMPLE_TARGET));
    return detectedLang;
  } catch {
    return null;
  }
}
