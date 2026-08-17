import { Env, tursoConfig } from "./env";
import { recordSuccess, readStats } from "./turso";
import { reportError } from "./response";

const MAX_PENDING_SUCCESS_PER_REQUEST = 500;

export async function loadStats(env: Env) {
  const config = tursoConfig(env);
  if (!config) return { total: 0, last24h: 0 };
  try {
    return await readStats(config);
  } catch (e) {
    reportError("readStats failed", e);
    return { total: 0, last24h: 0 };
  }
}

export function reportPending(ctx: ExecutionContext, env: Env, pendingSuccess: unknown): void {
  const count = Math.floor(Number(pendingSuccess));
  if (!Number.isFinite(count) || count <= 0 || count > MAX_PENDING_SUCCESS_PER_REQUEST) return;
  const config = tursoConfig(env);
  if (!config) return;
  ctx.waitUntil(recordSuccess(config, count).catch((e) => reportError("recordSuccess failed", e)));
}
