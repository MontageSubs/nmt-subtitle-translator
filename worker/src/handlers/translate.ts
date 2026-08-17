import { Env, ACTIVE_TTL_MS, BATCH_CHARS_TOLERANCE, maxBatchChars, remainingBudgetMs } from "../env";
import { issueSession, verifyToken } from "../token";
import { computeAnswer, deriveChallengeKey } from "../challenge";
import { probeBitmapValid } from "../envProbe";
import { verifyClearance } from "../turnstile";
import { consumeFreeQuota } from "../reputation";
import { resolveSecretRing } from "../secret";
import { consumeNonceOnce } from "../nonce";
import { json, parseBody, logGate, reportError } from "../response";
import { gateForRequest, flagViolation, consumeRateLimit } from "../gate";
import { reportPending } from "../stats";
import { fetchUpstreamTranslation } from "../upstream";

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

export async function handleTranslate(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const startedAt = Date.now();
  const body = await parseBody<TranslateRequestBody>(request);
  if (!body) return json({ error: "malformed JSON" }, 400, origin, env);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();

  const gate = await gateForRequest(env, ip, now);
  if (gate.blocked) {
    logGate("ip_blocked", ip);
    return json({ error: "too many failed verifications, try again later" }, 403, origin, env);
  }

  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const verified = await verifyToken(ring, body.token || "");
  if (!verified) {
    flagViolation(ctx, env, ip, now);
    return json({ error: "invalid or expired token" }, 401, origin, env);
  }
  const { payload, secret: matchedSecret } = verified;

  if (!(await consumeNonceOnce(env.DB, payload.nonce, now, payload.ttl))) {
    flagViolation(ctx, env, ip, now);
    logGate("token_replay", ip);
    return json({ error: "token already used" }, 401, origin, env);
  }

  const { text, source, target } = body;
  if (!text || !source || !target) return json({ error: "invalid translate request" }, 400, origin, env);

  const limit = maxBatchChars(env);
  if (text.length > limit * BATCH_CHARS_TOLERANCE) return json({ error: "payload exceeds maxChars", maxChars: limit }, 413, origin, env);

  const probeBitmap = Number(body.probeBitmap);
  const keyBytes = await deriveChallengeKey(matchedSecret, payload.nonce);
  const expected = await computeAnswer(keyBytes, payload.nonce, text, probeBitmap);
  if (expected !== body.answer) {
    flagViolation(ctx, env, ip, now);
    logGate("turnstile_triggered", ip, { reason: "challenge_mismatch" });
    return json({ error: "challenge mismatch" }, 403, origin, env);
  }

  const cleared = await verifyClearance(ring, body.clearance);
  if (!cleared) {
    if (gate.requireClearance) {
      logGate("turnstile_triggered", ip, { reason: "quarantine" });
      return json({ error: "quarantine active", trigger_turnstile: true }, 429, origin, env);
    }
    if (!probeBitmapValid(payload.nonce, probeBitmap)) {
      logGate("turnstile_triggered", ip, { reason: "env_check_failed" });
      return json({ error: "environment check failed", trigger_turnstile: true }, 429, origin, env);
    }
    if (gate.quarantined) {
      ctx.waitUntil(consumeFreeQuota(env.DB, ip, now).catch((e) => logGate("d1_write_failed", ip, { op: "consumeFreeQuota", message: String(e) })));
    }
  }

  try {
    const success = await consumeRateLimit(env, ip, text.length, gate.degraded);
    if (!success) {
      logGate("turnstile_triggered", ip, { reason: "rate_limited" });
      return json({ error: "rate_limited", trigger_turnstile: true }, 429, origin, env);
    }
  } catch (e) {
    reportError("rate limiter unavailable, failing open", e);
  }

  let translatedHtml: string;
  try {
    translatedHtml = await fetchUpstreamTranslation(env, text, source, target, AbortSignal.timeout(remainingBudgetMs(startedAt)));
  } catch (e) {
    reportError("upstream translate failed", e);
    return json({ error: "upstream translate failed" }, 502, origin, env);
  }

  reportPending(ctx, env, body.pendingSuccess);
  const { token, challengeKey, nonce } = await issueSession(ring, ACTIVE_TTL_MS);
  return json({ translatedHtml, token, challengeKey, nonce, maxChars: limit }, 200, origin, env);
}
