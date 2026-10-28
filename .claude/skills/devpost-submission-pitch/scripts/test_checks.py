"""Run with: python3 -m unittest -v scripts/test_checks.py   (from the skill folder)"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import readme_check as rc  # noqa: E402
import script_check as sc  # noqa: E402

GOOD_README = """# SplitPay

## Problem
Splitting a trip over chat is messy.

## Solution
Paste the chat, get the split, settle with PayPal.

## Tech Stack
- Claude (Anthropic API) extracts expenses
- PayPal Orders API (sandbox)

## Sandbox Setup
1. `npm install`
2. Copy `.env.example` to `.env`; set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the PayPal sandbox.
3. `npm run dev`

See [the license](LICENSE).
"""


def make_repo(readme=GOOD_README, **files):
    d = Path(tempfile.mkdtemp())
    (d / "README.md").write_text(readme)
    defaults = {
        "LICENSE": "MIT",
        ".env.example": "PAYPAL_CLIENT_ID=\nPAYPAL_CLIENT_SECRET=\n",
        "package.json": json.dumps({"scripts": {"dev": "vite", "test": "vitest"}}),
    }
    defaults.update(files)
    for name, content in defaults.items():
        if content is not None:
            (d / name).write_text(content)
    return d


class ReadmeCheck(unittest.TestCase):
    def test_good_repo_passes(self):
        errors, warnings = rc.check(make_repo())
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_missing_sections_and_license(self):
        errors, _ = rc.check(make_repo("# X\nhello\n", LICENSE=None))
        text = "\n".join(errors)
        for needle in ("'Problem'", "'Solution'", "'Tech Stack'", "LICENSE"):
            self.assertIn(needle, text)

    def test_env_var_not_documented(self):
        errors, _ = rc.check(make_repo(**{".env.example": "PAYPAL_CLIENT_ID=\nANTHROPIC_API_KEY=\n"}))
        self.assertTrue(any("ANTHROPIC_API_KEY" in e for e in errors))

    def test_npm_script_that_does_not_exist(self):
        errors, _ = rc.check(make_repo(GOOD_README + "\nRun `npm run seed` first.\n"))
        self.assertTrue(any("'seed'" in e for e in errors))

    def test_npm_start_without_start_script(self):
        errors, _ = rc.check(make_repo(GOOD_README + "\nthen `npm start`\n"))
        self.assertTrue(any("npm start" in e for e in errors))

    def test_broken_relative_link_and_image(self):
        errors, _ = rc.check(make_repo(GOOD_README + "\n[docs](docs/missing.md) ![shot](img/none.png) [ok](https://x.dev)\n"))
        self.assertEqual(sum("does not exist" in e for e in errors), 2)

    def test_secret_in_readme(self):
        secret = "EK3" + "a9Zq" * 14
        errors, _ = rc.check(make_repo(GOOD_README + f"\nPAYPAL_CLIENT_SECRET={secret}\n"))
        self.assertTrue(any("real secret" in e for e in errors))

    def test_plain_long_word_or_url_is_not_a_secret(self):
        errors, _ = rc.check(make_repo(GOOD_README + "\nhttps://example.com/" + "a" * 70 + "\n"))
        self.assertEqual(errors, [])

    def test_env_file_must_be_gitignored(self):
        d = make_repo(**{".env": "PAYPAL_CLIENT_ID=x\n"})
        self.assertTrue(any(".gitignore" in e for e in rc.check(d)[0]))
        (d / ".gitignore").write_text("node_modules\n.env\n")
        self.assertEqual(rc.check(d)[0], [])

    def test_placeholders_and_missing_ai_are_warnings(self):
        readme = GOOD_README.replace("Claude (Anthropic API) extracts expenses", "A smart thing") + "\nTODO: screenshots\n"
        errors, warnings = rc.check(make_repo(readme))
        self.assertEqual(errors, [])
        text = "\n".join(warnings)
        self.assertIn("TODO", text)
        self.assertIn("AI model", text)

    def test_no_readme(self):
        self.assertEqual(rc.check(Path(tempfile.mkdtemp()))[0], ["README.md not found"])

    def test_code_blocks_do_not_trigger_placeholder_warnings(self):
        _, warnings = rc.check(make_repo(GOOD_README + "\n```\n# TODO in sample output\n```\n"))
        self.assertEqual(warnings, [])


GOOD_SCRIPT = """| Time | Beat | On screen | Voiceover |
|---|---|---|---|
| 0:00-0:12 | Hook | Group chat, eleven messages | "Four friends, one trip, and eleven messages about who owes what." |
| 0:12-0:30 | Problem | Venmo-style notes | "Splitting costs by hand means mistakes, awkward reminders, and a dozen separate payments." |
| 0:30-2:15 | Live demo | Paste chat, parse, split, pay | "[typing] Paste the chat. The AI turns it into expenses. We net everyone out to three payments, and pay with PayPal." |
| 2:15-2:45 | Impact | Success screen | "Fewer payments, no arithmetic, and nobody chases anybody." |
"""


class ScriptCheck(unittest.TestCase):
    def run_check(self, md, **kw):
        rows, problems = sc.parse(md)
        errors, warnings = sc.check(rows, kw.get("limit", 180), kw.get("max_wps", 2.6))
        return problems + errors, warnings

    def test_good_script_passes(self):
        errors, warnings = self.run_check(GOOD_SCRIPT)
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])

    def test_over_three_minutes_is_an_error(self):
        errors, _ = self.run_check(GOOD_SCRIPT.replace("2:15-2:45", "2:15-3:20"))
        self.assertTrue(any("over the 3:00 limit" in e for e in errors))

    def test_no_margin_is_a_warning(self):
        errors, warnings = self.run_check(GOOD_SCRIPT.replace("2:15-2:45", "2:15-2:58"))
        self.assertEqual(errors, [])
        self.assertTrue(any("margin" in w for w in warnings))

    def test_overlap_is_an_error_and_gap_a_warning(self):
        errors, _ = self.run_check(GOOD_SCRIPT.replace("0:12-0:30", "0:10-0:30"))
        self.assertTrue(any("before the previous row ends" in e for e in errors))
        _, warnings = self.run_check(GOOD_SCRIPT.replace("0:12-0:30", "0:15-0:30"))
        self.assertTrue(any("gap of 3s" in w for w in warnings))

    def test_too_many_words_for_the_time(self):
        fast = GOOD_SCRIPT.replace('"Four friends, one trip, and eleven messages about who owes what."', '"' + "word " * 40 + '"')
        errors, _ = self.run_check(fast)
        self.assertTrue(any("too fast to say" in e for e in errors))

    def test_stage_directions_are_not_counted_as_speech(self):
        self.assertEqual(sc.count_words("[typing quickly] Hello (pause) there world"), 3)
        self.assertEqual(sc.count_words("It costs $24.50, split 3-ways."), 5)

    def test_missing_beats(self):
        errors, _ = self.run_check(GOOD_SCRIPT.replace("| Hook |", "| Intro |").replace("| Impact |", "| Close |"))
        text = "\n".join(errors)
        self.assertIn("no Hook beat", text)
        self.assertIn("no Impact beat", text)

    def test_demo_should_be_at_least_half(self):
        short_demo = GOOD_SCRIPT.replace("0:30-2:15", "0:30-1:00").replace("2:15-2:45", "1:00-1:30")
        _, warnings = self.run_check(short_demo)
        self.assertTrue(any("live demo is" in w for w in warnings))

    def test_music_must_be_cleared(self):
        _, warnings = self.run_check(GOOD_SCRIPT.replace("Group chat, eleven messages", "Group chat, upbeat music"))
        self.assertTrue(any("music" in w for w in warnings))
        _, warnings = self.run_check(GOOD_SCRIPT.replace("Group chat, eleven messages", "Group chat, royalty-free music"))
        self.assertFalse(any("music" in w for w in warnings))

    def test_unreadable_time_and_missing_table(self):
        errors, _ = self.run_check(GOOD_SCRIPT.replace("0:00-0:12", "start"))
        self.assertTrue(any("cannot read the time range" in e for e in errors))
        errors, _ = self.run_check("just prose")
        self.assertTrue(any("no table" in e for e in errors))

    def test_en_dash_ranges_are_accepted(self):
        errors, _ = self.run_check(GOOD_SCRIPT.replace("0:00-0:12", "0:00–0:12"))
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
