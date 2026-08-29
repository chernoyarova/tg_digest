"""Render vacancies.json to index.html via Jinja2."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "sources.yml"
VACANCIES_PATH = ROOT / "data" / "vacancies.json"
TEMPLATE_DIR = ROOT / "templates"
OUTPUT_PATH = ROOT / "index.html"


def run() -> None:
    vacancies = json.loads(VACANCIES_PATH.read_text(encoding="utf-8"))
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html"]),
    )
    template = env.get_template("index.html.j2")
    generated_at = datetime.now(timezone.utc).isoformat()
    html = template.render(
        vacancies=vacancies,
        generated_at=generated_at,
        data_json=json.dumps(vacancies, ensure_ascii=False),
        asset_v=generated_at.replace(":", "").replace("-", "")[:13],
        goatcounter_site=(config.get("goatcounter_site") or "").strip(),
    )
    OUTPUT_PATH.write_text(html, encoding="utf-8")
    print(f"[render] wrote {len(vacancies)} vacancies -> {OUTPUT_PATH}")


if __name__ == "__main__":
    run()
