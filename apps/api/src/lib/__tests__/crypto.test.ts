import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  signJwt,
  verifyJwt,
  JwtError,
  randomToken,
  hashToken,
  encryptSecret,
  decryptSecret,
  setJwtSecretForCrypto,
} from "../crypto.ts";

const SECRET = "test-secret-key-for-jwt-and-encryption-1234";

beforeEach(() => {
  setJwtSecretForCrypto(SECRET);
});

afterEach(() => {
  setJwtSecretForCrypto(null);
});

test("signJwt produces 3 dot-separated base64url parts", () => {
  const t = signJwt({ sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "admin" }, SECRET);
  expect(t.split(".")).toHaveLength(3);
});

test("verifyJwt roundtrip returns payload", () => {
  const t = signJwt({ sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "member" }, SECRET);
  const p = verifyJwt(t, SECRET);
  expect(p.sub).toBe("507f1f77bcf86cd799439011");
  expect(p.orgId).toBe("507f1f77bcf86cd799439012");
  expect(p.role).toBe("member");
  expect(p.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("verifyJwt rejects wrong secret (bad signature)", () => {
  const t = signJwt({ sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "admin" }, SECRET);
  expect(() => verifyJwt(t, "wrong-secret")).toThrow(JwtError);
  expect(() => verifyJwt(t, "wrong-secret")).toThrow(/signature/);
});

test("verifyJwt rejects malformed (1, 2, 4 parts)", () => {
  expect(() => verifyJwt("abc", SECRET)).toThrow(/malformed/);
  expect(() => verifyJwt("a.b", SECRET)).toThrow(/malformed/);
  expect(() => verifyJwt("a.b.c.d", SECRET)).toThrow(/malformed/);
});

test("verifyJwt rejects tampered payload (sig mismatch)", () => {
  const t = signJwt({ sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "admin" }, SECRET);
  const [h, , s] = t.split(".") as [string, string, string];
  const tamperedPayload = btoa(JSON.stringify({ sub: "x", orgId: "y", role: "admin", exp: 9999999999 }));
  const tampered = `${h}.${tamperedPayload}.${s}`;
  expect(() => verifyJwt(tampered, SECRET)).toThrow(JwtError);
});

test("verifyJwt rejects unsupported alg", () => {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "admin", exp: 9999999999 }));
  const data = `${header}.${payload}`;
  const sig = btoa("fakesig");
  expect(() => verifyJwt(`${data}.${sig}`, SECRET)).toThrow(/unsupported alg|signature/);
});

test("verifyJwt rejects expired token", () => {
  const t = signJwt(
    { sub: "507f1f77bcf86cd799439011", orgId: "507f1f77bcf86cd799439012", role: "admin", exp: Math.floor(Date.now() / 1000) - 10 },
    SECRET,
    0,
  );
  expect(() => verifyJwt(t, SECRET)).toThrow(/expired/);
});

test("verifyJwt rejects non-ObjectId sub/orgId", () => {
  const t = signJwt({ sub: "not-an-id", orgId: "507f1f77bcf86cd799439012", role: "admin" }, SECRET);
  expect(() => verifyJwt(t, SECRET)).toThrow(/subject/);
  const t2 = signJwt({ sub: "507f1f77bcf86cd799439011", orgId: "not-an-id", role: "admin" }, SECRET);
  expect(() => verifyJwt(t2, SECRET)).toThrow(/subject/);
});

test("verifyJwt rejects malformed payload shape", () => {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ foo: "bar" }));
  const data = `${header}.${payload}`;
  expect(() => verifyJwt(`${data}.${btoa("sig")}`, SECRET)).toThrow(/payload|signature/);
});

test("randomToken returns hex of 2x requested bytes, varies between calls", () => {
  const t1 = randomToken(16);
  const t2 = randomToken(16);
  expect(t1).toHaveLength(32);
  expect(/^[0-9a-f]+$/.test(t1)).toBe(true);
  expect(t1).not.toBe(t2);
  expect(randomToken(8)).toHaveLength(16);
  expect(randomToken(0)).toBe("");
});

test("hashToken is deterministic sha256 hex", () => {
  const h1 = hashToken("tp_live_abc123");
  const h2 = hashToken("tp_live_abc123");
  expect(h1).toBe(h2);
  expect(h1).toHaveLength(64);
  expect(/^[0-9a-f]+$/.test(h1)).toBe(true);
  expect(hashToken("different")).not.toBe(h1);
});

test("encryptSecret + decryptSecret roundtrip", () => {
  const plaintext = "sk-secret-api-key-12345";
  const enc = encryptSecret(plaintext);
  expect(enc).not.toBe(plaintext);
  expect(decryptSecret(enc)).toBe(plaintext);
});

test("encryptSecret produces different ciphertext for same plaintext (random IV)", () => {
  const a = encryptSecret("same");
  const b = encryptSecret("same");
  expect(a).not.toBe(b);
});

test("decryptSecret throws on truncated input", () => {
  expect(() => decryptSecret("short")).toThrow(/too short/);
  expect(() => decryptSecret(btoa("almostlongenoughbutnot")).toString()).toThrow();
});

test("decryptSecret throws on tampered ciphertext (GCM auth failure)", () => {
  const enc = encryptSecret("secret");
  const buf = Buffer.from(enc, "base64");
  const lastIdx = buf.length - 1;
  buf[lastIdx] = (buf[lastIdx] ?? 0) ^ 0x01;
  const tampered = buf.toString("base64");
  expect(() => decryptSecret(tampered)).toThrow();
});

test("encryptSecret/decryptSecret throw when JWT secret unset", () => {
  setJwtSecretForCrypto(null);
  expect(() => encryptSecret("x")).toThrow(/JWT_SECRET/);
  setJwtSecretForCrypto(SECRET);
  const enc = encryptSecret("x");
  setJwtSecretForCrypto(null);
  expect(() => decryptSecret(enc)).toThrow(/JWT_SECRET/);
});