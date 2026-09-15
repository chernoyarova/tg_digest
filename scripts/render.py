"""Render vacancies.json to index.html via Jinja2."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

from role_profile import PROFILE

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "sources.yml"
VACANCIES_PATH = ROOT / "data" / "vacancies.json"
TEMPLATE_DIR = ROOT / "templates"
OUTPUT_PATH = ROOT / "index.html"


def _script_json(value) -> str:
    """JSON safe to embed inside a <script> tag.

    json.dumps leaves "<" as is, so a post containing "</script>" would close
    the tag and have the rest run as page script. "\\u003c" is the same
    character to JSON.parse.
    """
    return json.dumps(value, ensure_ascii=False).replace("<", "\\u003c")


def run() -> None:
    vacancies = json.loads(VACANCIES_PATH.read_text(encoding="utf-8"))
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("index.html.j2")
    generated_at = datetime.now(timezone.utc).isoformat()
    tags = [{"key": t.key, "label": t.label} for t in PROFILE.tags]
    html = template.render(
        vacancies=vacancies,
        generated_at=generated_at,
        data_json=_script_json(vacancies),
        site=PROFILE.site,
        tags=tags,
        tags_json=_script_json(tags),
        archive_after_days=config.get("archive_after_days", 30),
        asset_v=generated_at.replace(":", "").replace("-", "")[:13],
        goatcounter_site=(config.get("goatcounter_site") or "").strip(),
    )
    OUTPUT_PATH.write_text(html, encoding="utf-8")
    print(f"[render] wrote {len(vacancies)} vacancies -> {OUTPUT_PATH}")


if __name__ == "__main__":
    run()
