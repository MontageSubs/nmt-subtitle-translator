const PROBE_POOL_SIZE = 6;
const PROBE_REQUIRED = 4;

type Probe = () => boolean;

const pool: Probe[] = [
  () => typeof window !== "undefined" && typeof document !== "undefined" && typeof navigator !== "undefined",
  () => navigator.webdriver !== true,
  () => typeof requestAnimationFrame === "function",
  () => Boolean(document.createElement("canvas").getContext("2d")),
  () => Function.prototype.toString.call(Array.prototype.map).includes("[native code]"),
  () => typeof performance?.now === "function" && typeof performance.now() === "number",
];

function requiredProbeIndices(nonce: number): number[] {
  const start = nonce % PROBE_POOL_SIZE;
  return Array.from({ length: PROBE_REQUIRED }, (_, i) => (start + i) % PROBE_POOL_SIZE);
}

export function computeEnvScore(nonce: number): number {
  return requiredProbeIndices(nonce).reduce((sum, index) => sum + (pool[index]() ? 1 : 0), 0);
}
