import { test, expect, describe } from "bun:test";
import {
  resolveClientIp,
  normalizeIp,
  ipMatchesTrusted,
  isValidIp,
  UNKNOWN_CLIENT_IP,
  DEFAULT_TRUSTED_PROXY_CIDRS,
  CLOUDFLARE_IP_CIDRS,
} from "../client-ip.ts";

describe("normalizeIp / isValidIp", () => {
  test("accepts IPv4", () => {
    expect(normalizeIp("203.0.113.10")).toBe("203.0.113.10");
    expect(isValidIp("0.0.0.0")).toBe(true);
  });

  test("rejects bogus IPv4", () => {
    expect(normalizeIp("1.2.3")).toBeNull();
    expect(normalizeIp("1.2.3.256")).toBeNull();
    expect(normalizeIp("01.2.3.4")).toBeNull();
    expect(normalizeIp("not-an-ip")).toBeNull();
  });

  test("expands IPv6 and strips brackets/zone", () => {
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(normalizeIp("[::1]")).toBe(
      "0000:0000:0000:0000:0000:0000:0000:0001",
    );
    expect(normalizeIp("fe80::1%eth0")?.startsWith("fe80:")).toBe(true);
  });
});

describe("ipMatchesTrusted", () => {
  test("exact and CIDR IPv4", () => {
    expect(ipMatchesTrusted("10.0.0.5", ["10.0.0.0/8"])).toBe(true);
    expect(ipMatchesTrusted("11.0.0.5", ["10.0.0.0/8"])).toBe(false);
    expect(ipMatchesTrusted("127.0.0.1", ["127.0.0.1"])).toBe(true);
  });

  test("default private ranges cover docker-style peers", () => {
    expect(ipMatchesTrusted("172.18.0.3", DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(
      true,
    );
    expect(ipMatchesTrusted("192.168.1.1", DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(
      true,
    );
    expect(ipMatchesTrusted("8.8.8.8", DEFAULT_TRUSTED_PROXY_CIDRS)).toBe(
      false,
    );
  });
});

describe("resolveClientIp", () => {
  const headers = (h: Record<string, string>) => ({
    get: (name: string) => h[name.toLowerCase()] ?? null,
  });

  test("without trustProxy: socket only, ignore headers", () => {
    const ip = resolveClientIp({
      peerAddress: "203.0.113.9",
      headers: headers({
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "5.6.7.8",
        "cf-connecting-ip": "9.9.9.9",
      }),
      trustProxy: false,
      trustedProxies: ["0.0.0.0/0"],
      trustCloudflare: true,
    });
    expect(ip).toBe("203.0.113.9");
  });

  test("without trustProxy and no peer → unknown", () => {
    expect(
      resolveClientIp({
        peerAddress: null,
        headers: headers({ "x-forwarded-for": "1.2.3.4" }),
        trustProxy: false,
        trustedProxies: [],
        trustCloudflare: false,
      }),
    ).toBe(UNKNOWN_CLIENT_IP);
  });

  test("trustProxy + trusted peer: X-Real-IP", () => {
    const ip = resolveClientIp({
      peerAddress: "172.18.0.2",
      headers: headers({ "x-real-ip": "198.51.100.20" }),
      trustProxy: true,
      trustedProxies: DEFAULT_TRUSTED_PROXY_CIDRS,
      trustCloudflare: false,
    });
    expect(ip).toBe("198.51.100.20");
  });

  test("trustProxy + trusted peer: X-Forwarded-For leftmost", () => {
    const ip = resolveClientIp({
      peerAddress: "10.0.0.2",
      headers: headers({
        "x-forwarded-for": "198.51.100.30, 10.0.0.2",
      }),
      trustProxy: true,
      trustedProxies: ["10.0.0.0/8"],
      trustCloudflare: false,
    });
    expect(ip).toBe("198.51.100.30");
  });

  test("trustCloudflare + Cloudflare peer: prefers CF-Connecting-IP over XFF", () => {
    // 104.16.0.1 is inside Cloudflare's 104.16.0.0/13 anycast range.
    const ip = resolveClientIp({
      peerAddress: "104.16.0.1",
      headers: headers({
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
      }),
      trustProxy: true,
      trustedProxies: DEFAULT_TRUSTED_PROXY_CIDRS,
      trustCloudflare: true,
    });
    expect(ip).toBe("203.0.113.50");
  });

  test("trustCloudflare + private reverse proxy: ignores spoofed CF-Connecting-IP", () => {
    // Caddy (or any private peer) must not make client-supplied CF-Connecting-IP
    // authoritative — fall through to sanitized X-Real-IP.
    const ip = resolveClientIp({
      peerAddress: "172.18.0.2",
      headers: headers({
        "cf-connecting-ip": "203.0.113.50",
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
      }),
      trustProxy: true,
      trustedProxies: DEFAULT_TRUSTED_PROXY_CIDRS,
      trustCloudflare: true,
    });
    expect(ip).toBe("198.51.100.2");
  });

  test("trustCloudflare + Cloudflare peer works without CF ranges in TRUSTED_PROXIES", () => {
    const ip = resolveClientIp({
      peerAddress: "162.158.0.1",
      headers: headers({ "cf-connecting-ip": "198.51.100.99" }),
      trustProxy: true,
      trustedProxies: [], // private defaults only — CF public IP not listed
      trustCloudflare: true,
    });
    expect(ip).toBe("198.51.100.99");
  });

  test("CLOUDFLARE_IP_CIDRS covers known edge samples", () => {
    expect(ipMatchesTrusted("104.16.0.1", CLOUDFLARE_IP_CIDRS)).toBe(true);
    expect(ipMatchesTrusted("162.158.0.1", CLOUDFLARE_IP_CIDRS)).toBe(true);
    expect(ipMatchesTrusted("172.18.0.2", CLOUDFLARE_IP_CIDRS)).toBe(false);
    expect(ipMatchesTrusted("8.8.8.8", CLOUDFLARE_IP_CIDRS)).toBe(false);
  });

  test("untrusted peer: ignore headers even if trustProxy", () => {
    const ip = resolveClientIp({
      peerAddress: "203.0.113.1",
      headers: headers({ "x-real-ip": "1.2.3.4" }),
      trustProxy: true,
      trustedProxies: ["10.0.0.0/8"],
      trustCloudflare: false,
    });
    expect(ip).toBe("203.0.113.1");
  });

  test("empty trustedProxies uses default private CIDRs", () => {
    const ip = resolveClientIp({
      peerAddress: "192.168.0.5",
      headers: headers({ "x-real-ip": "203.0.113.77" }),
      trustProxy: true,
      trustedProxies: [],
      trustCloudflare: false,
    });
    expect(ip).toBe("203.0.113.77");
  });

  test("trustProxy with no peer (tests): allow header resolution", () => {
    const ip = resolveClientIp({
      peerAddress: null,
      headers: headers({ "x-forwarded-for": "203.0.113.88" }),
      trustProxy: true,
      trustedProxies: DEFAULT_TRUSTED_PROXY_CIDRS,
      trustCloudflare: false,
    });
    expect(ip).toBe("203.0.113.88");
  });
});
