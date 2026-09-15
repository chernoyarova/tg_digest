"""Stage-1 filter: regex-match posts that name the role of the active profile.

False positives (articles about the role, courses, memes) are filtered out
later by the rule-based stage-2 filter in enrich.py. This stage is
intentionally permissive.

The patterns come from profiles/<name>.yml (`roles.patterns` and
`roles.loose`); see role_profile.py.

Input:  data/raw_tg.json
Output: data/parsed.json
"""
from __future__ import annotations

import json
from pathlib import Path

from role_profile import PROFILE

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw_tg.json"
PARSED_PATH = ROOT / "data" / "parsed.json"

# A role that is unambiguously ours, without the loose abbreviations.
ROLE_RE = PROFILE.role_re
# Good enough to let a post in, not to name its role.
VACANCY_RE = PROFILE.vacancy_re


def matches(text: str) -> bool:
    return bool(VACANCY_RE.search(text or ""))


def run() -> None:
    posts = json.loads(RAW_PATH.read_text(encoding="utf-8"))
    matched = [p for p in posts if matches(p["text"])]
    for p in matched:
        p["regex_matched"] = True
    PARSED_PATH.write_text(
        json.dumps(matched, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[parse] {len(matched)}/{len(posts)} posts matched regex -> {PARSED_PATH}")


if __name__ == "__main__":
    run()
