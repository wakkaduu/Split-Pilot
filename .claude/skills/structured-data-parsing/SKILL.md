---
name: structured-data-parsing
description: Turns unstructured text, chat messages, or receipt data about a shared expense into a reliable typed record {payer, amount, currency, description, splitBetween[]}. Produces TypeScript interfaces, Zod validation schemas, LLM extraction prompts, and the validate/repair/fallback code that makes the output always valid, with explicit handling for ambiguous phrasing ("split with Sam", "we", "$20", "everyone"). Use this skill whenever the user pastes or describes receipt text, a bill, a "who paid what" message, an expense-splitting or IOU request, or asks for a Zod schema, JSON extraction prompt, or structured-output pipeline for expenses or payments, even if they never say "schema" or "parse". Also use it when building the AI-extraction step of a split-payment or invoicing feature.
---

# Structured data parsing for shared expenses

The goal is a record the rest of the app can trust. Free text such as "I covered dinner, 84.50, split with Sam and Lee" has to become:

```ts
{ payer: "Alex", amount: 84.5, currency: "USD", description: "Dinner", splitBetween: ["Alex", "Sam", "Lee"] }
```

with no human cleanup, and without ever crashing a downstream payment call on a malformed value.

## Be straight about "100% valid JSON"

A prompt alone cannot guarantee valid output; models occasionally add prose, drop a key, or return `"12.50"` for a number. What you can guarantee is that **the caller always receives something that passes the schema**. That takes layers, and the deliverable should include all of them, because dropping any one makes the claim false:

1. **Constrain generation.** Give the provider the JSON Schema through its structured-output mode (for Anthropic, `output_config.format`; in TypeScript `zodOutputFormat(schema)`), so malformed JSON is rare to begin with. Prefer this over a forced tool call: forced `tool_choice` returns a 400 on the newest Claude models. Check the current provider docs for what schema features are supported; keep exotic constraints (regex, cross-field rules) in Zod and re-validate the reply yourself, since the provider only enforces the JSON Schema part.
2. **Validate and normalize.** Parse leniently (strip code fences), apply deterministic cleanup (`"I"` becomes the current user, currency upper-cased, duplicate names removed), then `safeParse`.
3. **Repair once.** On failure, send the model its own output plus the Zod error text and ask for a corrected object.
4. **Fall back to a typed result.** If repair fails, return `needs_clarification`, never throw and never return a half-filled record. Provider errors (auth, network) are different and should propagate.

Ambiguity gets the same treatment. When the text really doesn't say who paid or who shares, a guessed value is valid JSON and wrong data, which is worse than a question. So the contract is a small envelope with three outcomes (`ok`, `needs_clarification`, `no_expense_found`), and the five required fields live inside `ok`.

## What to deliver

Start from [assets/expense-extraction.ts](assets/expense-extraction.ts). It is tested (Zod v4, strict TypeScript) and contains every piece below, so copy and adapt it instead of rewriting. Present these, trimmed to what the user asked for:

1. **TypeScript interfaces and Zod schemas.** `ExpenseSchema`, `PartialExpenseSchema`, `ExtractionResultSchema`, `ExtractionContext`, with the types inferred from the schemas so they cannot drift apart.
2. **The extraction prompt.** `buildSystemPrompt(ctx)` plus `buildUserPrompt(text)`. Note the two things that make it work: known context (current user, roster, default currency) goes in the prompt so "I" and "everyone" resolve, and the expense text is wrapped in tags and declared to be data, so a receipt that says "ignore previous instructions" does nothing.
3. **The pipeline.** `extractExpense(text, callModel, ctx)` with the repair retry and fallback. `callModel` is a thin adapter for whichever provider the project uses; write that adapter for them (for Anthropic, see the claude-api skill) rather than leaving it abstract.
4. **Money helpers** when the amount will be used in arithmetic: `toMinorUnits` and `splitEvenly`. The contract keeps `amount` as a plain number in major units because that is what was asked for, but never divide floats: convert to integer cents first and hand out the leftover cent deterministically.

If the user gave sample text, also show what the extractor should return for it, with the `assumptions` or `questions` that fall out. That makes the ambiguity decisions visible and checkable.

## Ambiguity: decide by rule, not by vibe

The full phrase-by-phrase table is in [references/ambiguity-rules.md](references/ambiguity-rules.md). Read it before writing the prompt or judging a sample. The principles behind it:

- **Resolve with context first** (current user, roster, default currency), **then with the safest conventional reading**, and record the choice in `assumptions`.
- **Ask when the two readings produce different money.** "Split with Sam" is two people, not one; "split 3 ways" with no names can't be resolved; "$" with no default currency changes the amount owed in practice. Those are `needs_clarification`.
- **Never invent a value** to avoid asking. A null in `partial` plus a specific question beats a plausible fabrication.
- **Say what the schema can't hold.** Unequal splits ("I had the salad") don't fit `splitBetween: string[]`. Return `needs_clarification` explaining that, and offer the extension (`shares: {name, amount}[]`) if the user wants it, instead of silently flattening to an even split.

## Conventions to state explicitly

These are the places where two reasonable engineers would disagree, so say which one the schema uses:

- `splitBetween` **includes the payer** when the payer shares the cost, and excludes them when others owe the full amount.
- `amount` is the **total paid** (tax and tip included), in major units, positive.
- `currency` is ISO 4217 upper case; decimal places are checked against the currency (JPY allows none).
- Names are canonicalized to the roster spelling and appear once.

## Testing what you deliver

Include a short list of adversarial inputs alongside the schema, since that is where extraction breaks: `$20` with and without a default currency, `1.234,56 €`, `5k`, a receipt with subtotal/tax/tip/total, "me and Priya", "everyone" with and without a roster, "split 3 ways", an unequal split, two expenses in one message, a message with no expense, and a prompt-injection line inside the receipt. Offer to write them as table-driven tests that stub `callModel`, as the template's tests do for the validation, repair, and fallback paths.

If the text contains several expenses, wrap the result in an array (`z.array(ExtractionResultSchema)`) and extract each separately, so one unclear line doesn't block the others.
