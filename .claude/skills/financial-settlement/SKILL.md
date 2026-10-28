---
name: financial-settlement
description: Writes tested JavaScript/TypeScript utilities that turn a list of debts or shared expenses into a net-balance ledger and the smallest possible list of direct payments (who pays whom, exact amounts) that clears every balance. Covers integer-cents money handling, optimal debt simplification (exact for small groups, heuristic fallback for big ones), multi-currency separation, rounding of uneven splits, and property-based tests. Use this skill whenever the user asks to settle up a group, simplify debts, minimize transactions, compute who owes whom, build a Splitwise-style balance or payout calculator, batch payouts from group balances, or asks for a "settle" or "net balance" function, even if they never say "algorithm". Also use it when reviewing existing settlement code for float bugs or non-minimal output.
---

# Financial settlement

Given "Alex owes Sam $25, Sam owes Lee $25, Lee owes Alex $10...", produce the fewest payments that leave everyone at zero, with amounts that are exactly right to the cent. People will move real money based on this output, so correctness comes before cleverness: a settlement that is one cent off, or that quietly drops a debt, is worse than no settlement.

Start from [assets/settlement.ts](assets/settlement.ts) and [assets/settlement.test.ts](assets/settlement.test.ts). They are tested together (16 tests, strict TypeScript, zero dependencies). Copy and adapt them instead of writing the algorithm again, then run the tests in the user's project.

## The pipeline

1. **Normalize to integer minor units at the edge.** Parse "12.50" to 1250 once, on the way in, and format on the way out. Floats make `0.1 + 0.2 !== 0.3`, and a ledger that is off by a fraction of a cent will not sum to zero. Everything inside is a safe integer; anything else is rejected with a clear error rather than rounded.
2. **Build the net ledger.** For each debt, subtract from the debtor and add to the creditor. Positive means "is owed", negative means "owes". Match names case-insensitively after trimming, because "sam" and "Sam " as two people is the most common real-world bug. The balances of a complete ledger always sum to zero; if they don't, throw.
3. **Settle each currency separately.** Never net USD against EUR without an explicit rate and a decision about who bears conversion. `settleByCurrency` keeps them apart.
4. **Find the fewest payments.** See below.
5. **Verify before returning.** Applying the payments to the ledger must leave every balance at exactly zero. Cheap to check, and it catches whole classes of bugs.

## "Fewest transactions" is a hard problem; be honest about it

The obvious algorithm (repeatedly let the biggest debtor pay the biggest creditor) is fast and always works, but it is not always minimal. It never needs more than n-1 payments for n people with non-zero balances, yet if the group secretly contains independent sub-groups that net to zero among themselves, settling each sub-group separately saves a payment for every extra group:

> payments = (people with non-zero balance) - (maximum number of disjoint zero-sum groups)

Finding that maximum is NP-hard. So the template does two things, and says which one ran in `optimal`:

- **Up to ~20 people with a non-zero balance:** subset DP finds the best grouping exactly (about 20 million steps, tens of milliseconds), then settles each group greedily, which is exactly `k-1` payments for a group of `k` that cannot be split further.
- **Above that:** match exact opposite balances first (one payment clears two people), then greedy. At most n-1 payments, usually near-optimal, flagged `optimal: false`.

Tell the user this plainly. Claiming "provably fewest" for a heuristic would be false; calling a 15-person exact solve "approximate" would undersell it. Real friend groups and trips are almost always under 20 people.

## Choices the user may care about

State these rather than hiding them, because they change who pays whom:

- **Simplified payments can route money between people who never transacted** (A pays C because B was in the middle). That is mathematically fine and usually what people want, but some products prefer to keep the original debt pairs. Offer a "net each pair only" mode if they say that matters.
- **Uneven splits:** 100.00 among 3 is 3334 + 3333 + 3333. The leftover cents go to the first people listed, so the shares always add back to the exact total. Say who gets the extra cent.
- **The payer's own share is not a debt.** `expenseToDebts` leaves the payer out of the debtors even when they are in `splitBetween`.
- **Determinism:** sort names and break ties by name so the same input always gives the same payments. Otherwise the UI flickers between refreshes and tests become flaky.
- **Fewer payments also means fewer fees and fewer failure points** if these become real payouts (for example a PayPal batch payout), which is the reason to bother minimizing at all.

## Tests worth having (and the trap in writing them)

The template's tests check the properties that must hold for any input, not just hand-picked cases:

- conservation: after applying the payments every balance is exactly 0
- every payment is a positive integer between two different people
- never more than n-1 payments; and equal to an **independent brute-force oracle** for small random groups
- input order does not change the output
- bad input (floats, zero, negatives, self-debts, empty names, mixed currencies, non-zero-sum balances) throws

One trap: random zero-sum balances almost never contain hidden sub-groups, so a plain greedy implementation passes a naive random test. The template builds inputs from several hidden zero-sum groups and asserts that the oracle sees real savings in enough cases. Keep that guard; as a sanity check, temporarily force the heuristic (`exactLimit: 0`) and confirm tests fail.

When asked for the result on specific numbers, compute it with the code (or by hand with the grouping reasoning) and show the net balances, the groups, and the payments, so the user can check the arithmetic.

## Connecting to the rest of the app

If expenses arrive as `{payer, amount, currency, splitBetween[]}` (see the structured-data-parsing skill), convert `amount` to minor units with `toMinorUnits`, then `expenseToDebts`, then `settleByCurrency`. Keep names in the same canonical spelling end to end; the ledger folds case, but it cannot guess that "Sammy" is "Samuel".
