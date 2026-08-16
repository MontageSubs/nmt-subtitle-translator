export interface Gate {
  blocked: boolean;
  quarantined: boolean;
  requireClearance: boolean;
}

interface ReputationRow {
  quarantine_until: number;
  quarantine_days: number;
  blocked_until: number;
  day_bucket: number;
  free_used: number;
  captcha_count: number;
}

const DAY_MS = 86_400_000;
const QUARANTINE_BASE_DAYS = 3;
const QUARANTINE_MAX_DAYS = 40;
const DAILY_FREE_QUOTA = 1;
const DAILY_CAPTCHA_CAP = 500;
const BLOCK_DURATION_MS = DAY_MS;
const REPUTATION_RETENTION_MS = QUARANTINE_MAX_DAYS * DAY_MS;

const ENSURE_SCHEMA = `CREATE TABLE IF NOT EXISTS ip_reputation (
  ip TEXT PRIMARY KEY,
  quarantine_until INTEGER NOT NULL DEFAULT 0,
  quarantine_days INTEGER NOT NULL DEFAULT ${QUARANTINE_BASE_DAYS},
  blocked_until INTEGER NOT NULL DEFAULT 0,
  day_bucket INTEGER NOT NULL DEFAULT 0,
  free_used INTEGER NOT NULL DEFAULT 0,
  captcha_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

function dayBucket(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

async function loadRow(db: D1Database, ip: string): Promise<ReputationRow | null> {
  await db.prepare(ENSURE_SCHEMA).run();
  return db.prepare("SELECT quarantine_until, quarantine_days, blocked_until, day_bucket, free_used, captcha_count FROM ip_reputation WHERE ip = ?")
    .bind(ip).first<ReputationRow>();
}

export async function checkGate(db: D1Database, ip: string, now: number): Promise<Gate> {
  const row = await loadRow(db, ip);
  if (!row) return { blocked: false, quarantined: false, requireClearance: false };
  if (row.blocked_until > now) return { blocked: true, quarantined: true, requireClearance: true };
  if (row.quarantine_until > now) {
    const used = row.day_bucket === dayBucket(now) ? row.free_used : 0;
    return { blocked: false, quarantined: true, requireClearance: used >= DAILY_FREE_QUOTA };
  }
  return { blocked: false, quarantined: false, requireClearance: false };
}

export async function consumeFreeQuota(db: D1Database, ip: string, now: number): Promise<void> {
  await db.prepare(ENSURE_SCHEMA).run();
  await db.prepare(
    `UPDATE ip_reputation SET
       free_used = CASE WHEN day_bucket = ?2 THEN free_used + 1 ELSE 1 END,
       day_bucket = ?2,
       updated_at = ?3
     WHERE ip = ?1`
  ).bind(ip, dayBucket(now), now).run();
}

export async function recordViolation(db: D1Database, ip: string, now: number): Promise<void> {
  const row = await loadRow(db, ip);
  const quarantineDays = row?.quarantine_days || QUARANTINE_BASE_DAYS;
  const quarantineUntil = now + quarantineDays * DAY_MS;
  await db.prepare(
    `INSERT INTO ip_reputation (ip, quarantine_until, quarantine_days, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(ip) DO UPDATE SET quarantine_until = ?2, quarantine_days = ?3, updated_at = ?4`
  ).bind(ip, quarantineUntil, quarantineDays, now).run();
}

export async function recordCaptchaSolved(db: D1Database, ip: string, now: number): Promise<boolean> {
  const row = await loadRow(db, ip);
  const bucket = dayBucket(now);
  const count = row?.day_bucket === bucket ? row.captcha_count + 1 : 1;

  if (count <= DAILY_CAPTCHA_CAP) {
    await db.prepare(
      `INSERT INTO ip_reputation (ip, day_bucket, captcha_count, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(ip) DO UPDATE SET day_bucket = ?2, captcha_count = ?3, updated_at = ?4`
    ).bind(ip, bucket, count, now).run();
    return false;
  }

  const quarantineDays = Math.min((row?.quarantine_days || QUARANTINE_BASE_DAYS) * 2, QUARANTINE_MAX_DAYS);
  const blockedUntil = now + BLOCK_DURATION_MS;
  const quarantineUntil = now + quarantineDays * DAY_MS;
  await db.prepare(
    `INSERT INTO ip_reputation (ip, day_bucket, captcha_count, quarantine_days, quarantine_until, blocked_until, updated_at)
     VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6)
     ON CONFLICT(ip) DO UPDATE SET day_bucket = ?2, captcha_count = 0, quarantine_days = ?3, quarantine_until = ?4, blocked_until = ?5, updated_at = ?6`
  ).bind(ip, bucket, quarantineDays, quarantineUntil, blockedUntil, now).run();
  return true;
}

export async function pruneReputation(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM ip_reputation WHERE updated_at < ?").bind(Date.now() - REPUTATION_RETENTION_MS).run();
}
