import { test, expect } from "bun:test";
import { fromPath } from "../LoginPage.tsx";

test("fromPath: missing state → '/'", () => {
  expect(fromPath(undefined)).toBe("/");
  expect(fromPath(null)).toBe("/");
});

test("fromPath: state without from → '/'", () => {
  expect(fromPath({})).toBe("/");
  expect(fromPath({ other: "x" })).toBe("/");
});

test("fromPath: state with from.pathname → that path", () => {
  expect(fromPath({ from: { pathname: "/customers" } })).toBe("/customers");
  expect(fromPath({ from: { pathname: "/settings" } })).toBe("/settings");
});

test("fromPath: state with from but no pathname → '/'", () => {
  expect(fromPath({ from: {} })).toBe("/");
});