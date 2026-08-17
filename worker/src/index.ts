import { issueSession, verifyToken } from "./token";
import { computeAnswer, deriveChallengeKey } from "./challenge";
import { probeBitmapValid } from "./envProbe";
import { verifyTurnstileToken, issueClearance, verifyClearance } from "./turnstile";
import { recordSuccess, readStats, TursoConfig } from "./turso";
import { checkGate, consumeFreeQuota, recordViolation, recordCaptchaSolved, pruneReputation } from "./reputation";
import { resolveSecretRing, nextRingText } from "./secret";
import { consumeNonceOnce } from "./replay";

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ALLOWED_ORIGIN: string;
  WORKER_SECRET: string;
  WORKER_SALT?: string;
  MAX_BATCH_CHARS?: string;
  RATE_LIMIT_UNIT_CHARS?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  TURSO_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  RATE_LIMITER: RateLimit;
  DB: D1Database;
}

const UPSTREAM_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const FALLBACK_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STANDBY_TTL_MS = 60_000;
const ACTIVE_TTL_MS = 20_000;
const DEFAULT_MAX_BATCH_CHARS = 60_000;
const DEFAULT_RATE_LIMIT_UNIT_CHARS = 500;
const MAX_PENDING_SUCCESS_PER_REQUEST = 500;
const BATCH_CHARS_TOLERANCE = 1.1;
const PREFLIGHT_MAX_AGE = "7200";
const DEGRADED_RATE_LIMIT_MULTIPLIER = 4;
const SCRIPT_NAME = "nmt-relay";
const ROTATION_CRON = "0 4 * * 7";

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}

async function parseBody<T>(request: Request): Promise<T | null> {
  const raw = await request.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function tursoConfig(env: Env): TursoConfig | null {
  return env.TURSO_URL && env.TURSO_AUTH_TOKEN ? { url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN } : null;
}

function maxBatchChars(env: Env): number {
  return Number(env.MAX_BATCH_CHARS) || DEFAULT_MAX_BATCH_CHARS;
}

function rateLimitUnitChars(env: Env): number {
  return Number(env.RATE_LIMIT_UNIT_CHARS) || DEFAULT_RATE_LIMIT_UNIT_CHARS;
}

function logGate(event: string, ip: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ip, ts: Date.now(), ...extra }));
}

function reportError(label: string, e: unknown): void {
  console.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
}

async function loadStats(env: Env) {
  const config = tursoConfig(env);
  if (!config) return { total: 0, last24h: 0 };
  try {
    return await readStats(config);
  } catch (e) {
    reportError("readStats failed", e);
    return { total: 0, last24h: 0 };
  }
}

function reportPending(ctx: ExecutionContext, env: Env, pendingSuccess: unknown): void {
  const count = Math.floor(Number(pendingSuccess));
  if (!Number.isFinite(count) || count <= 0 || count > MAX_PENDING_SUCCESS_PER_REQUEST) return;
  const config = tursoConfig(env);
  if (!config) return;
  ctx.waitUntil(recordSuccess(config, count).catch((e) => reportError("recordSuccess failed", e)));
}

function flagViolation(ctx: ExecutionContext, env: Env, ip: string, now: number): void {
  ctx.waitUntil(recordViolation(env.DB, ip, now).catch((e) => logGate("d1_write_failed", ip, { op: "recordViolation", message: String(e) })));
}

async function gateForRequest(env: Env, ip: string, now: number) {
  try {
    return await checkGate(env.DB, ip, now);
  } catch (e) {
    logGate("d1_read_failed_failopen", ip, { message: e instanceof Error ? e.message : String(e) });
    return { blocked: false, quarantined: false, requireClearance: false, degraded: true };
  }
}

async function consumeRateLimit(env: Env, ip: string, chars: number, degraded: boolean): Promise<boolean> {
  const unit = rateLimitUnitChars(env) / (degraded ? DEGRADED_RATE_LIMIT_MULTIPLIER : 1);
  const hits = Math.max(1, Math.ceil(chars / unit));
  for (let i = 0; i < hits; i++) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return false;
  }
  return true;
}

async function handleHandshake(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = (await parseBody<{ pendingSuccess?: number }>(request)) || {};
  reportPending(ctx, env, body.pendingSuccess);
  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const [{ token, challengeKey, nonce }, stats] = await Promise.all([issueSession(ring, STANDBY_TTL_MS), loadStats(env)]);
  return json({ token, challengeKey, nonce, maxChars: maxBatchChars(env), stats }, 200, origin);
}

interface TranslateRequestBody {
  token?: string;
  answer?: number;
  text?: string;
  source?: string;
  target?: string;
  pendingSuccess?: number;
  clearance?: string;
  probeBitmap?: number;
}

async function handleTranslate(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = await parseBody<TranslateRequestBody>(request);
  if (!body) return json({ error: "malformed JSON" }, 400, origin);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();

  const gate = await gateForRequest(env, ip, now);
  if (gate.blocked) {
    logGate("ip_blocked", ip);
    return json({ error: "too many failed verifications, try again later" }, 403, origin);
  }

  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const verified = await verifyToken(ring, body.token || "");
  if (!verified) {
    flagViolation(ctx, env, ip, now);
    return json({ error: "invalid or expired token" }, 401, origin);
  }
  const { payload, secret: matchedSecret } = verified;

  if (!(await consumeNonceOnce(payload.nonce, payload.ttl))) {
    flagViolation(ctx, env, ip, now);
    logGate("token_replay", ip);
    return json({ error: "token already used" }, 401, origin);
  }

  const { text, source, target } = body;
  if (!text || !source || !target) return json({ error: "invalid translate request" }, 400, origin);

  const limit = maxBatchChars(env);
  if (text.length > limit * BATCH_CHARS_TOLERANCE) return json({ error: "payload exceeds maxChars", maxChars: limit }, 413, origin);

  const probeBitmap = Number(body.probeBitmap);
  const keyBytes = await deriveChallengeKey(matchedSecret, payload.nonce);
  const expected = await computeAnswer(keyBytes, payload.nonce, text, probeBitmap);
  if (expected !== body.answer) {
    flagViolation(ctx, env, ip, now);
    logGate("turnstile_triggered", ip, { reason: "challenge_mismatch" });
    return json({ error: "challenge mismatch" }, 403, origin);
  }

  const cleared = await verifyClearance(ring, body.clearance);
  if (!cleared) {
    if (gate.requireClearance) {
      logGate("turnstile_triggered", ip, { reason: "quarantine" });
      return json({ error: "quarantine active", trigger_turnstile: true }, 429, origin);
    }
    if (!probeBitmapValid(payload.nonce, probeBitmap)) {
      logGate("turnstile_triggered", ip, { reason: "env_check_failed" });
      return json({ error: "environment check failed", trigger_turnstile: true }, 429, origin);
    }
    try {
      const success = await consumeRateLimit(env, ip, text.length, gate.degraded);
      if (!success) {
        logGate("turnstile_triggered", ip, { reason: "rate_limited" });
        return json({ error: "rate_limited", trigger_turnstile: true }, 429, origin);
      }
    } catch (e) {
      reportError("rate limiter unavailable, failing open", e);
    }
    if (gate.quarantined) {
      ctx.waitUntil(consumeFreeQuota(env.DB, ip, now).catch((e) => logGate("d1_write_failed", ip, { op: "consumeFreeQuota", message: String(e) })));
    }
  }

  const headers = new Headers({ "Content-Type": "application/json+protobuf", "User-Agent": FALLBACK_USER_AGENT });
  const upstreamUrl = new URL(UPSTREAM_ENDPOINT);
  if (env.GOOGLE_TRANSLATE_API_KEY) {
    upstreamUrl.searchParams.set("key", env.GOOGLE_TRANSLATE_API_KEY);
    headers.set("X-Goog-Api-Key", env.GOOGLE_TRANSLATE_API_KEY);
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    method: "POST", headers, body: JSON.stringify([[[text], source, target], "te"]),
  });
  if (!upstreamResponse.ok) return json({ error: `upstream ${upstreamResponse.status}` }, 502, origin);

  const upstreamPayload = (await upstreamResponse.json().catch(() => null)) as unknown;
  const translatedHtml = Array.isArray(upstreamPayload) ? (upstreamPayload as any)?.[0]?.[0] : undefined;
  if (typeof translatedHtml !== "string") return json({ error: "unexpected upstream response shape" }, 502, origin);

  reportPending(ctx, env, body.pendingSuccess);
  const { token, challengeKey, nonce } = await issueSession(ring, ACTIVE_TTL_MS);
  return json({ translatedHtml, token, challengeKey, nonce, maxChars: limit }, 200, origin);
}

async function handleTurnstile(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) return json({ error: "turnstile not configured" }, 501, origin);
  const body = await parseBody<{ turnstileToken?: string }>(request);
  if (!body?.turnstileToken) return json({ error: "missing turnstileToken" }, 400, origin);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ok = await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!ok) {
    flagViolation(ctx, env, ip, Date.now());
    logGate("turnstile_verify_failed", ip);
    return json({ error: "turnstile verification failed" }, 403, origin);
  }
  ctx.waitUntil(
    recordCaptchaSolved(env.DB, ip, Date.now())
      .then((escalated) => { if (escalated) logGate("ip_escalated", ip, { reason: "daily_captcha_cap" }); })
      .catch((e) => logGate("d1_write_failed", ip, { op: "recordCaptchaSolved", message: String(e) }))
  );
  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const clearance = await issueClearance(ring);
  return json({ clearance }, 200, origin);
}

async function rotateSecret(env: Env): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    console.error("secret rotation skipped: CF_API_TOKEN/CF_ACCOUNT_ID not configured");
    return;
  }
  const raw = nextRingText(env.WORKER_SECRET);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "WORKER_SECRET", text: raw, type: "secret_text" }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`secret rotation failed: ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    return;
  }
  console.log(JSON.stringify({ event: "secret_rotated", ts: Date.now() }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    try {
      const allowed = origin === env.ALLOWED_ORIGIN;

      if (request.method === "OPTIONS") {
        return allowed ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
      }
      if (!allowed) return new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
      if (request.method !== "POST") return json({ error: "not found" }, 404, origin);
      if (!env.WORKER_SECRET) return json({ error: "worker misconfigured: WORKER_SECRET is not set" }, 500, origin);

      const path = new URL(request.url).pathname;
      if (path === "/handshake") return await handleHandshake(request, env, ctx, origin);
      if (path === "/translate") return await handleTranslate(request, env, ctx, origin);
      if (path === "/turnstile") return await handleTurnstile(request, env, ctx, origin);
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: `internal error: ${e instanceof Error ? e.message : String(e)}` }, 500, origin);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === ROTATION_CRON) {
      ctx.waitUntil(rotateSecret(env));
      return;
    }
    ctx.waitUntil(pruneReputation(env.DB));
  },
};
