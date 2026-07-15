import { ObjectId } from "mongodb";

/**
 * Shared pure route helpers. Call sites keep their own status codes and
 * error envelopes (400 vs 404 remain route-specific).
 */

/** Parse a path/query ObjectId string; null when invalid. */
export function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

/** Escape a string for safe inclusion in a RegExp source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
