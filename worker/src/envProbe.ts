export const PROBE_POOL_SIZE = 6;
export const PROBE_REQUIRED = 4;
export const PROBE_EXPECTED_SCORE = PROBE_REQUIRED;

export function requiredProbeIndices(nonce: number): number[] {
  const start = nonce % PROBE_POOL_SIZE;
  return Array.from({ length: PROBE_REQUIRED }, (_, i) => (start + i) % PROBE_POOL_SIZE);
}
