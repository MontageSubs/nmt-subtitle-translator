const ENSURE_SCHEMA = `CREATE TABLE IF NOT EXISTS retry_token_guard (
  correlation_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
const ENSURE_INDEX = `CREATE INDEX IF NOT EXISTS idx_retry_token_guard_expires_at ON retry_token_guard(expires_at)`;

export async function consumeRetryTokenOnce(db: D1Database, correlationId: string, now: number, guardTtlMs: number): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(ENSURE_SCHEMA),
      db.prepare(ENSURE_INDEX),
      db.prepare("INSERT INTO retry_token_guard (correlation_id, expires_at) VALUES (?, ?)").bind(correlationId, now + guardTtlMs),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function pruneRetryTokenGuard(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM retry_token_guard WHERE expires_at < ?").bind(Date.now()).run();
}
