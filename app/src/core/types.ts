export interface Cue {
  id: number;
  start: string;
  end: string;
  text: string;
}

export type OutputMode = "bilingual" | "monolingual";

export type Glossary = Record<string, string>;
