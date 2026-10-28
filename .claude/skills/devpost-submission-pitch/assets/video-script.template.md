# <ProductName>: 3-minute demo video script

Target runtime **2:52** (limit is 3:00, judges need not watch past it). About 155 spoken words per minute is a comfortable pace; the checker flags anything faster than 2.6 words per second.
Check it with: `python3 .claude/skills/devpost-submission-pitch/scripts/script_check.py docs/video-script.md`

| Time | Beat | On screen | Voiceover |
|---|---|---|---|
| 0:00-0:10 | Hook | Real group chat scrolling: eleven messages, three receipt photos, "wait who paid for the Ubers?" | "Four friends. One cabin. Eleven messages, three receipts, and nobody knows who owes what." |
| 0:10-0:22 | Problem | Calculator and a notes app full of crossed-out numbers | "Splitting it by hand means mistakes, awkward reminders, and a pile of separate payments. We fixed all three." |
| 0:22-0:30 | Solution | Product name and logo over the empty app | "Meet <ProductName>. Paste the chat, and it settles the whole trip, through PayPal." |
| 0:30-1:00 | Demo | Paste the chat and a receipt photo into the box. Click Parse. Skeleton cards shimmer, then expense cards appear. One card shows the question "Who paid for the Ubers?" | "I paste the group chat and a receipt photo. The AI reads them into structured expenses: who paid, how much, in what currency, and who shares it. When something is ambiguous, like who paid for the Ubers, it asks instead of guessing." |
| 1:00-1:35 | Demo | Answer the question. Balances panel appears. Counter animates "7 debts to 3 payments". Show the three payments. | "Every expense becomes a net balance in exact cents. Seven debts collapse into three payments, the fewest possible for this group. No rounding drift, and nobody pays someone they do not need to." |
| 1:35-2:15 | Demo | Tap "Pay with PayPal". PayPal sandbox approval page. Approve. Return to the app. Success animation. Row flips to Paid. | "Now the money moves. One tap opens PayPal checkout, and the amount is set by our server, never the browser. I approve in the sandbox, PayPal sends me back, and the payment is captured and verified. Done, with a receipt." |
| 2:15-2:35 | How | Simple diagram: text, then AI parser, then solver, then PayPal Orders API. Terminal showing tests passing. | "Under the hood: Claude parses text with schema validation and retries, an exact solver minimizes payments, and PayPal's Orders API handles checkout with safe retries." |
| 2:35-2:52 | Impact | Montage of the same flow on a phone-sized screen. End card with repo link. | "No spreadsheets, no chasing friends, and fewer payments means fewer fees. Any group that shares costs, trips, flatmates, clubs, can settle in a minute. Thanks for watching." |

Replace every row with what the product really does. If a step in the table is not built and working, cut it from the video and the README rather than faking it: the submission requires a working build, and a mockup does not count.

## Beat notes

- **Hook (0:00-0:10).** Start on the pain, not the logo. A relatable scene beats a feature list. No title card.
- **Demo (at least half the runtime).** One continuous recording on the real app, on the device it was built for. The flow is parse, then split, then settle; show the AI doing real work, a moment where it asks a question, and a payment actually completing in the sandbox.
- **How (about 20s).** One diagram. Name the AI model/service used and what it does (the submission asks for this), and the PayPal APIs used.
- **Impact (about 15s).** Who benefits, and one concrete number from the demo ("7 debts to 3 payments"). End on the repo link and the product name.

## Recording checklist

- [ ] Seed data and sandbox accounts ready; run the whole flow twice off-camera first
- [ ] Logged in to a PayPal **sandbox personal** account in this browser; password manager prompts and notifications off
- [ ] Browser zoom 125%, bookmarks bar hidden, 1080p, a clean desktop; phone width for the Impact montage
- [ ] Microphone test; record voiceover in one room, one session
- [ ] No music, or royalty-free / original music you can show a licence for. No copyrighted songs or stock footage without a licence
- [ ] No third-party logos in your own graphics. The PayPal page that appears in the real flow is unavoidable; keep it on screen only as long as the step needs
- [ ] Final length checked by the script, then by a stopwatch on the exported file (under 3:00)
- [ ] Uploaded to YouTube as **Public** (not Unlisted), link opened in a logged-out window to confirm

## If the live demo breaks while recording

Record the sandbox payment as its own take and cut it in; do not cut to a mockup. Keep the parse and split takes separate so one failure costs one retake, not the whole video.
