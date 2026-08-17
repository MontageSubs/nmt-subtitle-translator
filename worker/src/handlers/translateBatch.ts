import { Env, ACTIVE_TTL_MS, BATCH_CHARS_TOLERANCE, maxBatchChars, maxBatchesPerRequest, remainingBudgetMs } from "../env";
import { issueSession, verifyToken } from "../token";
import { computeAnswer, deriveChallengeKey } from "../challenge";
import { probeBitmapValid } from "../envProbe";
import { verifyClearance } from "../turnstile";
import { consumeFreeQuota } from "../reputation";
import { resolveSecretRing } from "../secret";
import { consumeNonceOnce } from "../nonce";
import { hashIp, clientIp } from "../identity";
import { json, parseBody, logGate, reportError } from "../response";
import { gateForRequest, consumeBurst, escalateOnBurstTrip, consumeRateLimit } from "../gate";
import { reportPending } from "../stats";
import { fanOutTranslations } from "../upstream";

const BATCH_JOIN_SEPARATOR = "\u0000";

interface TranslateBatchRequestBody {
  token?: string;
  answer?: number;
  batches?: string[];
  source?: string;
  target?: string;
  pendingSuccess?: number;
  clearance?: string;
  probeBitmap?: number;
}

export async function handleTranslateBatch(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const startedAt = Date.now();
  const body = await parseBody<TranslateBatchRequestBody>(request);
  if (!body) return json({ error: "malformed JSON" }, 400, origin, env);

  const ipHash = await hashIp(env, clientIp(request));
  const now = Date.now();

  if (!(await consumeBurst(env, ipHash))) {
    escalateOnBurstTrip(ctx, env, ipHash, now);
    logGate("burst_detected", ipHash, { path: "/translate-batch" });
    return json({ error: "rate_limited", trigger_turnstile: true }, 429, origin, env);
  }

  const gate = await gateForRequest(env, ipHash, now);
  if (gate.blocked) {
    logGate("ip_blocked", ipHash);
    return json({ error: "too many failed verifications, try again later" }, 403, origin, env);
  }

  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const verified = await verifyToken(ring, body.token || "");
  if (!verified) {
    return json({ error: "invalid or expired token" }, 401, origin, env);
  }
  const { payload, secret: matchedSecret } = verified;

  if (!(await consumeNonceOnce(env.DB, payload.nonce, now, payload.ttl))) {
    logGate("token_replay", ipHash);
    return json({ error: "token already used" }, 401, origin, env);
  }

  const { batches, source, target } = body;
  const cap = maxBatchesPerRequest(env);
  if (!Array.isArray(batches) || !batches.length || batches.length > cap || !source || !target || batches.some((b) => typeof b !== "string")) {
    return json({ error: "invalid translate-batch request" }, 400, origin, env);
  }

  const limit = maxBatchChars(env);
  if (batches.some((b) => b.length > limit * BATCH_CHARS_TOLERANCE)) {
    return json({ error: "payload exceeds maxChars", maxChars: limit }, 413, origin, env);
  }

  const probeBitmap = Number(body.probeBitmap);
  const keyBytes = await deriveChallengeKey(matchedSecret, payload.nonce);
  const expected = await computeAnswer(keyBytes, payload.nonce, batches.join(BATCH_JOIN_SEPARATOR), probeBitmap);
  if (expected !== body.answer) {
    logGate("challenge_mismatch", ipHash);
    return json({ error: "challenge mismatch" }, 403, origin, env);
  }

  const cleared = await verifyClearance(ring, body.clearance);
  if (!cleared) {
    if (gate.requireClearance) {
      logGate("turnstile_triggered", ipHash, { reason: "quarantine" });
      return json({ error: "quarantine active", trigger_turnstile: true }, 429, origin, env);
    }
    if (!probeBitmapValid(payload.nonce, probeBitmap)) {
      logGate("turnstile_triggered", ipHash, { reason: "env_check_failed" });
      return json({ error: "environment check failed", trigger_turnstile: true }, 429, origin, env);
    }
    if (gate.quarantined) {
      ctx.waitUntil(consumeFreeQuota(env.DB, ipHash, now).catch((e) => logGate("d1_write_failed", ipHash, { op: "consumeFreeQuota", message: String(e) })));
    }
  }

  const totalChars = batches.reduce((sum, b) => sum + b.length, 0);
  try {
    const success = await consumeRateLimit(env, ipHash, totalChars, gate.degraded, cleared);
    if (!success) {
      logGate("rate_limited", ipHash, { cleared });
      return json({ error: "rate_limited", trigger_turnstile: !cleared }, 429, origin, env);
    }
  } catch (e) {
    reportError("rate limiter unavailable, failing open", e);
  }

  const results = await fanOutTranslations(env, batches, source, target, remainingBudgetMs(startedAt));

  reportPending(ctx, env, body.pendingSuccess);
  const { token, challengeKey, nonce } = await issueSession(ring, ACTIVE_TTL_MS);
  return json({ results, token, challengeKey, nonce, maxChars: limit }, 200, origin, env);
}
