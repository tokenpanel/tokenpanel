import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ObjectId } from "mongodb";
import type { UserRole } from "@tokenpanel/db";

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  const hex: string[] = [];
  for (const b of buf) {
    hex.push(b.toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface JwtPayload {
  sub: string;
  orgId: string;
  role: UserRole;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64UrlEncode(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? encoder.encode(input) : input;
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(input: string): string {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return decoder.decode(bytes);
}

function b64UrlDecodeBytes(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function sign(data: string, secret: string): string {
  const sig = createHmac("sha256", encoder.encode(secret))
    .update(encoder.encode(data))
    .digest();
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signJwt(
  payload: Omit<JwtPayload, "exp"> & { exp?: number },
  secret: string,
  ttlSeconds = 86400,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    sub: payload.sub,
    orgId: payload.orgId,
    role: payload.role,
    exp: payload.exp ?? now + ttlSeconds,
  };
  const headerEnc = b64UrlEncode(JSON.stringify(header));
  const payloadEnc = b64UrlEncode(JSON.stringify(fullPayload));
  const data = `${headerEnc}.${payloadEnc}`;
  const sig = sign(data, secret);
  return `${data}.${sig}`;
}

export class JwtError extends Error {}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError("malformed jwt");
  }
  const [headerEnc, payloadEnc, sig] = parts as [string, string, string];
  const data = `${headerEnc}.${payloadEnc}`;
  const expected = sign(data, secret);
  const a = b64UrlDecodeBytes(sig);
  const b = b64UrlDecodeBytes(expected);
  if (a.length !== b.length) {
    throw new JwtError("bad signature");
  }
  if (!timingSafeEqual(a, b)) {
    throw new JwtError("bad signature");
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64UrlDecode(headerEnc));
    payload = JSON.parse(b64UrlDecode(payloadEnc));
  } catch {
    throw new JwtError("malformed jwt");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    !("alg" in header) ||
    (header as { alg: unknown }).alg !== "HS256"
  ) {
    throw new JwtError("unsupported alg");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { sub?: unknown }).sub !== "string" ||
    typeof (payload as { orgId?: unknown }).orgId !== "string" ||
    typeof (payload as { role?: unknown }).role !== "string" ||
    typeof (payload as { exp?: unknown }).exp !== "number"
  ) {
    throw new JwtError("malformed payload");
  }
  const p = payload as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (p.exp <= now) {
    throw new JwtError("expired");
  }
  if (!ObjectId.isValid(p.sub) || !ObjectId.isValid(p.orgId)) {
    throw new JwtError("bad subject");
  }
  return p;
}

/**
 * Symmetric encryption for secrets at rest (provider API keys).
 * AES-256-GCM. Key = first 32 bytes of SHA-256(JWT_SECRET) so no extra env var.
 * Output format: base64(iv|ciphertext|tag).
 */
function encryptionKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not set");
  return createHash("sha256").update(secret, "utf8").digest().subarray(0, 32) as Buffer;
}

export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = encryptionKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 12) as Buffer;
  const tag = buf.subarray(buf.length - 16) as Buffer;
  const ct = buf.subarray(12, buf.length - 16) as Buffer;
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}