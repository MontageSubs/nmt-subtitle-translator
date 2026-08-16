import { WORKER_URL, TURNSTILE_SITE_KEY, FALLBACK_MAX_CHARS, REQUEST_TIMEOUT_MS, IDLE_STANDBY_MARGIN_MS, assertConfigured } from "../config";
import { computeEnvScore } from "./envProbe";

const PENDING_SUCCESS_KEY = "nmt_pending_success";
const STANDBY_TTL_MS = 60_000;
const ACTIVE_TTL_MS = 10_000;

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
  constructor(message: string, public readonly retryable: boolean, public readonly triggerTurnstile = false) {
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
      const retryable = response.status === 429 || response.status >= 500;
      throw new WorkerRequestError(payload?.error || `worker responded ${response.status}`, retryable, Boolean(payload?.trigger_turnstile));
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
  return new DataView(signature).getUint32(0) % 1_000_000;
}

function computeAnswer(challengeKey: string, nonce: number, text: string): Promise<number> {
  return signChallenge(challengeKey, `${nonce}:${text}`);
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
  const container = document.getElementById("turnstile-container");
  if (!container) throw new WorkerRequestError("触发限流，但页面缺少 #turnstile-container", false);

  container.hidden = false;
  const turnstileToken = await new Promise<string>((resolve, reject) => {
    window.turnstile!.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => resolve(token),
      "error-callback": () => reject(new Error("turnstile challenge failed")),
    });
  });
  container.hidden = true;

  const payload = await request("/turnstile", { turnstileToken });
  clearance = payload.clearance;
}

async function attemptTranslate(text: string, source: string, target: string): Promise<{ translatedHtml: string; maxChars: number }> {
  const active = await ensureSession();
  const answer = await computeAnswer(active.challengeKey, active.nonce, text);
  const envScore = computeEnvScore(active.nonce);
  const pending = readPendingSuccess();
  const payload = await request("/translate", {
    token: active.token,
    answer,
    envScore,
    text,
    source,
    target,
    ...(pending ? { pendingSuccess: pending } : {}),
    ...(clearance ? { clearance } : {}),
  });
  if (pending) clearPendingSuccess();
  adoptSession(payload, ACTIVE_TTL_MS);
  return { translatedHtml: payload.translatedHtml, maxChars: payload.maxChars || active.maxChars };
}

export async function postTranslateHtml(text: string, source: string, target: string): Promise<{ translatedHtml: string; maxChars: number }> {
  try {
    return await attemptTranslate(text, source, target);
  } catch (e) {
    if (e instanceof WorkerRequestError && e.triggerTurnstile) {
      await resolveTurnstile();
      return attemptTranslate(text, source, target);
    }
    throw e;
  }
}
