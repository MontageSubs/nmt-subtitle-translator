import { Env, ACTIVE_TTL_MS, maxBatchChars, maxContentChars } from "../env";
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
import { recordTranslatedUnits } from "../stats";
import { runTranslateJob } from "../core/pipeline";
import { Glossary } from "../core/srtExtract";
import { ProtocolCue, canonicalizeCues, isValidProtocolCue } from "../protocol";

interface TranslateJobRequestBody {
  token?: string;
  answer?: number;
  cues?: ProtocolCue[];
  glossary?: Glossary;
  source?: string;
  target?: string;
  sceneChangeSeconds?: number;
  clearance?: string;
  probeBitmap?: number;
}

const MAX_GLOSSARY_ENTRIES = 500;
const MAX_GLOSSARY_ENTRY_CHARS = 200;
const MAX_CUES_PER_REQUEST = 20_000;

function isValidGlossary(value: unknown): value is Glossary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_GLOSSARY_ENTRIES) return false;
  return entries.every(([k, v]) => typeof k === "string" && typeof v === "string" && k.length <= MAX_GLOSSARY_ENTRY_CHARS && v.length <= MAX_GLOSSARY_ENTRY_CHARS);
}

function isValidCues(value: unknown): value is ProtocolCue[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_CUES_PER_REQUEST && value.every(isValidProtocolCue);
}

export async function handleTranslateJob(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const startedAt = Date.now();
  const body = await parseBody<TranslateJobRequestBody>(request);
  if (!body) return json({ error: "malformed JSON" }, 400, origin, env);

  const ipHash = await hashIp(env, clientIp(request));
  const now = Date.now();

  if (!(await consumeBurst(env, ipHash))) {
    escalateOnBurstTrip(ctx, env, ipHash, now);
    logGate("burst_detected", ipHash, { path: "/translate-job" });
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

  const { source, target, sceneChangeSeconds } = body;
  const glossary = isValidGlossary(body.glossary) ? body.glossary : {};
  if (!isValidCues(body.cues) || !source || !target) {
    return json({ error: "invalid translate-job request" }, 400, origin, env);
  }
  const cues = body.cues;

  const contentLimit = maxContentChars(env);
  const totalChars = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  if (totalChars > contentLimit) {
    return json({ error: "payload exceeds maxContentChars", maxContentChars: contentLimit }, 413, origin, env);
  }

  const probeBitmap = Number(body.probeBitmap);
  const keyBytes = await deriveChallengeKey(matchedSecret, payload.nonce);
  const expected = await computeAnswer(keyBytes, payload.nonce, canonicalizeCues(cues), probeBitmap);
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

  try {
    const success = await consumeRateLimit(env, ipHash, totalChars, gate.degraded, cleared);
    if (!success) {
      logGate("rate_limited", ipHash, { cleared });
      return json({ error: "rate_limited", trigger_turnstile: !cleared }, 429, origin, env);
    }
  } catch (e) {
    reportError("rate limiter unavailable, failing open", e);
  }

  let job: Awaited<ReturnType<typeof runTranslateJob>>;
  try {
    job = await runTranslateJob(env, { cues, glossary, source, target, sceneChangeSeconds }, maxBatchChars(env), startedAt);
  } catch (e) {
    reportError("translate job failed", e);
    return json({ error: "translate job failed" }, 502, origin, env);
  }

  recordTranslatedUnits(ctx, env, job.cues.length - job.missing_count);
  const { token, challengeKey, nonce } = await issueSession(ring, ACTIVE_TTL_MS);
  return json({ ...job, token, challengeKey, nonce }, 200, origin, env);
}
