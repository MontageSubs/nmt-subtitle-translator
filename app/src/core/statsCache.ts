export interface CachedStats {
  total: number;
  last24h: number;
}

const CACHE_KEY = "nmt_stats_cache_v1";

export function readStatsCache(): CachedStats | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedStats) : null;
  } catch {
    return null;
  }
}

export function writeStatsCache(stats: CachedStats): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(stats));
  } catch {
    return;
  }
}
