/**
 * Org-scoped canary for atomic reservation enforcement (ADR 001).
 *
 * RESERVATION_CANARY_ORG_IDS: comma-separated 24-hex ObjectId strings.
 * Empty / unset → shadow-compare only (legacy enforcement everywhere).
 * Listed org → preFlight holds reservedMinor; settle releases + debits.
 */

import { ObjectId } from "mongodb";
import { getApiRuntimeConfig, isApiRuntimeConfigSet } from "../config/state.ts";

/** Parse canary org list from env-like map. Invalid ids ignored. */
export function parseReservationCanaryOrgIds(
  raw: string | undefined,
): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id.length === 0) continue;
    if (!ObjectId.isValid(id)) continue;
    // Normalize to 24-char hex form used by ObjectId.toHexString().
    out.add(new ObjectId(id).toHexString());
  }
  return out;
}

export function isReservationCanaryOrg(orgId: ObjectId): boolean {
  if (!isApiRuntimeConfigSet()) {
    // Unit tests without full config: never enforce canary.
    return false;
  }
  const set = getApiRuntimeConfig().reservationCanaryOrgIds;
  return set.has(orgId.toHexString());
}
