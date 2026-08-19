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

/**
 * 统计口径见架构蓝图 §9.4：只记录服务端本次请求内真实翻译成功的 cue 数，
 * 不再信任客户端自报数字——不存在跨请求 job 边界判定问题，也无法被伪造。
 */
export function recordTranslatedUnits(ctx: ExecutionContext, env: Env, count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  const config = tursoConfig(env);
  if (!config) return;
  ctx.waitUntil(recordSuccess(config, count).catch((e) => reportError("recordSuccess failed", e)));
}
