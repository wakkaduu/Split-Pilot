// Run with: npx tsx --test settlement.test.ts   (or: node --test, after compiling)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPayments,
  buildLedger,
  expenseToDebts,
  formatMinor,
  settleBalances,
  settleByCurrency,
  settleDebts,
  toMinorUnits,
  type Debt,
} from "./settlement.ts";

// Small deterministic RNG so failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Random zero-sum balances for n people (some may be 0). */
function randomBalances(n: number, next: () => number): Map<string, number> {
  const m = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const v = Math.round((next() - 0.5) * 2000);
    m.set(`p${String(i).padStart(2, "0")}`, v);
    total += v;
  }
  m.set(`p${String(n - 1).padStart(2, "0")}`, -total);
  return m;
}

/** Independent oracle: n - (max zero-sum groups) found by enumerating set partitions. */
function bruteForceMinPayments(bal: number[]): number {
  const xs = bal.filter((b) => b !== 0);
  let bestGroups = 0;
  function go(i: number, groups: number[]) {
    if (i === xs.length) {
      if (groups.every((g) => g === 0)) bestGroups = Math.max(bestGroups, groups.length);
      return;
    }
    for (let g = 0; g < groups.length; g++) {
      groups[g] += xs[i];
      go(i + 1, groups);
      groups[g] -= xs[i];
    }
    groups.push(xs[i]);
    go(i + 1, groups);
    groups.pop();
  }
  go(0, []);
  return xs.length === 0 ? 0 : xs.length - bestGroups;
}

const settled = (b: Map<string, number>, ps: ReturnType<typeof settleBalances>["payments"]) =>
  [...applyPayments(b, ps).values()].every((v) => v === 0);

test("chain A->B->C collapses to one payment", () => {
  const r = settleDebts([
    { from: "A", to: "B", amount: 1000 },
    { from: "B", to: "C", amount: 1000 },
  ]);
  assert.deepEqual(r.payments, [{ from: "A", to: "C", amount: 1000 }]);
  assert.equal(r.optimal, true);
});

test("a cycle cancels completely", () => {
  const r = settleDebts([
    { from: "A", to: "B", amount: 500 },
    { from: "B", to: "C", amount: 500 },
    { from: "C", to: "A", amount: 500 },
  ]);
  assert.deepEqual(r.payments, []);
});

test("splits into independent groups when that needs fewer payments (greedy would use 4, optimal is 3)", () => {
  // groups: {+6, -3, -3} and {+5, -5}
  const b = new Map([["C1", 600], ["C2", 500], ["D1", -300], ["D2", -300], ["D3", -500]]);
  const r = settleBalances(b);
  assert.equal(r.payments.length, 3);
  assert.ok(settled(b, r.payments));
  assert.equal(r.optimal, true);
});

test("ledger merges names case-insensitively and keeps first spelling", () => {
  const l = buildLedger([
    { from: "sam", to: "Alex", amount: 100 },
    { from: "Sam ", to: "alex", amount: 50 },
  ]);
  assert.deepEqual([...l], [["sam", -150], ["Alex", 150]]);
});

test("rejects floats, zero, negatives, self-debts, empty names", () => {
  const bad: Debt[][] = [
    [{ from: "A", to: "B", amount: 10.5 }],
    [{ from: "A", to: "B", amount: 0 }],
    [{ from: "A", to: "B", amount: -5 }],
    [{ from: "A", to: "a", amount: 5 }],
    [{ from: " ", to: "B", amount: 5 }],
    [{ from: "A", to: "B", amount: Number.NaN }],
  ];
  for (const d of bad) assert.throws(() => buildLedger(d), RangeError);
});

test("balances that do not sum to zero are rejected", () => {
  assert.throws(() => settleBalances({ A: 100, B: -90 }), /sum to zero/);
});

test("mixed currencies are refused by settleDebts and separated by settleByCurrency", () => {
  const debts: Debt[] = [
    { from: "A", to: "B", amount: 1000, currency: "USD" },
    { from: "B", to: "A", amount: 1000, currency: "EUR" },
  ];
  assert.throws(() => settleDebts(debts), /mixed currencies/);
  const r = settleByCurrency(debts);
  assert.deepEqual(r.USD.payments, [{ from: "A", to: "B", amount: 1000 }]);
  assert.deepEqual(r.EUR.payments, [{ from: "B", to: "A", amount: 1000 }]);
});

/** Balances built from several hidden zero-sum groups, so greedy can lose to the optimum. */
function groupedBalances(next: () => number, maxPeople: number): { b: Map<string, number>; hiddenGroups: number } {
  const b = new Map<string, number>();
  let id = 0;
  let hiddenGroups = 0;
  while (b.size < maxPeople - 1) {
    const size = Math.min(2 + Math.floor(next() * 3), maxPeople - b.size);
    if (size < 2) break;
    let total = 0;
    for (let i = 0; i < size - 1; i++) {
      const v = (Math.round(next() * 40) + 1) * 100 * (next() < 0.5 ? -1 : 1);
      b.set(`p${String(id++).padStart(2, "0")}`, v);
      total += v;
    }
    b.set(`p${String(id++).padStart(2, "0")}`, -total);
    hiddenGroups++;
  }
  return { b, hiddenGroups };
}

test("optimal matches brute force on random groups up to 8 people", () => {
  const next = rng(42);
  let multiGroupCases = 0;
  for (let t = 0; t < 200; t++) {
    const { b } = t % 2 === 0 ? groupedBalances(next, 8) : { b: randomBalances(2 + Math.floor(next() * 7), next) };
    const r = settleBalances(b);
    const expected = bruteForceMinPayments([...b.values()]);
    assert.ok(settled(b, r.payments), `not settled, case ${t}`);
    assert.equal(r.payments.length, expected, `not minimal, case ${t}`);
    // The oracle must be able to see savings, otherwise this test proves little.
    const nonzero = [...b.values()].filter((v) => v !== 0).length;
    if (expected < nonzero - 1) multiGroupCases++;
  }
  assert.ok(multiGroupCases >= 20, `only ${multiGroupCases} multi-group cases; test is too weak`);
});

test("heuristic path settles everything and never exceeds n-1 payments", () => {
  const next = rng(7);
  for (const n of [25, 60, 200]) {
    const b = randomBalances(n, next);
    const r = settleBalances(b);
    assert.equal(r.optimal, false);
    assert.ok(settled(b, r.payments));
    const nonzero = [...b.values()].filter((v) => v !== 0).length;
    assert.ok(r.payments.length <= nonzero - 1);
  }
});

test("exactLimit: 0 forces the heuristic, which still settles correctly", () => {
  const b = new Map([["C1", 600], ["C2", 500], ["D1", -300], ["D2", -300], ["D3", -500]]);
  const r = settleBalances(b, { exactLimit: 0 });
  assert.equal(r.optimal, false);
  assert.ok(settled(b, r.payments));
});

test("20 people solve exactly in reasonable time", () => {
  const b = randomBalances(20, rng(99));
  const t0 = Date.now();
  const r = settleBalances(b);
  assert.equal(r.optimal, true);
  assert.ok(settled(b, r.payments));
  assert.ok(Date.now() - t0 < 5000, "exact solve too slow");
});

test("output does not depend on input order", () => {
  const debts: Debt[] = [
    { from: "Dev", to: "Maya", amount: 1250 },
    { from: "Lee", to: "Maya", amount: 840 },
    { from: "Maya", to: "Sam", amount: 300 },
    { from: "Sam", to: "Dev", amount: 90 },
  ];
  const expected = settleDebts(debts).payments;
  const next = rng(3);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...debts].sort(() => next() - 0.5);
    assert.deepEqual(settleDebts(shuffled).payments, expected);
  }
});

test("every payment is a positive integer between different people", () => {
  const next = rng(11);
  for (let t = 0; t < 50; t++) {
    const r = settleBalances(randomBalances(2 + Math.floor(next() * 12), next));
    for (const p of r.payments) {
      assert.ok(Number.isSafeInteger(p.amount) && p.amount > 0);
      assert.notEqual(p.from, p.to);
    }
  }
});

test("expenseToDebts: 100.00 over 3 people hands out the spare cent, shares add up", () => {
  const debts = expenseToDebts({ payer: "Alex", amountMinor: 10000, splitBetween: ["Alex", "Sam", "Lee"] });
  // Alex is first, so Alex gets the extra cent (3334) and it is not a debt.
  assert.deepEqual(debts.map((d) => [d.from, d.amount]), [["Sam", 3333], ["Lee", 3333]]);
  const withoutPayer = expenseToDebts({ payer: "Alex", amountMinor: 10000, splitBetween: ["Sam", "Lee", "Priya"] });
  assert.equal(withoutPayer.reduce((s, d) => s + d.amount, 0), 10000);
});

test("end to end: dinner and taxis between three friends", () => {
  const debts = [
    ...expenseToDebts({ payer: "Alex", amountMinor: 8400, splitBetween: ["Alex", "Sam", "Lee"] }),
    ...expenseToDebts({ payer: "Sam", amountMinor: 2340, splitBetween: ["Alex", "Sam"] }),
  ];
  const ledger = buildLedger(debts);
  const r = settleBalances(ledger);
  assert.ok(settled(ledger, r.payments));
  assert.ok(r.payments.length <= 2);
});

test("formatMinor", () => {
  assert.equal(formatMinor(12345), "123.45");
  assert.equal(formatMinor(5), "0.05");
  assert.equal(formatMinor(-5), "-0.05");
  assert.equal(formatMinor(1200, 0), "1200");
});

test("toMinorUnits parses decimal text exactly and refuses what it cannot represent", () => {
  assert.equal(toMinorUnits("15.50"), 1550);
  assert.equal(toMinorUnits(15.5), 1550);
  assert.equal(toMinorUnits("0.3"), 30);
  assert.equal(toMinorUnits("100"), 10000);
  assert.equal(toMinorUnits("1200", 0), 1200);
  assert.equal(toMinorUnits("1.234", 3), 1234);
  for (const bad of ["1.234", "-5", "abc", "", "1,000.00", 0.1 + 0.2, Number.NaN]) {
    assert.throws(() => toMinorUnits(bad as string | number), RangeError, String(bad));
  }
});
