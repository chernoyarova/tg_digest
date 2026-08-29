"""Cluster duplicate vacancies and merge new arrivals with prior runs.

Method: difflib.SequenceMatcher on normalized text (lowercase, no punctuation,
no emoji, collapsed whitespace), threshold 0.9. Primary card = earliest by date.

The previous data/vacancies.json acts as a persistent cache. On each run:
  1. Load existing primaries (with their duplicates lists).
  2. For each new enriched post:
     - If it matches an existing primary (>= 0.9), append it to that primary's
       duplicates list (cheap: O(N) per new post).
     - Otherwise, set it aside for clustering with other new arrivals.
  3. Cluster the leftover new posts among themselves.
  4. Output = existing primaries (with updated duplicates) + new clusters.

This keeps the work on subsequent runs proportional to *new* posts only:
posts we've already seen are not re-processed.

Input:  data/enriched.json
Output: data/vacancies.json (also reads previous version as cache)
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENRICHED_PATH = ROOT / "data" / "enriched.json"
VACANCIES_PATH = ROOT / "data" / "vacancies.json"

THRESHOLD = 0.9
# SequenceMatcher.ratio() <= 2 * min(la, lb) / (la + lb), so two texts whose
# lengths differ by more than this factor can never reach THRESHOLD. Cheap
# guard that lets us skip the expensive comparison outright.
LEN_RATIO_FLOOR = THRESHOLD / (2 - THRESHOLD)
PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)
WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Lowercase, drop emoji + punctuation, collapse whitespace."""
    text = (text or "").lower()
    text = "".join(
        ch for ch in text
        if not unicodedata.category(ch).startswith(("S", "C"))
        or ch in (" ", "\n", "\t")
    )
    text = PUNCT_RE.sub(" ", text)
    text = WS_RE.sub(" ", text).strip()
    return text


class _Doc:
    """A normalized text plus what the cheap similarity bounds need.

    Comparing every pair with SequenceMatcher.ratio() is far too slow once a
    backlog builds up, so each pair passes two O(alphabet) filters first:
    length, then shared-character count (the same bound as
    SequenceMatcher.quick_ratio, but with the counts computed once per text
    instead of once per comparison). Both are upper bounds on ratio(), so
    anything they reject is genuinely below THRESHOLD — the pairs that do get
    compared score exactly as they did before.

    The comparisons themselves keep difflib's defaults and argument order:
    autojunk treats popular elements in the *second* sequence as junk, so
    swapping the two texts or disabling it would shift the scores and change
    which posts get merged.
    """

    __slots__ = ("norm", "length", "counts")

    def __init__(self, norm: str) -> None:
        self.norm = norm
        self.length = len(norm)
        self.counts = Counter(norm)

    def may_match(self, other: "_Doc") -> bool:
        if not self.length or not other.length:
            return False
        if min(self.length, other.length) / max(self.length, other.length) < LEN_RATIO_FLOOR:
            return False
        smaller, larger = (
            (self.counts, other.counts)
            if len(self.counts) <= len(other.counts)
            else (other.counts, self.counts)
        )
        shared = sum(min(n, larger.get(ch, 0)) for ch, n in smaller.items())
        return 2.0 * shared / (self.length + other.length) >= THRESHOLD


def _post_key(p: dict) -> tuple:
    return (p.get("channel_id"), p.get("msg_id"))


def _dup_entry(p: dict) -> dict:
    return {
        "channel_username": p.get("channel_username"),
        "channel_title": p.get("channel_title"),
        "link": p.get("link"),
        "date_iso": p.get("date_iso"),
    }


def _load_existing() -> list[dict]:
    if not VACANCIES_PATH.exists():
        return []
    try:
        existing = json.loads(VACANCIES_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    for v in existing:
        v.pop("is_new", None)
        v.pop("is_archived", None)
        v.setdefault("duplicates", [])
        v.setdefault("_norm", _normalize(v.get("text", "")))
    return existing


def run() -> None:
    new_posts = json.loads(ENRICHED_PATH.read_text(encoding="utf-8"))
    existing = _load_existing()

    # Drop new posts whose (channel_id, msg_id) is already represented (primary or duplicate).
    known_keys: set[tuple] = set()
    for v in existing:
        known_keys.add(_post_key(v))
        for d in v.get("duplicates", []):
            # Duplicates store link only; parse msg_id back out for the key.
            link = d.get("link", "")
            msg_id = None
            try:
                msg_id = int(link.rstrip("/").rsplit("/", 1)[-1])
            except (ValueError, IndexError):
                pass
            channel_id = d.get("channel_id")
            if channel_id is not None and msg_id is not None:
                known_keys.add((channel_id, msg_id))
    new_posts = [p for p in new_posts if _post_key(p) not in known_keys]
    print(f"[dedup] existing primaries: {len(existing)}, new posts: {len(new_posts)}")

    # Phase 1: try to attach each new post to an existing primary.
    existing_docs = [_Doc(v["_norm"]) for v in existing]
    leftover: list[dict] = []
    attached = 0
    matcher = SequenceMatcher()
    for p in new_posts:
        doc_p = _Doc(_normalize(p.get("text", "")))
        matcher.set_seq1(doc_p.norm)
        best = None
        best_score = 0.0
        for v, doc_v in zip(existing, existing_docs):
            if not doc_p.may_match(doc_v):
                continue
            matcher.set_seq2(doc_v.norm)
            score = matcher.ratio()
            if score > best_score:
                best_score = score
                best = v
        if best is not None and best_score >= THRESHOLD:
            best["duplicates"].append({**_dup_entry(p), "channel_id": p.get("channel_id")})
            attached += 1
        else:
            p["_norm"] = doc_p.norm
            leftover.append(p)
    print(f"[dedup] {attached} new posts attached to existing primaries; {len(leftover)} leftover")

    # Phase 2: cluster leftovers among themselves (union-find).
    n = len(leftover)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    docs = [_Doc(p["_norm"]) for p in leftover]

    for i in range(n):
        matcher.set_seq1(docs[i].norm)
        for j in range(i + 1, n):
            if find(i) == find(j):
                continue
            if not docs[i].may_match(docs[j]):
                continue
            matcher.set_seq2(docs[j].norm)
            if matcher.ratio() >= THRESHOLD:
                union(i, j)

    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)

    new_primaries: list[dict] = []
    for members in clusters.values():
        members.sort(key=lambda idx: leftover[idx]["date_iso"])
        primary = leftover[members[0]]
        primary["duplicates"] = [
            {**_dup_entry(leftover[m]), "channel_id": leftover[m].get("channel_id")}
            for m in members[1:]
        ]
        new_primaries.append(primary)

    # Combine + clean up scratch fields, sort newest first.
    result = existing + new_primaries
    for v in result:
        v.pop("_norm", None)
        # Deduplicate the duplicates list by link (defensive against repeated runs).
        seen_links: set[str] = set()
        unique_dupes = []
        for d in v.get("duplicates", []):
            link = d.get("link")
            if link and link not in seen_links and link != v.get("link"):
                seen_links.add(link)
                unique_dupes.append(d)
        v["duplicates"] = unique_dupes
    result.sort(key=lambda v: v["date_iso"], reverse=True)

    VACANCIES_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[dedup] final: {len(result)} vacancies ({attached} merged, {len(new_primaries)} new clusters)")


if __name__ == "__main__":
    run()
