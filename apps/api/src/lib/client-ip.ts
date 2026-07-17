/**
 * Resolve the client IP for throttle / audit use.
 *
 * Default: use the TCP peer (socket) only — never trust client-controlled
 * headers. When `trustProxy` is on and the peer is in `trustedProxies`,
 * prefer Cloudflare / reverse-proxy headers so the real client is used
 * behind Caddy, Cloudflare, nginx, etc.
 *
 * Misconfiguration risk: enabling trustProxy without restricting who can
 * reach the API (or without a tight trustedProxies list) lets attackers
 * spoof X-Forwarded-For and bypass per-IP throttle buckets.
 */
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import {
  getApiRuntimeConfig,
  isApiRuntimeConfigSet,
} from "../config/state.ts";

/** Fallback when peer and trusted headers are unavailable (e.g. unit tests). */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Private + loopback ranges used as the default trusted-proxy set when
 * TRUST_PROXY=true and TRUSTED_PROXIES is unset. Safe only when the API is
 * not exposed on a public interface (Docker internal network + Caddy).
 */
export const DEFAULT_TRUSTED_PROXY_CIDRS: readonly string[] = Object.freeze([
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
]);

export type ClientIpResolveInput = {
  /** TCP peer address from the server socket (Bun requestIP). */
  peerAddress: string | null | undefined;
  headers: { get(name: string): string | null | undefined };
  trustProxy: boolean;
  /** Exact IPs or CIDRs allowed to set forwarded-client headers. */
  trustedProxies: readonly string[];
  /** Prefer CF-Connecting-IP when present and peer is trusted. */
  trustCloudflare: boolean;
};

/** Strip zone id and brackets; lowercase IPv6 hex for stable map keys. */
export function normalizeIp(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0 || s.length > 45) return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1);
  }
  // Remove IPv6 zone index (fe80::1%eth0).
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  if (isIpv4(s)) return s;
  if (isIpv6(s)) return expandIpv6(s);
  return null;
}

export function isValidIp(raw: string): boolean {
  return normalizeIp(raw) !== null;
}

function isIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return false;
    if (!/^\d+$/.test(p)) return false;
    if (p.length > 1 && p.startsWith("0")) return false;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isIpv6(s: string): boolean {
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1] && isIpv4(mapped[1])) return true;
  if (s.includes(".")) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const checkGroup = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);
  if (halves.length === 1) {
    const groups = halves[0]!.split(":");
    return groups.length === 8 && groups.every(checkGroup);
  }
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves[1] === "" ? [] : halves[1]!.split(":");
  if (left.some((g) => g !== "" && !checkGroup(g))) return false;
  if (right.some((g) => g !== "" && !checkGroup(g))) return false;
  if (left.length + right.length > 7) return false;
  return true;
}

/** Expand IPv6 to a fixed 8-hextet lowercase form for comparisons. */
function expandIpv6(s: string): string {
  const lower = s.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1] && isIpv4(mapped[1])) {
    const [a, b, c, d] = mapped[1].split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    return `0000:0000:0000:0000:0000:ffff:${hi.padStart(4, "0")}:${lo.padStart(4, "0")}`;
  }
  const halves = lower.split("::");
  let groups: string[];
  if (halves.length === 1) {
    groups = halves[0]!.split(":");
  } else {
    const left = halves[0] === "" ? [] : halves[0]!.split(":");
    const right = halves[1] === "" ? [] : halves[1]!.split(":");
    const fill = 8 - left.length - right.length;
    groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  }
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** True if `ip` matches an exact address or CIDR in `patterns`. */
export function ipMatchesTrusted(
  ip: string,
  patterns: readonly string[],
): boolean {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    if (pattern.includes("/")) {
      if (matchCidr(norm, pattern)) return true;
    } else {
      const p = normalizeIp(pattern);
      if (p !== null && p === norm) return true;
      // IPv4-mapped compare: peer may be :ffff:x.x.x.x vs pattern x.x.x.x
      if (p !== null && ipv4FromMapped(norm) === p) return true;
      if (p !== null && ipv4FromMapped(p) === norm) return true;
    }
  }
  return false;
}

function ipv4FromMapped(norm: string): string | null {
  if (!norm.includes(":")) return isIpv4(norm) ? norm : null;
  if (!norm.startsWith("0000:0000:0000:0000:0000:ffff:")) return null;
  const parts = norm.split(":");
  const hi = parts[6];
  const lo = parts[7];
  if (!hi || !lo) return null;
  const h = parseInt(hi, 16);
  const l = parseInt(lo, 16);
  if (!Number.isFinite(h) || !Number.isFinite(l)) return null;
  return `${(h >> 8) & 255}.${h & 255}.${(l >> 8) & 255}.${l & 255}`;
}

function matchCidr(normIp: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) return false;
  const baseRaw = cidr.slice(0, slash).trim();
  const bitsRaw = cidr.slice(slash + 1).trim();
  if (!/^\d+$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  const base = normalizeIp(baseRaw);
  if (!base) return false;

  const ipV4 = isIpv4(normIp) ? normIp : ipv4FromMapped(normIp);
  const baseV4 = isIpv4(base) ? base : ipv4FromMapped(base);
  if (ipV4 && baseV4) {
    if (bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4ToInt(ipV4) & mask) === (ipv4ToInt(baseV4) & mask);
  }

  // IPv6 CIDR
  if (normIp.includes(":") && base.includes(":")) {
    if (bits > 128) return false;
    if (bits === 0) return true;
    const ipBytes = ipv6ToBytes(normIp);
    const baseBytes = ipv6ToBytes(base);
    if (!ipBytes || !baseBytes) return false;
    let remaining = bits;
    for (let i = 0; i < 16; i++) {
      if (remaining <= 0) break;
      if (remaining >= 8) {
        if (ipBytes[i] !== baseBytes[i]) return false;
        remaining -= 8;
      } else {
        const mask = (0xff << (8 - remaining)) & 0xff;
        if ((ipBytes[i]! & mask) !== (baseBytes[i]! & mask)) return false;
        remaining = 0;
      }
    }
    return true;
  }
  return false;
}

function ipv6ToBytes(expanded: string): number[] | null {
  const groups = expanded.split(":");
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push((n >> 8) & 0xff, n & 0xff);
  }
  return out;
}

function firstValidForwardedIp(xff: string): string | null {
  // X-Forwarded-For: client, proxy1, proxy2 — leftmost is original client
  // when every hop is trusted (our single reverse-proxy model).
  for (const part of xff.split(",")) {
    const n = normalizeIp(part);
    if (n) return displayIp(n);
  }
  return null;
}

/** Prefer compact IPv4 form for throttle keys when possible. */
function displayIp(norm: string): string {
  if (isIpv4(norm)) return norm;
  const v4 = ipv4FromMapped(norm);
  if (v4) return v4;
  // Compress only for readability: keep expanded form for stability.
  return norm;
}

/**
 * Pure client-IP resolution (unit-testable; no Hono/Bun coupling).
 */
export function resolveClientIp(input: ClientIpResolveInput): string {
  const peerNorm = input.peerAddress
    ? normalizeIp(input.peerAddress)
    : null;
  const peerDisplay = peerNorm ? displayIp(peerNorm) : null;

  if (!input.trustProxy) {
    return peerDisplay ?? UNKNOWN_CLIENT_IP;
  }

  const trustedList =
    input.trustedProxies.length > 0
      ? input.trustedProxies
      : DEFAULT_TRUSTED_PROXY_CIDRS;

  // No peer (app.request in tests): allow headers only when trustProxy is on
  // so middleware tests can inject CF / XFF. Production Bun always has a peer.
  const peerOk =
    peerNorm === null || ipMatchesTrusted(peerNorm, trustedList);
  if (!peerOk) {
    return peerDisplay ?? UNKNOWN_CLIENT_IP;
  }

  if (input.trustCloudflare) {
    const cf = input.headers.get("cf-connecting-ip");
    if (cf) {
      const n = normalizeIp(cf);
      if (n) return displayIp(n);
    }
  }

  const realIp = input.headers.get("x-real-ip");
  if (realIp) {
    const n = normalizeIp(realIp);
    if (n) return displayIp(n);
  }

  const xff = input.headers.get("x-forwarded-for");
  if (xff) {
    const fromXff = firstValidForwardedIp(xff);
    if (fromXff) return fromXff;
  }

  return peerDisplay ?? UNKNOWN_CLIENT_IP;
}

function tryGetPeerAddress(c: Context): string | null {
  try {
    const info = getConnInfo(c);
    const addr = info.remote.address;
    return typeof addr === "string" && addr.length > 0 ? addr : null;
  } catch {
    // app.request() / missing Bun server env — no socket peer.
    return null;
  }
}

/**
 * Client IP for the current Hono request using process runtime config.
 */
export function getRequestClientIp(c: Context): string {
  const peerAddress = tryGetPeerAddress(c);
  if (!isApiRuntimeConfigSet()) {
    return resolveClientIp({
      peerAddress,
      headers: c.req.raw.headers,
      trustProxy: false,
      trustedProxies: [],
      trustCloudflare: false,
    });
  }
  const cfg = getApiRuntimeConfig();
  return resolveClientIp({
    peerAddress,
    headers: c.req.raw.headers,
    trustProxy: cfg.trustProxy,
    trustedProxies: cfg.trustedProxies,
    trustCloudflare: cfg.trustCloudflare,
  });
}
