import { test, expect } from "bun:test";
import {
  makeProviderError,
  classifyHttpStatus,
  isFallbackAllowed,
  providerHttpError,
} from "../provider-errors.ts";

test("classifyHttpStatus: 429/5xx eligible; 4xx auth not", () => {
  expect(classifyHttpStatus(429).fallbackEligible).toBe(true);
  expect(classifyHttpStatus(503).fallbackEligible).toBe(true);
  expect(classifyHttpStatus(401).fallbackEligible).toBe(false);
  expect(classifyHttpStatus(400).fallbackEligible).toBe(false);
});

test("isFallbackAllowed: false after stream commit", () => {
  const err = makeProviderError({
    message: "x",
    category: "http_5xx",
    phase: "headers",
    fallbackEligible: true,
  });
  expect(isFallbackAllowed(err, true)).toBe(false);
  expect(isFallbackAllowed(err, false)).toBe(true);
});

test("isFallbackAllowed: body phase with fallbackEligible false never failovers", () => {
  const err = makeProviderError({
    message: "body read failed",
    category: "connection",
    phase: "body",
    fallbackEligible: false,
    maybeAcceptedUpstream: true,
  });
  expect(isFallbackAllowed(err, false)).toBe(false);
  expect(isFallbackAllowed(err, true)).toBe(false);
});

test("isFallbackAllowed: TypeError connect is eligible pre-commit", () => {
  expect(isFallbackAllowed(new TypeError("fetch failed"), false)).toBe(true);
});

test("providerHttpError: 429 is fallback-eligible", () => {
  const e = providerHttpError(429, "rate limit", "request");
  expect(e.fallbackEligible).toBe(true);
  expect(isFallbackAllowed(e, false)).toBe(true);
  expect(isFallbackAllowed(e, true)).toBe(false);
});

test("providerHttpError: 401 is not fallback-eligible", () => {
  const e = providerHttpError(401, "nope", "request");
  expect(isFallbackAllowed(e, false)).toBe(false);
});

test("providerHttpError: public message does not leak body; diagnostic retains it", () => {
  const secretBody = "api_key=sk-live-secret-prompt-leak";
  const e = providerHttpError(500, secretBody, "request", "openai chatComplete");
  expect(e.message).not.toContain("sk-live");
  expect(e.message).not.toContain(secretBody);
  expect(e.message).toMatch(/HTTP 500/);
  expect(e.diagnostic).toContain("sk-live");
});
