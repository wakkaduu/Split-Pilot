#!/usr/bin/env python3
"""Check a second-by-second video script against the hackathon's 3-minute limit.

The script is a markdown table with the columns Time | Beat | On screen | Voiceover,
for example:

| Time      | Beat | On screen            | Voiceover                          |
|-----------|------|----------------------|------------------------------------|
| 0:00-0:12 | Hook | Group chat, 11 msgs  | "Four friends, one trip..."        |

Usage: script_check.py SCRIPT.md [--limit 180] [--max-wps 2.6]
Exit code 0 = no errors (warnings allowed), 1 = at least one error.

What it checks, and why:
  - total runtime is under the limit (judges need not watch past 3:00)
  - rows are contiguous (gaps and overlaps mean the timing is not real)
  - narration fits the time: words per second stays at a speakable pace
  - the three beats the pitch needs exist: Hook, a live Demo, Impact
  - the demo takes at least half the video (the product is the point)
  - music is flagged unless the script says it is royalty-free / licensed / none
"""
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass

TIME_RE = re.compile(r"^\s*(\d+):(\d{2})\s*(?:-|–|—|to)\s*(\d+):(\d{2})\s*$")
WORD_RE = re.compile(r"[A-Za-z0-9$%][A-Za-z0-9$%'’.,\-]*")


@dataclass
class Row:
    start: int
    end: int
    beat: str
    screen: str
    voice: str
    line: int

    @property
    def seconds(self) -> int:
        return self.end - self.start

    @property
    def words(self) -> int:
        return count_words(self.voice)


def count_words(text: str) -> int:
    """Spoken words only: stage directions in [brackets] and (parentheses) are not narrated."""
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", text)
    return len(WORD_RE.findall(text))


def split_row(line: str) -> list[str]:
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells


def parse(md: str) -> tuple[list[Row], list[str]]:
    rows: list[Row] = []
    problems: list[str] = []
    cols: dict[str, int] | None = None
    for n, line in enumerate(md.splitlines(), 1):
        if not line.lstrip().startswith("|"):
            continue
        cells = split_row(line)
        lowered = [c.lower() for c in cells]
        if "time" in lowered and "voiceover" in lowered and cols is None:
            cols = {name: lowered.index(name) for name in ("time", "beat", "on screen", "voiceover") if name in lowered}
            continue
        if set("".join(cells)) <= set("-: "):
            continue  # separator row
        if cols is None:
            continue
        m = TIME_RE.match(cells[cols["time"]]) if len(cells) > cols["time"] else None
        if not m:
            problems.append(f"line {n}: cannot read the time range {cells[cols['time']]!r} (use m:ss-m:ss)")
            continue
        a, b, c, d = map(int, m.groups())
        get = lambda key: cells[cols[key]] if key in cols and len(cells) > cols[key] else ""
        rows.append(Row(a * 60 + b, c * 60 + d, get("beat"), get("on screen"), get("voiceover"), n))
    if cols is None:
        problems.append("no table with Time and Voiceover columns was found")
    return rows, problems


def check(rows: list[Row], limit: int, max_wps: float) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not rows:
        return ["no timed rows found"], warnings

    total = rows[-1].end
    if rows[0].start != 0:
        warnings.append(f"first row starts at {fmt(rows[0].start)}, not 0:00")
    if total > limit:
        errors.append(f"runs {fmt(total)}, over the {fmt(limit)} limit")
    elif total > limit - 5:
        warnings.append(f"runs {fmt(total)}, leaving under 5s of margin; aim for {fmt(limit - 15)} to {fmt(limit - 5)}")

    for prev, row in zip(rows, rows[1:]):
        if row.start > prev.end:
            warnings.append(f"gap of {row.start - prev.end}s between {fmt(prev.end)} and {fmt(row.start)}")
        elif row.start < prev.end:
            errors.append(f"line {row.line}: starts {fmt(row.start)} before the previous row ends at {fmt(prev.end)}")

    for row in rows:
        if row.seconds <= 0:
            errors.append(f"line {row.line}: end {fmt(row.end)} is not after start {fmt(row.start)}")
            continue
        wps = row.words / row.seconds
        if wps > max_wps + 0.4:
            errors.append(f"line {row.line} ({fmt(row.start)}): {row.words} words in {row.seconds}s = {wps:.1f} words/s, too fast to say")
        elif wps > max_wps:
            warnings.append(f"line {row.line} ({fmt(row.start)}): {wps:.1f} words/s is brisk; trim or extend")
        text = f"{row.screen} {row.voice}".lower()
        if "music" in text and not re.search(r"no music|royalty|licensed|original|cc0|public domain|none", text):
            warnings.append(f"line {row.line}: music is mentioned without saying it is royalty-free, licensed or original")

    beats = {r.beat.lower() for r in rows}
    for needed, aliases in {"Hook": ("hook",), "Demo": ("demo", "live"), "Impact": ("impact",)}.items():
        if not any(any(a in b for a in aliases) for b in beats):
            errors.append(f"no {needed} beat found (label it in the Beat column)")

    demo = sum(r.seconds for r in rows if any(a in r.beat.lower() for a in ("demo", "live")))
    if total and demo / total < 0.5:
        warnings.append(f"the live demo is {demo}s of {total}s ({demo * 100 // total}%); judges want to see it working, aim for at least half")
    return errors, warnings


def fmt(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script")
    ap.add_argument("--limit", type=int, default=180, help="seconds; default 180")
    ap.add_argument("--max-wps", type=float, default=2.6, help="words per second; default 2.6 (about 155 wpm)")
    args = ap.parse_args(argv)

    with open(args.script, encoding="utf-8") as f:
        rows, problems = parse(f.read())
    errors, warnings = check(rows, args.limit, args.max_wps)
    errors = problems + errors

    if rows:
        words = sum(r.words for r in rows)
        print(f"{len(rows)} segments, {fmt(rows[-1].end)} total, {words} spoken words")
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    if not errors:
        print("OK" + (" (with warnings)" if warnings else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
