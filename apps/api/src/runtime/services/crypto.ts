/**
 * Crypto service port (task 3.3).
 * Wraps apps/api/src/lib/crypto.ts capabilities without coupling domains to Node crypto.
 */
import { Context, type Effect as Eff } from "effect";
import type { JwtPayload } from "../../lib/crypto.ts";

export type CryptoService = {
  readonly hashPassword: (plain: string) => Eff.Effect<string>;
  readonly verifyPassword: (
    plain: string,
    hash: string,
  ) => Eff.Effect<boolean>;
  readonly randomToken: (bytes?: number) => Eff.Effect<string>;
  readonly hashToken: (token: string) => Eff.Effect<string>;
  readonly safeHashEqual: (a: string, b: string) => Eff.Effect<boolean>;
  readonly signJwt: (
    payload: Omit<JwtPayload, "exp"> & { exp?: number },
    secret: string,
    ttlSeconds?: number,
  ) => Eff.Effect<string>;
  readonly verifyJwt: (
    token: string,
    secret: string,
  ) => Eff.Effect<JwtPayload, Error>;
  readonly encryptSecret: (plaintext: string) => Eff.Effect<string, Error>;
  readonly decryptSecret: (encoded: string) => Eff.Effect<string, Error>;
  readonly isDuplicateKeyError: (err: unknown) => boolean;
};

export class Crypto extends Context.Tag("tokenpanel/Crypto")<
  Crypto,
  CryptoService
>() {}
