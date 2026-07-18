import { test, expect } from "bun:test";
import { redactCustomerBalance } from "../operations.ts";

type Balance = { amountUnits: number; reservedUnits: number; currency: string };
type CustomerLike = {
  _id: string;
  name: string;
  email: string;
  status: string;
  balance: Balance;
};

function customer(over: Partial<CustomerLike> = {}): CustomerLike {
  return {
    _id: "x",
    name: "Bob",
    email: "bob@example.com",
    status: "active",
    balance: { amountUnits: 1000, reservedUnits: 0, currency: "USD" },
    ...over,
  };
}

test("redactCustomerBalance: strips balance", () => {
  const c = customer();
  const result = redactCustomerBalance(c);
  expect(result).not.toHaveProperty("balance");
});

test("redactCustomerBalance: does not mutate input", () => {
  const c = customer({ balance: { amountUnits: 2500, reservedUnits: 10, currency: "USD" } });
  const snapshot = { ...c, balance: { ...c.balance } };
  redactCustomerBalance(c);
  expect(c).toEqual(snapshot);
});

test("redactCustomerBalance: preserves all non-balance fields after redaction", () => {
  const c = customer({ _id: "abc", name: "Alice", email: "alice@example.com", status: "active" });
  const result = redactCustomerBalance(c);
  expect(result._id).toBe("abc");
  expect(result.name).toBe("Alice");
  expect(result.email).toBe("alice@example.com");
  expect(result.status).toBe("active");
});

test("redactCustomerBalance: works on array element via map (redacts each)", () => {
  const customers = [
    customer({ _id: "a", name: "A" }),
    customer({ _id: "b", name: "B" }),
  ];
  const results = customers.map((c) => redactCustomerBalance(c));
  expect(results).toHaveLength(2);
  for (const r of results) {
    expect(r).not.toHaveProperty("balance");
  }
  expect(results[0]!._id).toBe("a");
  expect(results[1]!._id).toBe("b");
});

test("redactCustomerBalance: handles input without balance field (no-op)", () => {
  const input = {
    _id: "y",
    name: "X",
  } as unknown as { _id: string; name: string; balance: unknown };
  const result = redactCustomerBalance(input);
  expect(result._id).toBe("y");
  expect(result.name).toBe("X");
  expect(result).not.toHaveProperty("balance");
});
