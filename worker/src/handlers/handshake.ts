import { Env, STANDBY_TTL_MS, maxBatchChars } from "../env";
import { issueSession } from "../token";
import { resolveSecretRing } from "../secret";
import { json, parseBody } from "../response";
import { loadStats, reportPending } from "../stats";

export async function handleHandshake(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = (await parseBody<{ pendingSuccess?: number }>(request)) || {};
  reportPending(ctx, env, body.pendingSuccess);
  const ring = await resolveSecretRing(env.WORKER_SECRET, env.WORKER_SALT || "");
  const [{ token, challengeKey, nonce }, stats] = await Promise.all([issueSession(ring, STANDBY_TTL_MS), loadStats(env)]);
  return json({ token, challengeKey, nonce, maxChars: maxBatchChars(env), stats }, 200, origin, env);
}
