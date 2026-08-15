import { WORKER_URL, WORKER_PUBLIC_KEY, REQUEST_TIMEOUT_MS, assertConfigured } from "../config";

let keyPromise: Promise<CryptoKey> | null = null;

function base64ToBytes(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function importPublicKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "spki",
      base64ToBytes(WORKER_PUBLIC_KEY),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
  }
  return keyPromise;
}

async function encryptedAuthHeader(): Promise<string> {
  const key = await importPublicKey();
  const plaintext = new TextEncoder().encode(JSON.stringify({ ts: Date.now() }));
  const ciphertext = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, plaintext);
  return bytesToBase64(ciphertext);
}

export class WorkerRequestError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

export async function postTranslateHtml(html: string, sourceLang: string, targetLang: string): Promise<string> {
  assertConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${WORKER_URL}/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth": await encryptedAuthHeader(),
      },
      body: JSON.stringify({ html, source: sourceLang, target: targetLang }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new WorkerRequestError(`worker responded ${response.status}`, retryable);
    }
    const payload = await response.json();
    if (typeof payload.translatedHtml !== "string") {
      throw new WorkerRequestError("worker response missing translatedHtml", false);
    }
    return payload.translatedHtml;
  } finally {
    clearTimeout(timer);
  }
}
