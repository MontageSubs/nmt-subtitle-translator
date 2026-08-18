export interface Cue {
  id: number;
  start: string;
  end: string;
  text: string;
}

export type BoundaryTag = "marker" | "dash" | "gap" | "music" | null;

export interface Span {
  id: number;
  start: string;
  end: string;
  text: string;
  boundary: BoundaryTag;
  dash_index: number;
  kind: "dialogue" | "music";
}

export interface TermMatch {
  start: number;
  end: number;
  source: string;
  target: string;
}

export interface Unit {
  id: number;
  spans: Span[];
  text: string;
  term_matches: TermMatch[];
  embed_ratio: number;
  resolved: string | null;
}

export interface Chapter {
  id: number;
  kind: "dialogue" | "music";
  unit_ids: number[];
}

export interface ExtractResult {
  success: boolean;
  cues: Cue[];
  units: Unit[];
  chapters: Chapter[];
  sdh_removed: { dropped: number; stripped: number };
  marker_merges: number;
}

export interface BilingualCue extends Cue {
  translation: string | null;
}
