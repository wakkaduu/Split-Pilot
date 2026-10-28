---
name: devpost-submission-pitch
description: Maintains the project's living README.md (Problem, Solution, Tech Stack, Sandbox Setup, honest what-works table) as features land, writes the Devpost text sections, and produces a structured second-by-second video script under 3 minutes (hook, live core workflow, impact), with checkers that catch README drift and scripts that run too long or too fast. Use this skill whenever the user mentions README, Devpost, submission, pitch, demo video, video script, voiceover, storyboard, "write up", elevator pitch, or "what do we say", whenever a feature has just been finished and the docs may now be stale, and whenever the user asks if the repo or video is ready for the hackathon, even if they never say "README" or "script".
---

# Devpost submission and pitch

Judges decide on what they can read in two minutes and watch in three. A strong project with a stale README or a rambling video loses to a weaker one that is easy to evaluate, so this skill keeps three artifacts true and tight: the README, the Devpost text, and the video script.

The hackathon requires (from the team's copy of the requirements; the Official Rules were not seen, so confirm anything legal on Devpost): a text description of features, a functional demo judges can run or a hosted URL, the AI tools used and how, a public repo with a visible open-source license, and a public YouTube video under 3 minutes showing the project working, with no third-party trademarks or copyrighted music. Everything below serves those.

## One rule that overrides the rest

**Describe only what works today.** A README or video that claims a feature the code doesn't have is worse than a shorter one: judges try the build, and a mismatch costs trust in everything else. Before writing about a capability, find it in the code or run it. Put unfinished ideas under "Roadmap", not in the pitch.

## 1. The living README

Use [assets/README.template.md](assets/README.template.md). Its required sections are Problem, Solution (with a "what works today" table), Tech Stack (with a "how it is used" column, because the submission must say which AI model and PayPal APIs were used and how), and Sandbox Setup.

Update it in the same change as the feature, every time. A short routine:

1. Read the repo's facts instead of recalling them: `package.json` scripts, `.env.example`, the route files, the test commands, the model name in the code.
2. Update the "what works today" table and move anything finished out of Roadmap.
3. Update Tech Stack if a dependency or API changed, and Sandbox Setup if a command, port, or env var did.
4. Run `python3 scripts/readme_check.py <repo>` from this skill's folder. It fails on a missing section or LICENSE, an env var in `.env.example` the README never mentions, `npm run X` for a script that doesn't exist, broken relative links, anything that looks like a real secret, and an un-gitignored `.env`. It warns on placeholder text and a Tech Stack that never names the AI service.
5. If the commands are cheap, run the setup steps yourself from a clean clone. "Works on my machine" is the failure judges hit most, and only running the steps finds it.

Writing guidance that matters here:

- **Problem:** a concrete scene, then the cost. "Four friends, one cabin, eleven messages" lands harder than "expense splitting is hard".
- **Sandbox Setup:** a judge should reach a working payment in under five minutes. Tell them where to create sandbox credentials, to use the sandbox *buyer* account to approve, and give a sample input with the expected result so they know the build is correct.
- Never paste a real secret into the README, `.env.example`, or the video; the repo is public.
- Screenshots and the demo link go near the top.

## 2. The Devpost text

Devpost's form typically has an elevator pitch, an about section (inspiration, what it does, how it was built, challenges, accomplishments, what was learned, what's next), "built with" tags, links, and the video URL. Check the live form; it could not be fetched here. Derive every section from the README rather than writing it fresh, so the two never disagree: the pitch is the README's first sentence, "what it does" is Solution plus the working table, "how we built it" is Tech Stack, "challenges" are the real hard parts (ambiguous text, exact money math, double-charge safety), and "what's next" is Roadmap. State the AI model/service used and what it does, explicitly.

## 3. The 3-minute video script

Use [assets/video-script.template.md](assets/video-script.template.md), a complete example for this product (paste chat or receipt, parse, split, settle through PayPal). The format is a table with `Time | Beat | On screen | Voiceover`, because a script you can't time is a hope, not a script.

Shape, and why:

| Segment | Time | Purpose |
|---|---|---|
| Hook | 0:00-0:10 | Start on the pain, in a scene. No logo card; viewers decide in ten seconds. |
| Problem and solution | 0:10-0:30 | One sentence of cost, one of product. |
| Live demo | about 1:45, at least half the video | The real flow on the real app: parse, split, settle. Show the AI doing something visible, one moment where it asks instead of guessing, and a sandbox payment actually completing. |
| How it works | about 0:20 | One diagram; name the AI model and the PayPal APIs. This is the "tools used" evidence. |
| Impact | about 0:15 | Who benefits, one concrete number from the demo, the repo link. |

Aim for **2:45 to 2:55**. Judges needn't watch past 3:00, so the impact beat must land before then, and a few seconds of margin absorbs a slow export. Write narration for the ear: short sentences, about 155 words a minute at the most, and less when the screen is busy, since viewers can't read and listen at full speed. Put stage directions in `[brackets]`; the checker doesn't count them as speech.

After writing, run `python3 scripts/script_check.py <script.md>`. It errors on a runtime over 3:00, overlapping rows, narration too fast for its time slot, and a missing Hook, Demo, or Impact beat; it warns on gaps, under 5 seconds of margin, a demo shorter than half the video, and music not marked royalty-free or licensed.

Video rules to build into the script, not discover at export time: record the demo on the device the project was built for; no copyrighted music or stock footage and no third-party logos in your own graphics (the PayPal page that appears in the real flow is unavoidable, keep it on screen only as long as the step needs); upload to YouTube as Public and open the link logged out to confirm.

If a step in the script isn't built yet, cut it from the script. A mockup or staged screen doesn't satisfy the working-demo requirement.

## Before declaring it ready

Run the `paypal-hackathon` critic skill over the README, repo, and script together; it checks the requirements list and will catch things this skill's checkers don't (is PayPal central, is the AI meaningful). Then do the final human pass: a teammate who hasn't seen the project follows the README cold while you watch.
