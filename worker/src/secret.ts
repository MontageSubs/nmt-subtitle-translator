import { hmacHex } from "./crypto";

export interface SecretRing {
  current: string;
  previous?: string;
}

const ROTATION_GRACE_SECONDS = 3600;

interface ParsedRing {
  current: string;
  previous?: string;
  rotatedAt?: number;
}

function parseRing(raw: string): ParsedRing {
  const [current, previous, rotatedAt] = raw.split("\n").map((line) => line.trim());
  return { current, previous: previous || undefined, rotatedAt: rotatedAt ? Number(rotatedAt) : undefined };
}

async function deriveKey(secret: string, salt: string): Promise<string> {
  return salt ? hmacHex(secret, salt) : secret;
}

export async function resolveSecretRing(rawSecret: string, salt: string): Promise<SecretRing> {
  const parsed = parseRing(rawSecret);
  const current = await deriveKey(parsed.current, salt);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const withinGrace = Boolean(parsed.previous) && Boolean(parsed.rotatedAt) && nowSeconds - (parsed.rotatedAt as number) < ROTATION_GRACE_SECONDS;
  const previous = withinGrace ? await deriveKey(parsed.previous as string, salt) : undefined;
  return { current, previous };
}

export function ringSecrets(ring: SecretRing): string[] {
  return ring.previous ? [ring.current, ring.previous] : [ring.current];
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nextRingText(rawCurrent: string): string {
  const currentLine = (rawCurrent.split("\n")[0] || "").trim();
  const nowSeconds = Math.floor(Date.now() / 1000);
  return `${randomHex(32)}\n${currentLine}\n${nowSeconds}`;
}
