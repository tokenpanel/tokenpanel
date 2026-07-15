import { test, expect } from "bun:test";
import { parseAdminPublicConfig } from "../public.ts";

test("empty VITE_API_BASE_URL → same-origin empty string", () => {
  expect(parseAdminPublicConfig({}).apiBaseUrl).toBe("");
  expect(parseAdminPublicConfig({ VITE_API_BASE_URL: "" }).apiBaseUrl).toBe("");
});

test("normalizes trailing slash", () => {
  expect(
    parseAdminPublicConfig({
      VITE_API_BASE_URL: "https://api.example.com/",
    }).apiBaseUrl,
  ).toBe("https://api.example.com");
  expect(
    parseAdminPublicConfig({
      VITE_API_BASE_URL: "https://api.example.com///",
    }).apiBaseUrl,
  ).toBe("https://api.example.com");
});

test("accepts http(s) bases", () => {
  expect(
    parseAdminPublicConfig({
      VITE_API_BASE_URL: "http://localhost:3000",
    }).apiBaseUrl,
  ).toBe("http://localhost:3000");
});

test("rejects non-http schemes", () => {
  expect(() =>
    parseAdminPublicConfig({ VITE_API_BASE_URL: "ftp://x" }),
  ).toThrow(/VITE_API_BASE_URL/);
  expect(() =>
    parseAdminPublicConfig({ VITE_API_BASE_URL: "not-a-url" }),
  ).toThrow(/VITE_API_BASE_URL/);
});
