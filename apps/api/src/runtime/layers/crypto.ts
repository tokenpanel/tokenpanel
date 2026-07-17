import { Effect, Layer } from "effect";
import {
  hashPassword,
  verifyPassword,
  randomToken,
  hashToken,
  safeHashEqual,
  signJwt,
  verifyJwt,
  encryptSecret,
  decryptSecret,
  isDuplicateKeyError,
  type JwtPayload,
} from "../../lib/crypto.ts";
import { Crypto, type CryptoService } from "../services/crypto.ts";

function makeCryptoService(): CryptoService {
  return {
    hashPassword: (plain) => Effect.promise(() => hashPassword(plain)),
    verifyPassword: (plain, hash) =>
      Effect.promise(() => verifyPassword(plain, hash)),
    randomToken: (bytes) =>
      Effect.sync(() =>
        bytes === undefined ? randomToken() : randomToken(bytes),
      ),
    hashToken: (token) => Effect.sync(() => hashToken(token)),
    safeHashEqual: (a, b) => Effect.sync(() => safeHashEqual(a, b)),
    signJwt: (payload, secret, ttlSeconds) =>
      Effect.sync(() =>
        ttlSeconds === undefined
          ? signJwt(payload, secret)
          : signJwt(payload, secret, ttlSeconds),
      ),
    verifyJwt: (token, secret) =>
      Effect.try({
        try: () => verifyJwt(token, secret),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
    encryptSecret: (plaintext) =>
      Effect.try({
        try: () => encryptSecret(plaintext),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
    decryptSecret: (encoded) =>
      Effect.try({
        try: () => decryptSecret(encoded),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
    isDuplicateKeyError,
  };
}

export const CryptoLive = Layer.succeed(Crypto, makeCryptoService());

/**
 * Optional test crypto — same implementation by default (uses real argon2/JWT).
 * Tests that need pure fakes can Layer.succeed(Crypto, fake).
 */
export const CryptoTest = CryptoLive;

export type { JwtPayload };
