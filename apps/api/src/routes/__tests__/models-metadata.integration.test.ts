/**
 * Model metadata shape assertions for create/update payloads.
 */
import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  normalizeEntries,
  genEntryId,
} from "../models.ts";

test("normalizeEntries: assigns ids and priorities", () => {
  const providerId = new ObjectId();
  const entries = normalizeEntries([
    {
      providerId,
      upstreamModelId: "gpt-4o",
    },
    {
      providerId,
      upstreamModelId: "gpt-4o-mini",
      priority: 5,
      active: false,
    },
  ] as never);
  expect(entries).toHaveLength(2);
  expect(entries[0]?.id).toBeTruthy();
  expect(entries[0]?.priority).toBe(0);
  expect(entries[1]?.priority).toBe(5);
  expect(entries[1]?.active).toBe(false);
});

test("genEntryId: 12-char hex", () => {
  const id = genEntryId();
  expect(id).toHaveLength(12);
  expect(/^[0-9a-f]+$/.test(id)).toBe(true);
});
