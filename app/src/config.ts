export const WORKER_URL: string = import.meta.env.VITE_WORKER_URL || "";
export const WORKER_PUBLIC_KEY: string = import.meta.env.VITE_WORKER_PUBLIC_KEY || "";

export const DEFAULT_BATCH_CHARS = 3000;
export const DEFAULT_CONCURRENCY = 6;
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 3000;
export const REQUEST_TIMEOUT_MS = 30000;

export function assertConfigured(): void {
  if (!WORKER_URL || !WORKER_PUBLIC_KEY) {
    throw new Error(
      "VITE_WORKER_URL / VITE_WORKER_PUBLIC_KEY 未配置：静态页面需要通过 Worker 转发翻译请求，" +
      "并用公钥加密请求时间戳，请在部署环境变量中设置（见 README 部署章节）。"
    );
  }
}
