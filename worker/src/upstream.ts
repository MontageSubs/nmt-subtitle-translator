import { Env } from "./env";
import { reportError } from "./response";

const UPSTREAM_ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const FALLBACK_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BATCH_FANOUT_CONCURRENCY = 6;

export async function fetchUpstreamTranslation(env: Env, text: string, source: string, target: string, signal?: AbortSignal): Promise<string> {
  const headers = new Headers({ "Content-Type": "application/json+protobuf", "User-Agent": FALLBACK_USER_AGENT });
  const upstreamUrl = new URL(UPSTREAM_ENDPOINT);
  if (env.GOOGLE_TRANSLATE_API_KEY) {
    upstreamUrl.searchParams.set("key", env.GOOGLE_TRANSLATE_API_KEY);
    headers.set("X-Goog-Api-Key", env.GOOGLE_TRANSLATE_API_KEY);
  }
  const response = await fetch(upstreamUrl.toString(), {
    method: "POST", headers, body: JSON.stringify([[[text], source, target], "te"]), signal,
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const payload = (await response.json().catch(() => null)) as unknown;
  const translatedHtml = Array.isArray(payload) ? (payload as any)?.[0]?.[0] : undefined;
  if (typeof translatedHtml !== "string") throw new Error("unexpected upstream response shape");
  return translatedHtml;
}

export async function fanOutTranslations(env: Env, texts: string[], source: string, target: string, budgetMs: number): Promise<(string | null)[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const results: (string | null)[] = new Array(texts.length).fill(null);
  let cursor = 0;
  const runWorker = async () => {
    while (cursor < texts.length) {
      const i = cursor++;
      try {
        results[i] = await fetchUpstreamTranslation(env, texts[i], source, target, controller.signal);
      } catch (e) {
        reportError(`upstream batch ${i} failed`, e);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(BATCH_FANOUT_CONCURRENCY, texts.length) }, runWorker));
  } finally {
    clearTimeout(timer);
  }
  return results;
}
