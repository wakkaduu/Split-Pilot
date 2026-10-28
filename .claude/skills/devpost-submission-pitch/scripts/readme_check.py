#!/usr/bin/env python3
"""Check that a repo's README is submission-ready and still matches the repo.

Usage: readme_check.py [REPO_DIR]        (default: current directory)
Exit code 0 = no errors (warnings allowed), 1 = at least one error.

A README goes stale the moment a feature lands, an env var is added, or an npm
script is renamed. These checks catch that drift mechanically:

  errors
    - README.md is missing, or lacks Problem / Solution / Tech Stack / Sandbox sections
    - no LICENSE file (the hackathon needs one visible in the repo's About box)
    - a variable in .env.example is never mentioned in the README
    - the README runs `npm run X` but package.json has no script X
    - a relative link points at a file that does not exist
    - something that looks like a real secret is in the README or .env.example
    - a .env file exists but is not in .gitignore
  warnings
    - placeholder text (TODO, TBD, coming soon, lorem ipsum, <your-...>)
    - the Tech Stack section never names an AI model or service
    - the README never mentions the sandbox environment or test accounts
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REQUIRED_SECTIONS = {
    "Problem": ("problem",),
    "Solution": ("solution",),
    "Tech Stack": ("tech stack", "built with", "technology"),
    "Sandbox Setup": ("sandbox", "setup", "getting started", "run it", "running"),
}
PLACEHOLDER_RE = re.compile(r"\b(TODO|TBD|FIXME|lorem ipsum|coming soon|xxx)\b|<your[-_ ][^>]*>", re.I)
# PayPal client secrets and most API keys are long unbroken tokens; real ones should never be committed.
SECRET_RE = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|E[A-Za-z0-9_-]{50,}|[A-Za-z0-9_-]{60,})\b")
AI_RE = re.compile(r"\b(claude|anthropic|gpt|openai|gemini|llama|mistral|llm|language model)\b", re.I)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.M)
LINK_RE = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|!\[[^\]]*\]\(([^)\s]+)\)")


def sections(md: str) -> dict[str, str]:
    """Heading text (lower-case) -> body up to the next heading of the same or higher level."""
    out: dict[str, str] = {}
    heads = list(HEADING_RE.finditer(md))
    for i, h in enumerate(heads):
        level = len(h.group(1))
        end = len(md)
        for nxt in heads[i + 1 :]:
            if len(nxt.group(1)) <= level:
                end = nxt.start()
                break
        out[h.group(2).strip().lower()] = md[h.end() : end]
    return out


def strip_code(md: str) -> str:
    return re.sub(r"```.*?```", "", md, flags=re.S)


def check(repo: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    readme = repo / "README.md"
    if not readme.is_file():
        return ["README.md not found"], warnings
    md = readme.read_text(encoding="utf-8")
    prose = strip_code(md)
    secs = sections(md)

    for label, keys in REQUIRED_SECTIONS.items():
        if not any(any(k in title for k in keys) for title in secs):
            errors.append(f"README has no '{label}' section (a heading containing: {', '.join(keys)})")

    if not any((repo / n).is_file() for n in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING")):
        errors.append("no LICENSE file; the repo must be open source with the license visible")

    env_example = repo / ".env.example"
    env_text = env_example.read_text(encoding="utf-8") if env_example.is_file() else ""
    if env_example.is_file():
        for name in re.findall(r"^\s*([A-Z][A-Z0-9_]*)\s*=", env_text, re.M):
            if name not in md:
                errors.append(f".env.example defines {name} but the README never mentions it")
    elif (repo / "package.json").is_file() and re.search(r"\.env\b", md):
        warnings.append("README mentions .env but there is no .env.example to copy from")

    pkg = repo / "package.json"
    if pkg.is_file():
        try:
            scripts = set(json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {}))
        except json.JSONDecodeError:
            errors.append("package.json is not valid JSON")
            scripts = set()
        for name in sorted(set(re.findall(r"npm run ([\w:.-]+)", md))):
            if name not in scripts:
                errors.append(f"README says `npm run {name}` but package.json has no '{name}' script")
        for name in sorted(set(re.findall(r"npm (start|test)\b", md))):
            if name not in scripts:
                errors.append(f"README says `npm {name}` but package.json has no '{name}' script")

    for m in LINK_RE.finditer(md):
        target = (m.group(1) or m.group(2) or "").split("#")[0]
        if target and not re.match(r"^(https?:|mailto:|data:)", target) and not (repo / target).exists():
            errors.append(f"link to '{target}' does not exist in the repo")

    for label, text in (("README.md", md), (".env.example", env_text)):
        for m in SECRET_RE.finditer(text):
            token = m.group(0)
            # URLs and long identifiers are not secrets; real secrets mix letters and digits.
            if re.search(r"[A-Za-z]", token) and re.search(r"\d", token) and "/" not in token:
                errors.append(f"{label} contains what looks like a real secret ({token[:6]}…); remove it and rotate the key")

    env_file = repo / ".env"
    if env_file.is_file():
        gi = repo / ".gitignore"
        ignored = gi.is_file() and re.search(r"^/?\.env\s*$", gi.read_text(encoding="utf-8"), re.M)
        if not ignored:
            errors.append(".env exists but is not listed in .gitignore")

    for m in PLACEHOLDER_RE.finditer(prose):
        warnings.append(f"placeholder text in README: '{m.group(0)}'")

    stack = next((body for title, body in secs.items() if any(k in title for k in REQUIRED_SECTIONS["Tech Stack"])), "")
    if stack and not AI_RE.search(stack):
        warnings.append("Tech Stack never names the AI model or service; the submission must say which was used and how")
    if not re.search(r"sandbox", md, re.I):
        warnings.append("README never mentions the PayPal sandbox or sandbox test accounts")
    return errors, warnings


def main(argv: list[str]) -> int:
    repo = Path(argv[0]) if argv else Path.cwd()
    errors, warnings = check(repo)
    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")
    if not errors:
        print("OK" + (" (with warnings)" if warnings else ""))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
