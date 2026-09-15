"""The role profile: everything in the pipeline that is about *which* jobs.

The pipeline itself is role-agnostic — reading the folder, deciding whether a
post is a hiring post, dedup, NEW/archive, the page. What makes it a digest
of Product jobs rather than frontend ones is a handful of regexes and labels,
and those live in profiles/<name>.yml. `profile:` in config/sources.yml picks
the file; the TG_DIGEST_PROFILE environment variable overrides it.

Every pattern is compiled with IGNORECASE | UNICODE, so \\b works on Cyrillic.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "sources.yml"
PROFILES_DIR = ROOT / "profiles"

FLAGS = re.IGNORECASE | re.UNICODE

# Grades from most to least senior. The order matters: the first one whose
# pattern matches wins, so "Senior/Lead" reads as Lead.
GRADES = ["Head", "Lead", "Senior", "Middle", "Junior"]
GRADE_BASE = {
    "Head": r"head\b",
    "Lead": r"\blead\b|team ?lead|\bлид\b|principal|ведущий|ведущего",
    "Senior": r"\bsenior\b|\bsr\.?\b|сеньор\w*|синьор\w*|старший|старшего",
    "Middle": r"\bmiddle\b|\bmid\b|мидл\w*|миддл\w*",
    "Junior": r"\bjunior\b|\bjun\b|\bintern\b|джуниор\w*|джун\w*|стаж[её]р\w*|стажировк\w*",
}


@dataclass(frozen=True)
class Tag:
    key: str      # field name on the vacancy, e.g. "ml_ai"
    label: str    # what the page shows, e.g. "ML/AI"
    pattern: re.Pattern


@dataclass(frozen=True)
class Profile:
    name: str
    site: dict
    role_re: re.Pattern          # names the role, and nothing else
    vacancy_re: re.Pattern       # role_re plus the loose abbreviations: lets a post in
    hint_re: re.Pattern          # a roundup headline with this word is one of ours
    title_extra_re: re.Pattern   # role spellings checked on the title only
    exclude_re: re.Pattern       # neighbouring roles: a title naming one is dropped
    grade_res: list[tuple[str, re.Pattern]]
    tags: list[Tag]


def _join(patterns: list[str] | None) -> str:
    patterns = [p for p in (patterns or []) if p]
    # A pattern that can never match, for an empty list.
    return "|".join(patterns) if patterns else r"(?!x)x"


def _compile(pattern: str, where: str) -> re.Pattern:
    try:
        return re.compile(pattern, FLAGS)
    except re.error as exc:
        raise ValueError(f"profile: bad regex in {where}: {exc}") from exc


def load(name: str | None = None) -> Profile:
    if name is None:
        name = os.environ.get("TG_DIGEST_PROFILE")
    if name is None:
        config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
        name = config.get("profile") or "product"
    path = PROFILES_DIR / f"{name}.yml"
    if not path.exists():
        available = sorted(p.stem for p in PROFILES_DIR.glob("*.yml"))
        raise FileNotFoundError(f"profile {name!r} not found in {PROFILES_DIR}; available: {available}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    roles = raw.get("roles") or {}
    if not roles.get("patterns"):
        raise ValueError(f"profile {name!r}: roles.patterns must list at least one regex")
    role = _join(roles["patterns"])
    loose = _join(roles.get("loose"))

    grades_extra = raw.get("grades_extra") or {}
    unknown = set(grades_extra) - set(GRADES)
    if unknown:
        raise ValueError(f"profile {name!r}: unknown grades in grades_extra: {sorted(unknown)}")
    grade_res = [
        (g, _compile(_join([GRADE_BASE[g], grades_extra.get(g)]), f"grades_extra.{g}"))
        for g in GRADES
    ]

    tags = []
    for t in raw.get("tags") or []:
        for field in ("key", "label", "pattern"):
            if not t.get(field):
                raise ValueError(f"profile {name!r}: every tag needs key, label and pattern")
        if not re.fullmatch(r"[a-z][a-z0-9_]*", t["key"]):
            raise ValueError(f"profile {name!r}: tag key {t['key']!r} must be a lowercase identifier")
        tags.append(Tag(t["key"], str(t["label"]), _compile(t["pattern"], f"tags.{t['key']}")))

    site = {"title": "Jobs", "tagline": "from Telegram", **(raw.get("site") or {})}
    return Profile(
        name=name,
        site=site,
        role_re=_compile(role, "roles.patterns"),
        vacancy_re=_compile(f"{role}|{loose}" if roles.get("loose") else role, "roles.loose"),
        hint_re=_compile(_join(roles.get("hint")), "roles.hint"),
        title_extra_re=_compile(_join(roles.get("title_extra")), "roles.title_extra"),
        exclude_re=_compile(_join(roles.get("exclude")), "roles.exclude"),
        grade_res=grade_res,
        tags=tags,
    )


PROFILE = load()
