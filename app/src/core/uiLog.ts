type Sink = (message: string) => void;

let sink: Sink | null = null;

export function setUiLogSink(next: Sink): void {
  sink = next;
}

export function uiLog(message: string): void {
  sink?.(message);
}
