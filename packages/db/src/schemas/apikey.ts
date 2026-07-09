import { z } from "zod";
import { objectId, objectIdFromString, timestampFields } from "./common.ts";

/**
 * ApiKey = a credential issued to a Customer for accessing the public /v1/*
 * proxy endpoints. The raw key is shown once on creation; only its hash is
 * stored. Keys are prefixed (e.g. "tp_live_...") for identification.
 */
export const apiKeyDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  customerId: objectId,
  /** Display label. */
  name: z.string().min(1).max(120),
  /** Key prefix used for lookup (first 16 chars, non-secret). */
  prefix: z.string().min(8).max(20),
  /** Hash of the full key (argon2/scrypt). Never returned. */
  keyHash: z.string().min(1),
  /** Optional model alias whitelist; empty = all org models. */
  modelWhitelist: z.array(z.string().min(1).max(80)).default(() => []),
  status: z.enum(["active", "revoked"]).default("active"),
  /** Last time this key was used. */
  lastUsedAt: z.instanceof(Date).nullish(),
  ...timestampFields,
});

export const apiKeyCreateInput = z.object({
  customerId: objectIdFromString,
  name: z.string().min(1).max(120),
  modelWhitelist: z.array(z.string().min(1).max(80)).optional(),
});

export const apiKeyUpdateInput = z.object({
  name: z.string().min(1).max(120).optional(),
  modelWhitelist: z.array(z.string().min(1).max(80)).optional(),
  status: z.enum(["active", "revoked"]).optional(),
});

export type ApiKeyDoc = z.infer<typeof apiKeyDoc>;
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateInput>;
export type ApiKeyUpdateInput = z.infer<typeof apiKeyUpdateInput>;