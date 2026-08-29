"""Mark vacancies as NEW (within 24h and unseen) and persist history.

Reads data/vacancies.json, mutates it in place by adding is_new + is_archived
flags, and updates data/history.json with the set of known post IDs.

History is keyed by stable ID `channel_id:msg_id` (plus `#part` for the
individual vacancies of a roundup message). Entries older than the
archive window are pruned to keep the file small.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "sources.yml"
VACANCIES_PATH = ROOT / "data" / "vacancies.json"
HISTORY_PATH = ROOT / "data" / "history.json"

HISTORY_TTL_DAYS = 60


def _post_uid(vacancy: dict) -> str:
    # Roundup messages contribute several vacancies under one msg_id; `part`
    # keeps their NEW state separate. Absent (or 0) for ordinary posts, so
    # ids already in history keep matching.
    uid = f"{vacancy.get('channel_id')}:{vacancy.get('msg_id')}"
    part = vacancy.get("part", 0)
    return f"{uid}#{part}" if part else uid


def _parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def run() -> None:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    new_window = timedelta(hours=config.get("new_window_hours", 24))
    archive_after = timedelta(days=config.get("archive_after_days", 30))

    vacancies = json.loads(VACANCIES_PATH.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)

    history: dict = {"last_run_at": None, "known_post_ids": {}}
    if HISTORY_PATH.exists():
        try:
            history = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    known = history.get("known_post_ids", {})

    for v in vacancies:
        uid = _post_uid(v)
        published = _parse_iso(v["date_iso"])
        age = now - published
        first_seen_iso = known.get(uid)
        if first_seen_iso:
            first_seen = _parse_iso(first_seen_iso)
        else:
            first_seen = now
            known[uid] = first_seen.isoformat()
        v["is_new"] = (now - first_seen) <= new_window and age <= new_window
        v["is_archived"] = age > archive_after

    # Prune history entries older than TTL.
    cutoff = now - timedelta(days=HISTORY_TTL_DAYS)
    pruned = {
        uid: ts for uid, ts in known.items()
        if _parse_iso(ts) >= cutoff
    }
    print(f"[state] history: {len(known)} entries -> {len(pruned)} after prune")

    history = {
        "last_run_at": now.isoformat(),
        "known_post_ids": pruned,
    }
    HISTORY_PATH.write_text(
        json.dumps(history, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    VACANCIES_PATH.write_text(
        json.dumps(vacancies, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    new_count = sum(1 for v in vacancies if v["is_new"])
    archived_count = sum(1 for v in vacancies if v["is_archived"])
    print(f"[state] {new_count} new, {archived_count} archived out of {len(vacancies)}")


if __name__ == "__main__":
    run()
