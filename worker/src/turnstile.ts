import { base64url, base64urlDecode, hmacHex, timingSafeEqual } from "./crypto";

const VERIFY_ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CLEARANCE_TTL_MS = 5 * 60_000;

export async function verifyTurnstileToken(secretKey: string, responseToken: string, remoteIp: string): Promise<boolean> {
  const body = new URLSearchParams({ secret: secretKey, response: responseToken, remoteip: remoteIp });
  const res = await fetch(VERIFY_ENDPOINT, { method: "POST", body });
  const data = await res.json<{ success: boolean }>().catch(() => ({ success: false }));
  return Boolean(data.success);
}

export async function issueClearance(secret: string): Promise<string> {
  const encoded = base64url(JSON.stringify({ exp: Date.now() + CLEARANCE_TTL_MS }));
  return `${encoded}.${await hmacHex(secret, encoded)}`;
}

export async function verifyClearance(secret: string, clearance: string | null | undefined): Promise<boolean> {
  if (!clearance) return false;
  const [encoded, signature] = clearance.split(".");
  if (!encoded || !signature) return false;
  if (!timingSafeEqual(await hmacHex(secret, encoded), signature)) return false;
  try {
    const { exp } = JSON.parse(base64urlDecode(encoded));
    return Date.now() < exp;
  } catch {
    return false;
  }
}
