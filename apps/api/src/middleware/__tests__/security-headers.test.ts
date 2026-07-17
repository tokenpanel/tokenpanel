import { describe, expect, test } from "bun:test";
import {
  buildContentSecurityPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  parseCspConnectSrcExtras,
} from "../security-headers.ts";

describe("buildContentSecurityPolicy", () => {
  test("default is same-origin connect-src only", () => {
    expect(DEFAULT_CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(DEFAULT_CONTENT_SECURITY_POLICY).not.toContain("https://api.example.com");
  });

  test("extras append to connect-src without duplicates", () => {
    const csp = buildContentSecurityPolicy([
      "https://api.example.com",
      "https://api.example.com",
      "",
    ]);
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp.match(/https:\/\/api\.example\.com/g)?.length).toBe(1);
  });
});

describe("parseCspConnectSrcExtras", () => {
  test("empty / whitespace → []", () => {
    expect(parseCspConnectSrcExtras(undefined)).toEqual([]);
    expect(parseCspConnectSrcExtras("")).toEqual([]);
    expect(parseCspConnectSrcExtras("  ")).toEqual([]);
  });

  test("comma and whitespace separated", () => {
    expect(
      parseCspConnectSrcExtras("https://a.example.com, https://b.example.com  https://c.example.com"),
    ).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });
});
