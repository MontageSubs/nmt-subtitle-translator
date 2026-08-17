export const PROBE_POOL_SIZE = 6;
export const PROBE_REQUIRED = 4;

export function requiredProbeIndices(nonce: number): number[] {
  const start = nonce % PROBE_POOL_SIZE;
  return Array.from({ length: PROBE_REQUIRED }, (_, i) => (start + i) % PROBE_POOL_SIZE);
}

export function probeBitmapValid(nonce: number, bitmap: number): boolean {
  if (!Number.isInteger(bitmap) || bitmap < 0 || bitmap >= 1 << PROBE_POOL_SIZE) return false;
  return requiredProbeIndices(nonce).every((index) => (bitmap >> index) & 1);
}
