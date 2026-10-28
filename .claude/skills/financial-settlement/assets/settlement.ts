// Reference implementation: debts -> net ledger -> fewest direct payments.
// Pure TypeScript, no dependencies. All money is INTEGER MINOR UNITS (cents).
//
// Why exact and not "just greedy": the minimum number of payments equals
//   (people with a non-zero balance) - (max number of disjoint zero-sum groups)
// and finding that maximum is NP-hard. Each zero-sum group of k people needs
// exactly k-1 payments, so more groups means fewer payments. We find the
// optimal grouping with a subset DP for small groups of people (n <= 20 by
// default) and fall back to a fast heuristic above that, reporting honestly
// which one ran via `optimal`.

export interface Debt {
  /** Who owes. */
  from: string;
  /** Who is owed. */
  to: string;
  /** Positive integer, in minor units (cents). */
  amount: number;
  currency?: string;
}

export interface Payment {
  from: string;
  to: string;
  /** Positive integer, in minor units. */
  amount: number;
}

export interface SettlementResult {
  payments: Payment[];
  /** True when `payments` is provably the minimum count; false when the heuristic ran. */
  optimal: boolean;
}

export interface SettleOptions {
  /** Largest number of non-zero people solved exactly. Memory is ~9 bytes * 2^n. Default 20, max 24. */
  exactLimit?: number;
}

// ---------------------------------------------------------------------------
// Input validation and the net ledger
// ---------------------------------------------------------------------------

/** Throws on bad input. A silently skipped debt is a silently wrong balance. */
function assertMinorUnits(amount: unknown, where: string): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError(`${where}: amount must be a positive integer in minor units, got ${String(amount)}`);
  }
}

/**
 * Net balance per person: positive = is owed money, negative = owes money.
 * Names are matched case-insensitively after trimming ("Sam" and "sam " are one
 * person); the first spelling seen is kept for output. Zero balances are kept
 * here so callers can list everyone; settle functions ignore them.
 */
export function buildLedger(debts: readonly Debt[]): Map<string, number> {
  const display = new Map<string, string>(); // folded -> first-seen spelling
  const net = new Map<string, number>(); // folded -> balance
  const key = (raw: string, where: string): string => {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) throw new RangeError(`${where}: name must be a non-empty string`);
    const k = name.toLowerCase();
    if (!display.has(k)) display.set(k, name);
    return k;
  };
  debts.forEach((d, i) => {
    const where = `debts[${i}]`;
    assertMinorUnits(d.amount, where);
    const from = key(d.from, where);
    const to = key(d.to, where);
    if (from === to) throw new RangeError(`${where}: ${d.from} cannot owe themselves`);
    net.set(from, (net.get(from) ?? 0) - d.amount);
    net.set(to, (net.get(to) ?? 0) + d.amount);
  });
  const out = new Map<string, number>();
  for (const [k, v] of net) out.set(display.get(k)!, v);
  return out;
}

// ---------------------------------------------------------------------------
// Settling a ledger
// ---------------------------------------------------------------------------

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Greedy inside ONE group: largest debtor pays largest creditor. Ties by name. */
function greedyPayments(people: { name: string; bal: number }[]): Payment[] {
  const debtors = people.filter((p) => p.bal < 0).map((p) => ({ name: p.name, left: -p.bal }));
  const creditors = people.filter((p) => p.bal > 0).map((p) => ({ name: p.name, left: p.bal }));
  const order = (x: { name: string; left: number }, y: { name: string; left: number }) =>
    y.left - x.left || byName(x.name, y.name);
  const payments: Payment[] = [];
  debtors.sort(order);
  creditors.sort(order);
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    payments.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left === 0) i++;
    if (creditors[j].left === 0) j++;
  }
  return payments;
}

/** Subset DP: partition into the maximum number of zero-sum groups. */
function maxZeroSumGroups(people: { name: string; bal: number }[]): { name: string; bal: number }[][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const sum = new Float64Array(1 << n); // |sum| <= 2^53, safe for integer cents
  const dp = new Int8Array(1 << n);
  for (let mask = 1; mask <= full; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low] + people[31 - Math.clz32(low)].bal;
    let best = 0;
    for (let rest = mask; rest; rest &= rest - 1) {
      const v = dp[mask ^ (rest & -rest)];
      if (v > best) best = v;
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }
  // Walk back to recover one ordering whose zero-sum prefixes are the groups.
  const removed: number[] = [];
  for (let mask = full; mask; ) {
    const z = sum[mask] === 0 ? 1 : 0;
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) && dp[mask ^ (1 << i)] + z === dp[mask]) {
        pick = i;
        break;
      }
    }
    removed.push(pick);
    mask ^= 1 << pick;
  }
  const groups: { name: string; bal: number }[][] = [];
  let current: { name: string; bal: number }[] = [];
  let running = 0;
  for (const idx of removed.reverse()) {
    current.push(people[idx]);
    running += people[idx].bal;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/** Heuristic for large groups: match exact opposites first, then greedy. */
function heuristicPayments(people: { name: string; bal: number }[]): Payment[] {
  const payments: Payment[] = [];
  const creditors = people.filter((p) => p.bal > 0);
  const used = new Set<string>();
  const rest: { name: string; bal: number }[] = [];
  for (const d of people.filter((p) => p.bal < 0)) {
    const match = creditors.find((c) => !used.has(c.name) && c.bal === -d.bal);
    if (match) {
      used.add(match.name);
      payments.push({ from: d.name, to: match.name, amount: match.bal });
    } else rest.push(d);
  }
  rest.push(...creditors.filter((c) => !used.has(c.name)));
  return payments.concat(greedyPayments(rest));
}

const sortPayments = (ps: Payment[]): Payment[] =>
  ps.sort((a, b) => byName(a.from, b.from) || byName(a.to, b.to) || a.amount - b.amount);

/**
 * Fewest payments that bring every balance to zero. Balances are minor units and
 * must sum to zero (money is only moved, never created).
 */
export function settleBalances(
  balances: ReadonlyMap<string, number> | Record<string, number>,
  opts: SettleOptions = {},
): SettlementResult {
  const entries = balances instanceof Map ? [...balances] : Object.entries(balances);
  let total = 0;
  const people: { name: string; bal: number }[] = [];
  for (const [name, bal] of entries) {
    if (!Number.isSafeInteger(bal)) throw new RangeError(`balance for ${name} must be an integer in minor units, got ${bal}`);
    total += bal;
    if (bal !== 0) people.push({ name, bal });
  }
  if (total !== 0) throw new RangeError(`balances must sum to zero, got ${total}`);
  people.sort((a, b) => byName(a.name, b.name));
  if (people.length === 0) return { payments: [], optimal: true };

  const limit = Math.min(opts.exactLimit ?? 20, 24);
  if (people.length > limit) {
    return { payments: sortPayments(heuristicPayments(people)), optimal: false };
  }
  const payments = maxZeroSumGroups(people).flatMap(greedyPayments);
  return { payments: sortPayments(payments), optimal: true };
}

/** Single-currency convenience: debts in, payments out. Throws if currencies are mixed. */
export function settleDebts(debts: readonly Debt[], opts: SettleOptions = {}): SettlementResult {
  const currencies = new Set(debts.map((d) => d.currency ?? ""));
  if (currencies.size > 1) {
    throw new RangeError(`mixed currencies (${[...currencies].join(", ")}); use settleByCurrency`);
  }
  return settleBalances(buildLedger(debts), opts);
}

/** One independent settlement per currency. Never converts between currencies. */
export function settleByCurrency(debts: readonly Debt[], opts: SettleOptions = {}): Record<string, SettlementResult> {
  const groups = new Map<string, Debt[]>();
  for (const d of debts) {
    const c = d.currency ?? "";
    groups.set(c, [...(groups.get(c) ?? []), d]);
  }
  return Object.fromEntries([...groups].map(([c, ds]) => [c, settleDebts(ds, opts)]));
}

// ---------------------------------------------------------------------------
// Adapters and checks
// ---------------------------------------------------------------------------

/**
 * One shared expense -> debts. Everyone in `splitBetween` owes an equal share;
 * the payer's own share is not a debt. The leftover cents of an uneven split go
 * to the first people listed, so the shares always add back to the exact total.
 * `amountMinor` is the total in minor units.
 */
export function expenseToDebts(e: { payer: string; amountMinor: number; splitBetween: string[]; currency?: string }): Debt[] {
  assertMinorUnits(e.amountMinor, "expense");
  const n = e.splitBetween.length;
  if (n === 0) throw new RangeError("expense: splitBetween must not be empty");
  const base = Math.floor(e.amountMinor / n);
  const extra = e.amountMinor - base * n;
  const debts: Debt[] = [];
  e.splitBetween.forEach((name, i) => {
    const share = base + (i < extra ? 1 : 0);
    if (name.trim().toLowerCase() !== e.payer.trim().toLowerCase() && share > 0) {
      debts.push({ from: name, to: e.payer, amount: share, currency: e.currency });
    }
  });
  return debts;
}

/**
 * "15.50" or 15.5 -> 1550, parsed from the decimal text so no float arithmetic
 * happens. Rejects more decimals than the currency has, negatives, and
 * anything that is not a plain number: 0.1 + 0.2 (0.30000000000000004) fails
 * loudly instead of being rounded into a wrong cent.
 */
export function toMinorUnits(input: string | number, exponent = 2): number {
  const text = typeof input === "number" ? String(input) : input.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m || (m[2]?.length ?? 0) > exponent) {
    throw new RangeError(`cannot read "${text}" as an amount with at most ${exponent} decimal places`);
  }
  const minor = Number(m[1]) * 10 ** exponent + Number((m[2] ?? "").padEnd(exponent, "0") || 0);
  if (!Number.isSafeInteger(minor)) throw new RangeError(`amount too large: ${text}`);
  return minor;
}

/** Balances after applying payments. A correct settlement leaves every value 0. */
export function applyPayments(balances: ReadonlyMap<string, number>, payments: readonly Payment[]): Map<string, number> {
  const out = new Map(balances);
  for (const p of payments) {
    out.set(p.from, (out.get(p.from) ?? 0) + p.amount);
    out.set(p.to, (out.get(p.to) ?? 0) - p.amount);
  }
  return out;
}

/** 12345 + "USD" -> "123.45". Display only; never feed the result back into arithmetic. */
export function formatMinor(amountMinor: number, exponent = 2): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  if (exponent === 0) return `${sign}${abs}`;
  const s = String(abs).padStart(exponent + 1, "0");
  return `${sign}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}
