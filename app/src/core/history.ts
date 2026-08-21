import { SubtitleFormat } from "./types";

export interface HistoryEntry {
  id: string;
  filename: string;
  sourceLang: string;
  targetLang: string;
  format: SubtitleFormat;
  cueCount: number;
  content: string;
  createdAt: number;
}

const DB_NAME = "nmt-history";
const DB_VERSION = 1;
const STORE_NAME = "entries";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" }).createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDb();
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

export async function saveHistoryEntry(entry: Omit<HistoryEntry, "id" | "createdAt">): Promise<void> {
  const record: HistoryEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() };
  const store = await getStore("readwrite");
  await runRequest(store.add(record));
}

export async function listHistoryEntries(): Promise<HistoryEntry[]> {
  const store = await getStore("readonly");
  const entries = await runRequest(store.getAll() as IDBRequest<HistoryEntry[]>);
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const store = await getStore("readwrite");
  await runRequest(store.delete(id));
}

export async function clearHistory(): Promise<void> {
  const store = await getStore("readwrite");
  await runRequest(store.clear());
}
