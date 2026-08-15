import type { Segment as SegmentInstance } from "segmentit";

export type SyncCutter = (text: string) => string[];

let segmentPromise: Promise<SegmentInstance | null> | null = null;

async function loadSegmenter(): Promise<SegmentInstance | null> {
  if (!segmentPromise) {
    segmentPromise = import("segmentit")
      .then(({ Segment, useDefault }) => useDefault(new Segment()))
      .catch((e) => {
        console.warn("segmentit unavailable, falling back to punctuation boundaries:", e);
        return null;
      });
  }
  return segmentPromise;
}

export async function getSyncCutter(): Promise<SyncCutter | null> {
  const segment = await loadSegmenter();
  return segment ? (text: string) => segment.doSegment(text).map((token) => token.w) : null;
}

export async function registerGlossaryTerm(term: string): Promise<void> {
  const segment = await loadSegmenter();
  if (!segment || !term) return;
  segment.loadDict(`${term}|${segment.POSTAG.D_N}|1000`);
}
