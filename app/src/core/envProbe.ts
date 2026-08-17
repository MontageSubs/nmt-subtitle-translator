type Probe = () => boolean;

const pool: Probe[] = [
  () => typeof window !== "undefined" && typeof document !== "undefined" && typeof navigator !== "undefined",
  () => navigator.webdriver !== true,
  () => typeof requestAnimationFrame === "function",
  () => Boolean(document.createElement("canvas").getContext("2d")),
  () => Function.prototype.toString.call(Array.prototype.map).includes("[native code]"),
  () => typeof performance?.now === "function" && typeof performance.now() === "number",
];

export function computeProbeBitmap(): number {
  return pool.reduce((bitmap, probe, index) => (probe() ? bitmap | (1 << index) : bitmap), 0);
}
