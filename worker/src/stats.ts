import { Env, tursoConfig } from "./env";
import { recordSuccess, readStats } from "./turso";
import { reportError } from "./response";

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

export function recordCompletedJob(ctx: ExecutionContext, env: Env): void {
  const config = tursoConfig(env);
  if (!config) return;
  ctx.waitUntil(recordSuccess(config, 1).catch((e) => reportError("recordSuccess failed", e)));
}
