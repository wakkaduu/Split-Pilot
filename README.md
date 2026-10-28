# SplitPilot

> Paste a trip chat or a receipt; AI turns it into expenses, the app finds the fewest payments that settle the group, and everyone pays through PayPal.

## Problem

Four friends, one cabin, eleven chat messages and three receipt photos, and nobody is sure who owes what. Splitting by hand means arithmetic mistakes, awkward reminders, and a pile of separate payments.

## Solution

SplitPilot reads the messy text for you, asks when it is unsure, works out each person's exact balance, collapses the debts into the fewest possible payments, and lets each person settle through PayPal checkout.

**Paste chat or receipt → AI extracts expenses → exact split and fewest-payments settlement → pay with PayPal.**

### Status

This repository is at the **scaffold** stage. Nothing below the line works yet; this table is updated with each feature.

| Capability | Status |
|---|---|
| Server and client start, health check shows which keys are configured | Working |
| AI provider adapter: Claude with schema-constrained output, optional receipt images | Built and unit-tested with a fake client; not yet run against the live API or wired to a route |
| Parse chat / receipt text into expenses | Not started |
| Net balances and fewest-payments settlement | Not started |
| PayPal client: tokens, orders, capture, payouts, retries | Built and unit-tested against a fake PayPal; not yet run against the sandbox or wired to a route |
| Settlement money flow (who actually receives the money) | Experiment pending, see [decision 0001](docs/decisions/0001-settlement-money-flow.md) |
| Mobile-first fintech UI | Not started |

## Tech stack

| Layer | Technology | How it is used |
|---|---|---|
| AI | Claude via the Anthropic API (`@anthropic-ai/sdk`), default model `claude-opus-5-5`, overridable with `AI_MODEL` | Turns chat/receipt text and receipt photos into validated expense data using schema-constrained output; asks for clarification when unsure |
| Payments | PayPal REST API, Orders v2, **sandbox only** | Create order, approval redirect, capture (via a small fetch-based client; the deprecated `@paypal/checkout-server-sdk` is not used) |
| Backend | Node.js 22+, Express 5, TypeScript, Zod | Routes, validation |
| Database | SQLite through Prisma 7 | Groups, expenses, shares, payments; money stored as integer cents |
| Frontend | React 19, Vite, Tailwind CSS 4, `@paypal/react-paypal-js`, Lucide | Mobile-first screens |

## Sandbox setup

Needs Node.js 22.18 or newer and a free PayPal developer account. No real money is involved.

1. **Get sandbox credentials.** In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), open *Apps & Credentials*, switch to **Sandbox**, create an app, and copy its Client ID and Secret.
2. **Install.**
   ```bash
   npm install
   cp server/.env.example server/.env
   cp client/.env.example client/.env
   ```
3. **Configure.** Put the Client ID and Secret in `server/.env`, the Client ID in `client/.env` (`VITE_PAYPAL_CLIENT_ID`), and an Anthropic API key in `server/.env`. Never commit `.env` files.
4. **Create the database and run.**
   ```bash
   npm run db:push
   npm run dev
   ```
   Open <http://localhost:5173>. The home screen shows which keys are still missing.

### Tests

```bash
npm test          # server and client
npm run typecheck
```

## Project structure

```
client/   React + Vite + Tailwind app (src/features/{expenses,settlement,payments}, src/components/ui)
server/   Express API (src/routes, src/services/{parsing,settlement,paypal}, prisma/schema.prisma)
docs/     Design decisions and the demo video script
```

## License

MIT, copyright wakkaduu and SplitPilot contributors. See [LICENSE](LICENSE).
