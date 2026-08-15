import { issueSession, verifyToken } from "./token";
import { computeAnswer, deriveOps } from "./challenge";
import { verifyTurnstileToken, issueClearance, verifyClearance } from "./turnstile";
import { recordSuccess, readStats, TursoConfig } from "./turso";

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ALLOWED_ORIGIN: string;
  WORKER_SECRET: string;
  MAX_BATCH_CHARS?: string;
  GOOGLE_TRANSLATE_API_KEY?: string;
  TURSO_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  RATE_LIMITER: RateLimit;
}

const UPSTREAM_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const FALLBACK_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STANDBY_TTL_MS = 60_000;
const ACTIVE_TTL_MS = 10_000;
const DEFAULT_MAX_BATCH_CHARS = 60_000;
const MAX_PENDING_SUCCESS_PER_REQUEST = 500;

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}

function tursoConfig(env: Env): TursoConfig | null {
  return env.TURSO_URL && env.TURSO_AUTH_TOKEN ? { url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN } : null;
}

function maxBatchChars(env: Env): number {
  return Number(env.MAX_BATCH_CHARS) || DEFAULT_MAX_BATCH_CHARS;
}

async function loadStats(env: Env) {
  const config = tursoConfig(env);
  if (!config) return { total: 0, last24h: 0 };
  try {
    return await readStats(config);
  } catch {
    return { total: 0, last24h: 0 };
  }
}

function reportPending(ctx: ExecutionContext, env: Env, pendingSuccess: unknown): void {
  const count = Math.floor(Number(pendingSuccess));
  if (!Number.isFinite(count) || count <= 0 || count > MAX_PENDING_SUCCESS_PER_REQUEST) return;
  const config = tursoConfig(env);
  if (!config) return;
  ctx.waitUntil(recordSuccess(config, count).catch(() => undefined));
}

async function handleHandshake(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { pendingSuccess?: number };
  reportPending(ctx, env, body.pendingSuccess);
  const [{ token, challenge, nonce }, stats] = await Promise.all([issueSession(env.WORKER_SECRET, STANDBY_TTL_MS), loadStats(env)]);
  return json({ token, challenge, nonce, maxChars: maxBatchChars(env), stats }, 200, origin);
}

interface TranslateRequestBody {
  token?: string;
  answer?: number;
  text?: string;
  source?: string;
  target?: string;
  pendingSuccess?: number;
  clearance?: string;
}

async function handleTranslate(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as TranslateRequestBody | null;
  if (!body) return json({ error: "malformed JSON" }, 400, origin);

  const payload = await verifyToken(env.WORKER_SECRET, body.token || "");
  if (!payload) return json({ error: "invalid or expired token" }, 401, origin);

  const { text, source, target } = body;
  if (!text || !source || !target) return json({ error: "invalid translate request" }, 400, origin);

  const limit = maxBatchChars(env);
  if (text.length > limit) return json({ error: "payload exceeds maxChars", maxChars: limit }, 413, origin);

  const expected = computeAnswer(payload.nonce, text, deriveOps(payload.nonce));
  if (expected !== body.answer) return json({ error: "challenge mismatch" }, 403, origin);

  const cleared = await verifyClearance(env.WORKER_SECRET, body.clearance);
  if (!cleared) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "rate_limited", trigger_turnstile: true }, 429, origin);
    } catch (e) {
      console.error(`rate limiter unavailable, failing open: ${e instanceof Error ? e.message : String(e)}`);
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
  const { token, challenge, nonce } = await issueSession(env.WORKER_SECRET, ACTIVE_TTL_MS);
  return json({ translatedHtml, token, challenge, nonce, maxChars: limit }, 200, origin);
}

async function handleTurnstile(request: Request, env: Env, origin: string): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) return json({ error: "turnstile not configured" }, 501, origin);
  const body = (await request.json().catch(() => null)) as { turnstileToken?: string } | null;
  if (!body?.turnstileToken) return json({ error: "missing turnstileToken" }, 400, origin);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ok = await verifyTurnstileToken(env.TURNSTILE_SECRET_KEY, body.turnstileToken, ip);
  if (!ok) return json({ error: "turnstile verification failed" }, 403, origin);
  const clearance = await issueClearance(env.WORKER_SECRET);
  return json({ clearance }, 200, origin);
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
      if (path === "/turnstile") return await handleTurnstile(request, env, origin);
      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: `internal error: ${e instanceof Error ? e.message : String(e)}` }, 500, origin);
    }
  },
};
