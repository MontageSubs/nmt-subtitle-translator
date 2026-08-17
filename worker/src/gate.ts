import { Env } from "./env";
import { checkGate, recordViolation } from "./reputation";
import { logGate } from "./response";

const DEFAULT_RATE_LIMIT_UNIT_CHARS = 500;
const RELAXED_RATE_LIMIT_MULTIPLIER = 4;

function rateLimitUnitChars(env: Env): number {
  return Number(env.RATE_LIMIT_UNIT_CHARS) || DEFAULT_RATE_LIMIT_UNIT_CHARS;
}

export async function gateForRequest(env: Env, ip: string, now: number) {
  try {
    return await checkGate(env.DB, ip, now);
  } catch (e) {
    logGate("d1_read_failed_failopen", ip, { message: e instanceof Error ? e.message : String(e) });
    return { blocked: false, quarantined: false, requireClearance: false, degraded: true };
  }
}

export function flagViolation(ctx: ExecutionContext, env: Env, ip: string, now: number): void {
  ctx.waitUntil(recordViolation(env.DB, ip, now).catch((e) => logGate("d1_write_failed", ip, { op: "recordViolation", message: String(e) })));
}

export async function consumeRateLimit(env: Env, ip: string, chars: number, relaxed: boolean): Promise<boolean> {
  const unit = rateLimitUnitChars(env) / (relaxed ? RELAXED_RATE_LIMIT_MULTIPLIER : 1);
  const hits = Math.max(1, Math.ceil(chars / unit));
  const results = await Promise.all(Array.from({ length: hits }, () => env.RATE_LIMITER.limit({ key: ip })));
  return results.every((r) => r.success);
}
