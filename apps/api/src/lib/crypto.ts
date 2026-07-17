import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { ObjectId } from "mongodb";
import type { UserRole } from "@tokenpanel/db";
import {
  ENCRYPT_AUTH_TAG_BYTES,
  ENCRYPT_IV_BYTES,
  ENCRYPT_KEY_BYTES,
  JWT_ALG,
  JWT_DEFAULT_TTL_SECONDS,
  JWT_TYP,
} from "../config/security-policy.ts";
import {
  getApiRuntimeConfig,
  isApiRuntimeConfigSet,
} from "../config/state.ts";

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

/**
 * Detect a MongoDB duplicate-key error (code 11000). Used by key-creation
 * retry loops that regenerate a random prefix when the (unique) prefix index
 * collides — vanishingly rare with a 16-char hex prefix (16^8 ≈ 4.3B combos)
 * but handled defensively so a collision surfaces as a regenerated key rather
 * than a 500 to the operator.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Mongo driver: MongoServerError with .code === 11000. The code is stable
  // across driver versions; the name check is a defensive belt-and-braces.
  const code = (err as { code?: unknown }).code;
  return code === 11000 || err.name === "MongoServerError" && /E11000/.test(err.message);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two equal-length strings (e.g. sha256 hex key
 * hashes). Length mismatch returns false without comparing bytes (an attacker
 * cannot use timing to recover the hash: hashToken always emits a 64-char hex
 * digest, so legitimate comparisons are always equal-length). Used for public
 * API-key verification so a normal `===` doesn't short-circuit on the first
 * differing byte and leak how many leading bytes matched.
 */
export function safeHashEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface JwtPayload {
  sub: string;
  orgId: string;
  role: UserRole;
  /** Admin session id (ObjectId hex) — must exist in admin_sessions. */
  sid: string;
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
  ttlSeconds = JWT_DEFAULT_TTL_SECONDS,
): string {
  const header = { alg: JWT_ALG, typ: JWT_TYP };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    sub: payload.sub,
    orgId: payload.orgId,
    role: payload.role,
    sid: payload.sid,
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
    (header as { alg: unknown }).alg !== JWT_ALG
  ) {
    throw new JwtError("unsupported alg");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { sub?: unknown }).sub !== "string" ||
    typeof (payload as { orgId?: unknown }).orgId !== "string" ||
    typeof (payload as { role?: unknown }).role !== "string" ||
    typeof (payload as { sid?: unknown }).sid !== "string" ||
    typeof (payload as { exp?: unknown }).exp !== "number"
  ) {
    throw new JwtError("malformed payload");
  }
  const p = payload as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (p.exp <= now) {
    throw new JwtError("expired");
  }
  if (
    !ObjectId.isValid(p.sub) ||
    !ObjectId.isValid(p.orgId) ||
    !ObjectId.isValid(p.sid)
  ) {
    throw new JwtError("bad subject");
  }
  return p;
}

/**
 * Symmetric encryption for secrets at rest (provider API keys).
 * AES-256-GCM. Key = first 32 bytes of SHA-256(JWT_SECRET) so no extra env var.
 * Output format: base64(iv|ciphertext|tag).
 *
 * Secret source (in order):
 * 1. Explicit override via setJwtSecretForCrypto (tests / boot pin)
 * 2. API runtime config set at boot (production path)
 * No process.env fallback (task 14.1).
 * Never logs the secret. Exact bytes are preserved (no trim).
 */
let jwtSecretOverride: string | null = null;

/** Test/boot helper: pin the exact JWT secret used for encrypt/decrypt. */
export function setJwtSecretForCrypto(secret: string | null): void {
  jwtSecretOverride = secret;
}

function resolveJwtSecret(): string {
  if (jwtSecretOverride !== null) return jwtSecretOverride;
  if (isApiRuntimeConfigSet()) return getApiRuntimeConfig().jwtSecret;
  throw new Error("JWT_SECRET not set");
}

function encryptionKey(): Buffer {
  const secret = resolveJwtSecret();
  return createHash("sha256")
    .update(secret, "utf8")
    .digest()
    .subarray(0, ENCRYPT_KEY_BYTES) as Buffer;
}

export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(ENCRYPT_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = encryptionKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < ENCRYPT_IV_BYTES + ENCRYPT_AUTH_TAG_BYTES) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, ENCRYPT_IV_BYTES) as Buffer;
  const tag = buf.subarray(buf.length - ENCRYPT_AUTH_TAG_BYTES) as Buffer;
  const ct = buf.subarray(
    ENCRYPT_IV_BYTES,
    buf.length - ENCRYPT_AUTH_TAG_BYTES,
  ) as Buffer;
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}