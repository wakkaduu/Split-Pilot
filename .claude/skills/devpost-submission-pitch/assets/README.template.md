<!--
  Living README. Update it in the same change as the feature it describes.
  Rules: describe only what works today (move the rest to Roadmap), copy commands and
  env var names from the repo instead of retyping them, and never paste a real secret.
  Check with: python3 .claude/skills/devpost-submission-pitch/scripts/readme_check.py
-->

# <ProductName>

> <One-sentence pitch: who it is for, what it does, why it is better. Under 160 characters, no buzzwords.>

[Demo video](<youtube-url>) · [Try it](<hosted-url-or-#sandbox-setup>) · [License](LICENSE)

![Screenshot of the settle-up screen](docs/screenshot.png)

## Problem

<Two to four sentences. A concrete scene ("four friends, one cabin, eleven chat messages") then the cost: time, mistakes, awkwardness, fees. Say who has this problem and how often.>

## Solution

<Two to four sentences: what the user does and what they get. Then the flow in one line:>

**Paste a chat or receipt → AI extracts the expenses → exact split and fewest-payments settlement → pay with PayPal.**

### What works today

| Capability | Status |
|---|---|
| Parse pasted chat / receipt text into expenses (payer, amount, currency, description, who shares) | <Working / Partial> |
| Ask a question when the text is ambiguous instead of guessing | <Working / Partial> |
| Net balances in exact cents and minimal payment list | <Working / Partial> |
| Create a PayPal sandbox order and send the payer to approve | <Working / Partial> |
| Capture, verify the amount, mark settled | <Working / Partial> |

### Roadmap

- <Things that do not work yet. Keeping them here keeps the table above honest.>

## How it works

```
chat / receipt text
      │  AI extraction (<model>) + schema validation, retry, clarification fallback
      ▼
expenses ──► net ledger (integer cents) ──► fewest-payments solver
      │
      ▼
POST /api/paypal/orders ──► PayPal Orders v2 (sandbox) ──► approval link ──► buyer approves
      │
      ▼
/api/paypal/return ──► capture + amount check ──► settlement marked paid
```

## Tech stack

| Layer | Technology | How it is used |
|---|---|---|
| AI | <Model / service, e.g. Claude via the Anthropic API> | <Turns unstructured text into validated expense JSON; asks for clarification when unsure> |
| Payments | PayPal REST API, Orders v2 (**sandbox**) | <Create order, approval redirect, capture> |
| Backend | <Node.js, Express, TypeScript, Zod> | <Routes, validation, idempotent PayPal client> |
| Frontend | <React, Vite, Tailwind CSS> | <Mobile-first settle-up screens> |
| Tests | <Vitest / node:test> | <What is covered> |

## Sandbox setup

You need Node.js <version> and a free PayPal developer account. Nothing here touches real money.

1. **Get sandbox credentials.** In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), open *Apps & Credentials*, switch to **Sandbox**, create an app, and copy its Client ID and Secret.
2. **Create test accounts.** Under *Testing tools → Sandbox accounts* you will have a business account (the merchant) and a personal account (the buyer). Note the buyer's email and password; you use them to approve payments.
3. **Install and configure.**
   ```bash
   git clone <repo-url> && cd <repo>
   npm install
   cp .env.example .env
   ```
   Fill in `.env` (see the table below). Never commit `.env`.
4. **Run.**
   ```bash
   npm run dev
   ```
   Open <http://localhost:5173>.
5. **Try it.** Paste this into the box:
   ```
   <A short sample chat that exercises the flow, with one ambiguous line>
   ```
   Expected: <what the user should see, e.g. "3 expenses, 1 question, 3 payments">. Click **Pay with PayPal** and log in with the sandbox buyer account to approve.

### Environment variables

| Variable | What it is |
|---|---|
| `PAYPAL_CLIENT_ID` | Sandbox app Client ID |
| `PAYPAL_CLIENT_SECRET` | Sandbox app Secret (server only, never exposed to the browser) |
| `PAYPAL_ENV` | `sandbox` |
| `<AI_API_KEY_NAME>` | <Key for the AI service> |

### Tests

```bash
npm test
```

<One line on what the tests cover, e.g. "settlement solver checked against a brute-force oracle; PayPal client checked against a fake PayPal for retries, token refresh and idempotency".>

## Project structure

```
<short tree of the 5-8 directories a judge needs to find>
```

## Team

<Names / handles>

## License

<MIT>. See [LICENSE](LICENSE).
