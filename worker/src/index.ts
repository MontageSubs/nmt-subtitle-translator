export interface Env {
  ALLOWED_ORIGIN: string;
  WORKER_PRIVATE_KEY: string;
  RATE_LIMIT_KV: KVNamespace;
  RATE_LIMIT_PER_HOUR?: string;
}

const ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const AUTH_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_HOUR = 1000;
const MAX_HTML_CHARS = 8000;

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Auth",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

let privateKeyPromise: Promise<CryptoKey> | null = null;

function importPrivateKey(pkcs8Base64: string): Promise<CryptoKey> {
  if (!privateKeyPromise) {
    privateKeyPromise = crypto.subtle.importKey(
      "pkcs8",
      base64ToBytes(pkcs8Base64),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"]
    );
  }
  return privateKeyPromise;
}

async function verifyAuthHeader(env: Env, authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  try {
    const key = await importPrivateKey(env.WORKER_PRIVATE_KEY);
    const plaintext = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, base64ToBytes(authHeader));
    const { ts } = JSON.parse(new TextDecoder().decode(plaintext)) as { ts?: number };
    const age = Date.now() - Number(ts);
    return Number.isFinite(age) && age >= -5000 && age <= AUTH_WINDOW_MS;
  } catch {
    return false;
  }
}

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT_PER_HOUR) || DEFAULT_RATE_LIMIT_PER_HOUR;
  const bucket = `rl:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const current = Number((await env.RATE_LIMIT_KV.get(bucket)) || "0");
  if (current >= limit) return false;
  await env.RATE_LIMIT_KV.put(bucket, String(current + 1), { expirationTtl: 3600 });
  return true;
}

async function handleTranslate(request: Request, env: Env, origin: string): Promise<Response> {
  if (!(await verifyAuthHeader(env, request.headers.get("X-Auth")))) {
    return json({ error: "missing or invalid auth" }, 401, origin);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await checkRateLimit(env, ip))) {
    return json({ error: "rate limit exceeded" }, 429, origin);
  }

  const body = await request.text();
  let payload: { html?: string; source?: string; target?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ error: "malformed JSON" }, 400, origin);
  }
  const { html, source, target } = payload;
  if (!html || !source || !target || html.length > MAX_HTML_CHARS) {
    return json({ error: "invalid translate request" }, 400, origin);
  }

  const upstreamBody = JSON.stringify([[[html], source, target], "te"]);
  const upstreamResponse = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json+protobuf", "User-Agent": USER_AGENT },
    body: upstreamBody,
  });
  if (!upstreamResponse.ok) {
    return json({ error: `upstream ${upstreamResponse.status}` }, 502, origin);
  }
  const upstreamPayload = (await upstreamResponse.json()) as unknown[];
  const translatedHtml = (upstreamPayload as any)?.[0]?.[0];
  if (typeof translatedHtml !== "string") {
    return json({ error: "unexpected upstream response shape" }, 502, origin);
  }
  return json({ translatedHtml }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const allowed = origin === env.ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return allowed ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response(null, { status: 403 });
    }
    if (!allowed) {
      return new Response(JSON.stringify({ error: "origin not allowed" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/translate") {
      return handleTranslate(request, env, origin);
    }
    return json({ error: "not found" }, 404, origin);
  },
};
