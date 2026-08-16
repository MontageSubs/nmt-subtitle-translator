import { WORKER_URL } from "../config";

const PROBE_INTERVAL_MS = 2_000;

let detected = false;
let beaconSent = false;
let timer: ReturnType<typeof setInterval> | null = null;

function onDetected(): void {
  detected = true;
  if (beaconSent || !WORKER_URL || typeof navigator.sendBeacon !== "function") return;
  beaconSent = true;
  navigator.sendBeacon(`${WORKER_URL}/devtools-signal`, new Blob([], { type: "text/plain" }));
}

function probe(): void {
  const trap = /./;
  Object.defineProperty(trap, "toString", {
    value: () => {
      onDetected();
      return "";
    },
  });
  console.log("%s", trap);
}

export function startDevtoolsWatch(): void {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => {
    if (document.visibilityState === "visible") probe();
  }, PROBE_INTERVAL_MS);
}

export function wasDevtoolsDetected(): boolean {
  return detected;
}
