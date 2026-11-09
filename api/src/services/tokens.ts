import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

/**
 * Signed, stateless session token: base64url(payload).base64url(HMAC-SHA256).
 * Any coordinator can verify it without a shared session store.
 */
export interface TokenPayload {
  username: string;
  isAdmin: boolean;
  expiresAt: number; // epoch ms
}

const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

const sign = (data: string) => createHmac("sha256", config.authSecret).update(data).digest("base64url");

export function issueToken(username: string, isAdmin: boolean): string {
  const payload: TokenPayload = { username, isAdmin, expiresAt: Date.now() + TOKEN_LIFETIME_MS };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

/** Returns the payload, or null if the token is malformed, forged or expired. */
export function readToken(token: string): TokenPayload | null {
  const [data, signature] = token.split(".");
  if (!data || !signature) return null;

  const expected = Buffer.from(sign(data));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as TokenPayload;
  return payload.expiresAt > Date.now() ? payload : null;
}
