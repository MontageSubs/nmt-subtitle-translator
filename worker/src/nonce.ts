const ENSURE_SCHEMA = `CREATE TABLE IF NOT EXISTS nonce_guard (
  nonce INTEGER PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
const ENSURE_INDEX = `CREATE INDEX IF NOT EXISTS idx_nonce_guard_expires_at ON nonce_guard(expires_at)`;

export async function consumeNonceOnce(db: D1Database, nonce: number, now: number, ttlMs: number): Promise<boolean> {
  try {
    await db.batch([
      db.prepare(ENSURE_SCHEMA),
      db.prepare(ENSURE_INDEX),
      db.prepare("INSERT INTO nonce_guard (nonce, expires_at) VALUES (?, ?)").bind(nonce, now + Math.max(1000, ttlMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function pruneNonceGuard(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM nonce_guard WHERE expires_at < ?").bind(Date.now()).run();
}
