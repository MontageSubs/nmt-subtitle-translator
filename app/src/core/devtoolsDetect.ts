import { WORKER_URL } from "../config";

const PROBE_INTERVAL_MS = 2_000;

const nativeConsoleLog = console.log.bind(console);

let detected = false;
let beaconSent = false;
let timer: ReturnType<typeof setInterval> | null = null;

function onDetected(): void {
  detected = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
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
  nativeConsoleLog(trap);
}

export function startDevtoolsWatch(): void {
  if (timer || detected || typeof window === "undefined") return;
  timer = setInterval(() => {
    if (document.visibilityState === "visible") probe();
  }, PROBE_INTERVAL_MS);
}

export function wasDevtoolsDetected(): boolean {
  return detected;
}
