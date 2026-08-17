const REPLAY_NAMESPACE = "https://replay-guard.internal/token/";

function cacheKey(nonce: number): Request {
  return new Request(`${REPLAY_NAMESPACE}${nonce}`);
}

export async function consumeNonceOnce(nonce: number, ttlMs: number): Promise<boolean> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(nonce);
  if (await cache.match(key)) return false;
  await cache.put(key, new Response(null, { headers: { "Cache-Control": `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}` } }));
  return true;
}
