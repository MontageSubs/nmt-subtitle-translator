export interface Cue {
  id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  position?: string;
}

export type OutputMode = "bilingual" | "monolingual";

export type Glossary = Record<string, string>;
