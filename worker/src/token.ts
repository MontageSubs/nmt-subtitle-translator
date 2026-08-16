import { base64url, base64urlDecode, hmacHex, timingSafeEqual } from "./crypto";
import { deriveChallengeKey } from "./challenge";

interface TokenPayload {
  ts: number;
  ttl: number;
  nonce: number;
}

export interface IssuedSession {
  token: string;
  challengeKey: string;
  nonce: number;
}

function toBase64(bytes: Uint8Array): string {
  return base64url(String.fromCharCode(...bytes));
}

export async function issueSession(secret: string, ttl: number): Promise<IssuedSession> {
  const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
  const payload: TokenPayload = { ts: Date.now(), ttl, nonce };
  const encoded = base64url(JSON.stringify(payload));
  const signature = await hmacHex(secret, encoded);
  const challengeKey = toBase64(await deriveChallengeKey(secret, nonce));
  return { token: `${encoded}.${signature}`, challengeKey, nonce };
}

export async function verifyToken(secret: string, token: string): Promise<TokenPayload | null> {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = await hmacHex(secret, encoded);
  if (!timingSafeEqual(expected, signature)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch {
    return null;
  }
  const age = Date.now() - payload.ts;
  if (!Number.isFinite(age) || age < -5000 || age > payload.ttl) return null;
  return payload;
}
