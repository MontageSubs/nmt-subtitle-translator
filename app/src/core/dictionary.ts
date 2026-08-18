import { Glossary, splitNamePair } from "./srtExtract";

export interface DictionaryEntry {
  source: string;
  target: string;
}

const BUNDLED_DICTIONARIES = import.meta.glob("../dictionaries/*.json", { eager: false }) as Record<string, () => Promise<{ default: DictionaryEntry[] }>>;

function dictionaryPath(languageCode: string): string {
  return `../dictionaries/${languageCode}.json`;
}

export async function loadBundledDictionary(languageCode: string): Promise<DictionaryEntry[]> {
  const loader = BUNDLED_DICTIONARIES[dictionaryPath(languageCode)];
  if (!loader) return [];
  try {
    return (await loader()).default;
  } catch {
    return [];
  }
}

export function entriesToGlossary(entries: DictionaryEntry[]): Glossary {
  const glossary: Glossary = {};
  for (const { source, target } of entries) {
    for (const [term, mapped] of splitNamePair(source.trim(), target.trim())) {
      if (term && !(term in glossary)) glossary[term] = mapped;
    }
  }
  return glossary;
}

export function glossaryToEntries(glossary: Glossary): DictionaryEntry[] {
  return Object.entries(glossary).map(([source, target]) => ({ source, target }));
}

export function parseDictionaryJson(content: string): DictionaryEntry[] {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error("词典文件格式应为 JSON 数组");
  return parsed
    .filter((row): row is DictionaryEntry => typeof row?.source === "string" && typeof row?.target === "string")
    .map((row) => ({ source: row.source.trim(), target: row.target.trim() }))
    .filter((row) => row.source);
}

export function serializeDictionaryJson(entries: DictionaryEntry[]): string {
  return JSON.stringify(entries.filter((e) => e.source.trim()), null, 2);
}
