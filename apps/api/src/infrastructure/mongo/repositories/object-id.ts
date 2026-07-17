import { ObjectId } from "mongodb";
import type { HexId } from "../../../domains/ports/common.ts";

export function toObjectId(hex: HexId): ObjectId {
  return new ObjectId(hex);
}

export function newObjectId(hex?: HexId): ObjectId {
  return hex !== undefined && ObjectId.isValid(hex)
    ? new ObjectId(hex)
    : new ObjectId();
}

export function isHexObjectId(hex: string): boolean {
  return ObjectId.isValid(hex);
}
