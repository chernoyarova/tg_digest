"""Stage-1 filter: regex-match posts that look like Product/PM vacancies.

False positives (articles about PMs, courses for PMs, memes) are filtered out
later by the rule-based stage-2 filter in enrich.py. This stage is
intentionally permissive.

Input:  data/raw_tg.json
Output: data/parsed.json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_PATH = ROOT / "data" / "raw_tg.json"
PARSED_PATH = ROOT / "data" / "parsed.json"


# =============================================================================
# Vacancy keyword pattern. Combined via | and compiled with IGNORECASE+UNICODE.
# Each entry below covers a category from the brief. Word boundaries (\b)
# work correctly with Cyrillic under re.UNICODE.
# =============================================================================
_PATTERNS: list[str] = [
    # --- "продакт" in all Russian cases (продакт/-а/-у/-ом/-е/-ы/-ов/-ам/-ами/-ах) ---
    r"\bпродакт(?:а|у|ом|е|ы|ов|ам|ами|ах)?\b",

    # --- продакт-менеджер / продакт менеджер / продактменеджер + все падежи ---
    r"\bпродакт[- ]?менеджер(?:а|у|ом|е|ы|ов|ам|ами|ах)?\b",

    # --- менеджер продукта / менеджер по продукту ---
    r"\bменеджер(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s+(?:по\s+)?продукт(?:а|у|ом|е|ов|ам|ами|ах)?\b",

    # --- руководитель продукта / по продукту / продуктового направления ---
    r"\bруководител(?:ь|я|ю|ем|и|ей|ям|ями|ях)\s+(?:по\s+)?продукт(?:а|у|ом|е|ов|ам|ами|ах)?\b",
    r"\bруководител(?:ь|я|ю|ем|и|ей|ям|ями|ях)\s+продуктовог[оа]\s+направлени(?:я|ю|е|ем|ях)\b",

    # --- директор по продукту / продукта ---
    r"\bдиректор(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s+(?:по\s+)?продукт(?:а|у|ом|е|ов|ам|ами|ах)?\b",

    # --- продакт-овнер / продакт-онер (включая опечатку) ---
    r"\bпродакт[- ]?о[вн]нер(?:а|у|ом|е|ы|ов|ам|ами|ах)?\b",

    # --- сленг: прод-менеджер, прод-овнер, прод-лид ---
    r"\bпрод[- ](?:менеджер|овнер|онер|лид)(?:а|у|ом|е|ы|ов|ам|ами|ах)?\b",

    # --- ML/AI/Data/Tech/Growth/Platform продакт (Russian transliteration) ---
    r"\b(?:ml|ai|дата|data|tech|growth|platform)[- ]?продакт(?:а|у|ом|е|ы|ов|ам|ами|ах)?\b",
    r"\bпродакт[- ](?:ml|ai|дата|data|tech|growth|platform)\b",

    # --- English: product manager(s) / owner(s) / lead, hyphen + concat ---
    r"\bproduct[- ]?manager(?:s)?\b",
    r"\bproduct[- ]?owner(?:s)?\b",
    r"\bproduct[- ]?lead(?:s)?\b",

    # --- ML/AI/Data/Tech/Growth/Platform product manager (English) ---
    r"\b(?:ml|ai|data|tech|growth|platform)[- ]?product[- ]?manager(?:s)?\b",
    r"\bproduct[- ]?manager[- ]?(?:ml|ai|data|tech|growth|platform)\b",

    # --- Leadership: Head/Director/VP of Product, Chief Product Officer ---
    r"\bhead\s+of\s+product\b",
    r"\bdirector\s+of\s+product\b",
    r"\bvp\s+(?:of\s+)?product\b",
    r"\bchief\s+product\s+officer\b",

    # --- Abbreviations (loose; enrich.py filters false positives) ---
    # PM / CPO / APM / SPM / GPM / TPM / PdM — avoid matching inside digits like "8pm"
    r"(?<!\d)\b(?:pm|cpo|apm|spm|gpm|tpm|pdm)\b(?!\d)",
]

VACANCY_RE = re.compile("|".join(_PATTERNS), re.IGNORECASE | re.UNICODE)


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
