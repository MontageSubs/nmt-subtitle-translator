import { Env } from "./env";

const PREFLIGHT_MAX_AGE = "7200";
const MIN_AUDITED_SECRET_LENGTH = 8;

export function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
    Vary: "Origin",
  };
}

function auditedSecrets(env: Env): string[] {
  return [
    env.WORKER_SALT, env.TURSO_AUTH_TOKEN, env.TURNSTILE_SECRET_KEY, env.GOOGLE_TRANSLATE_API_KEY,
    env.CF_API_TOKEN, env.CF_ACCOUNT_ID, env.TURSO_URL, ...(env.WORKER_SECRET || "").split("\n"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length >= MIN_AUDITED_SECRET_LENGTH);
}

export function json(body: unknown, status: number, origin: string, env: Env): Response {
  const serialized = JSON.stringify(body);
  if (auditedSecrets(env).some((secret) => serialized.includes(secret))) {
    console.error(JSON.stringify({ event: "output_blocked", ts: Date.now() }));
    return new Response(JSON.stringify({ error: "output_blocked" }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
  }
  return new Response(serialized, { status, headers: { "Content-Type": "application/json", ...corsHeaders(origin) } });
}

export async function parseBody<T>(request: Request): Promise<T | null> {
  const raw = await request.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function logGate(event: string, ip: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ip, ts: Date.now(), ...extra }));
}

export function reportError(label: string, e: unknown): void {
  console.error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
}
