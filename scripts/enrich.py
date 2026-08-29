"""Stage-2 filter + field extraction. Rule-based, no LLM API involved.

Every field the frontend needs (title, company, location, grade, salary,
remote/ML flags, short description) is derived from the post text with regexes
and keyword lists. No external API is called, so the pipeline runs with the
Telegram credentials alone.

The trade-off vs. the previous LLM-based step: the filter is a little more
permissive (a few non-vacancy posts slip through) and company/location are
left null more often. Nothing generates text — short_description is an
extract of the post itself.

Input:  data/parsed.json
Output: data/enriched.json
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

from parse import VACANCY_RE

ROOT = Path(__file__).resolve().parent.parent
PARSED_PATH = ROOT / "data" / "parsed.json"
ENRICHED_PATH = ROOT / "data" / "enriched.json"

MIN_TEXT_LEN = 120
TITLE_MAX_LEN = 120
DESC_MAX_LEN = 320

# --- text cleaning -----------------------------------------------------------

MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:[^)]+)\)")
URL_RE = re.compile(r"https?://\S+|t\.me/\S+|@[A-Za-z0-9_]{4,}")
MD_MARKS_RE = re.compile(r"[*_~`]{1,3}")
HASHTAG_RE = re.compile(r"#\S+")
BULLET_RE = re.compile(r"^[\s\-–—•·▪️✔️✅➡️👉>»\|]+")
WS_RE = re.compile(r"[ \t]+")


def _strip_symbols(text: str) -> str:
    """Drop emoji and other symbol/format codepoints, keep normal punctuation."""
    return "".join(
        ch for ch in text
        if ch in "\n\t "
        or not unicodedata.category(ch) in ("So", "Sk", "Cf", "Cs", "Co")
    )


def _clean(text: str, *, drop_urls: bool = True) -> str:
    text = (text or "").replace("\xa0", " ").replace("\u2009", " ")
    text = MD_LINK_RE.sub(r"\1", text)
    if drop_urls:
        text = URL_RE.sub("", text)
    text = HASHTAG_RE.sub("", text)
    text = MD_MARKS_RE.sub("", text)
    text = _strip_symbols(text)
    text = WS_RE.sub(" ", text)
    return text.strip()


def _clean_line(line: str) -> str:
    return _clean(BULLET_RE.sub("", line)).strip(" -–—:|·•")


def _lines(text: str) -> list[str]:
    return [ln for ln in (_clean_line(l) for l in (text or "").splitlines()) if ln]


# Channel-level headers some feeds prepend to every post ("Новые вакансии …").
# They are not part of the vacancy and would poison title/grade/location.
HEADER_RE = re.compile(
    r"^(?:нов\w+|свеж\w+|актуальн\w+|топ)?\s*(?:ваканси\w+|подборк\w+|дайджест)\b"
    r"|^ваканси\w+\s+(?:дня|недели)\b|^#\w+$",
    re.IGNORECASE | re.UNICODE,
)


def _body(text: str) -> str:
    """Post text without the channel's boilerplate header line."""
    lines = (text or "").split("\n")
    while lines:
        first = _clean_line(lines[0])
        if not first:
            lines = lines[1:]
            continue
        if len(first) <= 60 and HEADER_RE.match(first) and len(_lines("\n".join(lines))) > 1:
            lines = lines[1:]
            continue
        break
    return "\n".join(lines)


# --- stage-2 filter ----------------------------------------------------------

HIRING_RE = re.compile(
    r"вакансия|ваканси[июя]|ищем|ищет|в поиске|нанима|требуется|открыт[аы] (?:позици|ваканси)"
    r"|присоедин|откликн|отклик|резюме|обязанност|требовани|ожидани|условия|мы предлагаем"
    r"|что мы предлагаем|задачи|стек|оффер|зарплат|з/п|вилка|формат работы|график"
    r"|we are hiring|we're hiring|is hiring|looking for|join (?:our|the) team|apply"
    r"|responsibilit|requirement|what we offer|job opening",
    re.IGNORECASE | re.UNICODE,
)

# Posts where the *author* is looking for a job, not offering one.
SEEKER_RE = re.compile(
    r"ищу работу|ищу вакансию|ищу позицию|рассматриваю (?:офферы|предложения|вакансии)"
    r"|в активном поиске работы|открыт[а]? к предложениям|my resume|open to work|#ищуработу",
    re.IGNORECASE | re.UNICODE,
)

# Ads / courses / promo. Only checked against the opening of the post, where
# such posts announce themselves; a vacancy that merely mentions "курс" as the
# product it builds is not dropped.
PROMO_RE = re.compile(
    r"курс|вебинар|интенсив|марафон|бесплатн\w* (?:урок|занятие|вебинар|мастер-класс)"
    r"|разбор резюме|карьерн\w+ консультаци|менторств|реклама|erid|розыгрыш|промокод"
    r"|подборка вакансий|дайджест",
    re.IGNORECASE | re.UNICODE,
)


def is_vacancy(text: str) -> bool:
    """Rule-based stand-in for the old LLM classifier."""
    text = text or ""
    if len(text) < MIN_TEXT_LEN:
        return False
    if not VACANCY_RE.search(text):
        return False
    if SEEKER_RE.search(text):
        return False
    if PROMO_RE.search(text[:200]):
        return False
    return bool(HIRING_RE.search(text))


# --- field extraction --------------------------------------------------------

TITLE_NOISE_RE = re.compile(
    r"^(?:вакансия|ваканси[яи]|новая вакансия|открыта вакансия|ищем|ищется|job|vacancy|position)"
    r"\s*[:\-–—]?\s*",
    re.IGNORECASE | re.UNICODE,
)


def _title(text: str) -> str:
    candidates = _lines(text)[:6]
    for line in candidates:
        line = TITLE_NOISE_RE.sub("", line).strip()
        if 3 <= len(line) <= TITLE_MAX_LEN and VACANCY_RE.search(line):
            return line
    for line in candidates:
        line = TITLE_NOISE_RE.sub("", line).strip()
        if len(line) >= 3:
            return line[:TITLE_MAX_LEN].rstrip()
    return "Вакансия"


COMPANY_FIELD_RE = re.compile(
    r"^(?:компания|company|работодатель)\s*[:—–-]?\s+(.+)$",
    re.IGNORECASE | re.UNICODE,
)
COMPANY_ACTION_RE = re.compile(
    r"(?:^|\n)[^\S\n]*([«\"']?[A-ZА-ЯЁ][\w&.\-]*(?:[^\S\n]+[A-ZА-ЯЁ0-9][\w&.\-]*){0,2}[»\"']?)"
    r"[^\S\n]+(?:ищет|ищем|в поиске|нанимает|is hiring|is looking for)",
    re.UNICODE,
)
COMPANY_IN_TITLE_RE = re.compile(
    r"\s(?:в компанию|в|to|at|@|—|–|\|)\s+([«\"']?[\w&.\-]+(?:\s+[\w&.\-]+){0,3}[»\"']?)\s*$",
    re.IGNORECASE | re.UNICODE,
)
COMPANY_STOPWORDS = {
    "команду", "команда", "компанию", "компания", "поиске", "продукт", "проект",
    "стартап", "офис", "москву", "россию", "нас", "работу", "нашу", "нашей",
    "мы", "я", "наша", "наше", "наши", "сейчас", "также", "сюда", "вакансия",
    "ищем", "ищет", "кого", "кто",
    "team", "product", "remote", "office", "us", "we", "our", "vacancy", "this",
}


def _tidy_company(raw: str | None) -> str | None:
    if not raw:
        return None
    name = _clean(raw).split("\n")[0].strip(" «»\"'.,;:!?()-–—")
    name = re.split(r"[,;(]| - | – | — ", name)[0].strip()
    if not name or len(name) > 45:
        return None
    if name.lower() in COMPANY_STOPWORDS:
        return None
    if not re.search(r"[A-Za-zА-Яа-яЁё]", name):
        return None
    # A company name has at most a few words.
    if len(name.split()) > 4:
        return None
    return name


def _company(text: str, title: str) -> str | None:
    for line in _lines(text)[:15]:
        match = COMPANY_FIELD_RE.match(line)
        if match:
            company = _tidy_company(match.group(1))
            if company:
                return company
    match = COMPANY_IN_TITLE_RE.search(title)
    if match:
        company = _tidy_company(match.group(1))
        if company:
            return company
    match = COMPANY_ACTION_RE.search(text)
    if match:
        return _tidy_company(match.group(1))
    return None


CITIES: list[tuple[str, str]] = [
    (r"москв\w*|moscow", "Москва"),
    (r"санкт[- ]петербург\w*|спб\b|питер\w*|st\.? ?petersburg", "СПб"),
    (r"новосибирск\w*", "Новосибирск"),
    (r"екатеринбург\w*", "Екатеринбург"),
    (r"казан[ьи]\b", "Казань"),
    (r"нижн\w+ новгород\w*", "Нижний Новгород"),
    (r"минск\w*", "Минск"),
    (r"алмат\w+|алма-ат\w+", "Алматы"),
    (r"астан\w+|нур-султан", "Астана"),
    (r"ташкент\w*", "Ташкент"),
    (r"тбилиси", "Тбилиси"),
    (r"ереван\w*", "Ереван"),
    (r"баку", "Баку"),
    (r"бишкек\w*", "Бишкек"),
    (r"белград\w*|сербии|сербия", "Белград"),
    (r"варшав\w*|польш\w+", "Варшава"),
    (r"берлин\w*|герман\w+", "Берлин"),
    (r"лондон\w*", "Лондон"),
    (r"амстердам\w*|нидерланд\w+", "Амстердам"),
    (r"лиссабон\w*|португал\w+", "Лиссабон"),
    (r"дубай|оаэ|uae", "Дубай"),
    (r"лимассол\w*|никоси\w*|кипр\w*|cyprus", "Кипр"),
    (r"стамбул\w*|турци\w+", "Стамбул"),
]
CITY_RES = [(re.compile(rf"\b(?:{pat})", re.IGNORECASE | re.UNICODE), name) for pat, name in CITIES]

LOCATION_FIELD_RE = re.compile(
    r"(?:^|\n)\s*(?:локация|город|офис|место работы|формат(?: работы)?|location|office)"
    r"\s*[:—–-]\s*(.+)",
    re.IGNORECASE | re.UNICODE,
)

REMOTE_RE = re.compile(
    r"удал[её]нк\w*|удал[её]нн\w*|удал[её]нно|remote|fully distributed"
    r"|work from anywhere|из любой точки|дистанционн\w*",
    re.IGNORECASE | re.UNICODE,
)
NOT_REMOTE_RE = re.compile(
    r"(?:не|без|нет)\s+(?:удал[её]нк\w*|удал[её]нн\w*|remote)|no remote|not remote",
    re.IGNORECASE | re.UNICODE,
)


def _remote(text: str) -> bool:
    if NOT_REMOTE_RE.search(text or ""):
        return False
    return bool(REMOTE_RE.search(text or ""))


def _location(text: str, remote: bool) -> str | None:
    match = LOCATION_FIELD_RE.search(text)
    if match:
        value = _clean_line(match.group(1))[:60].strip(" .,;")
        if value:
            return value
    # Cities are searched in the title and the short lines near the top of the
    # post — a city named deep inside the body is usually not the job location.
    head_lines = _lines(text)[:8]
    haystack = "\n".join(
        line for i, line in enumerate(head_lines) if i == 0 or len(line) <= 80
    )
    cities = []
    for city_re, name in CITY_RES:
        if city_re.search(haystack) and name not in cities:
            cities.append(name)
        if len(cities) == 2:
            break
    if cities:
        head = " / ".join(cities)
        return f"{head}, удалённо" if remote else head
    return "Remote" if remote else None


GRADE_PATTERNS: list[tuple[str, str]] = [
    ("Head", r"head of product|chief product officer|\bcpo\b|vp,? (?:of )?product"
             r"|директор по продукт\w*|продуктов\w+ директор|head\b"),
    ("Lead", r"\blead\b|team ?lead|продакт[- ]лид|\bлид\b|principal|ведущий|ведущего"
             r"|group product manager|\bgpm\b|руководител\w+ продукт\w*"),
    ("Senior", r"\bsenior\b|\bsr\.?\b|сеньор\w*|синьор\w*|старший|старшего"),
    ("Middle", r"\bmiddle\b|\bmid\b|мидл\w*|миддл\w*"),
    ("Junior", r"\bjunior\b|\bjun\b|\bintern\b|джуниор\w*|джун\w*|стаж[её]р\w*|стажировк\w*"),
]
GRADE_RES = [(name, re.compile(pat, re.IGNORECASE | re.UNICODE)) for name, pat in GRADE_PATTERNS]


def _grade(text: str, title: str) -> str | None:
    for haystack in (title, text):
        for name, grade_re in GRADE_RES:
            if grade_re.search(haystack or ""):
                return name
    return None


ML_RE = re.compile(
    r"\bml\b|\bai\b|\bllm\b|\bgpt\b|\bnlp\b|ml[- ](?:продакт|platform|ops)|ai[- ]продакт"
    r"|машинн\w+ обучени\w*|искусственн\w+ интеллект\w*|нейросет\w*|нейронн\w+ сет\w*"
    r"|data scien\w*|дата[- ]сайенс|рекомендательн\w+ систем\w*|генеративн\w*",
    re.IGNORECASE | re.UNICODE,
)


def _ml_ai(text: str, title: str) -> bool:
    if ML_RE.search(title or ""):
        return True
    body = text or ""
    if ML_RE.search(body[:300]):
        return True
    # A single passing mention ("use AI tools") is not an ML/AI role.
    return len(ML_RE.findall(body)) >= 3


SALARY_KEYWORD_RE = re.compile(
    r"зарплат\w*|з/?п\b|вилк\w*|оклад\w*|доход\w*|компенсаци\w*|salary|compensation|на руки|gross|net",
    re.IGNORECASE | re.UNICODE,
)
MONEY_RE = re.compile(
    r"(?:от\s*)?[$€]?\s?\d[\d\s .,]{2,}(?:\s*(?:[–—-]|до)\s*[$€]?\s?\d[\d\s .,]{2,})?"
    r"\s*(?:000)?\s*(?:₽|руб\w*|р\.|k\b|к\b|тыс\w*|\$|usd|eur|€)",
    re.IGNORECASE | re.UNICODE,
)


def _salary(text: str) -> str | None:
    for line in (text or "").splitlines():
        clean = _clean_line(line)
        if not clean:
            continue
        match = MONEY_RE.search(clean)
        if not match:
            continue
        # Either the line says it is about money, or it is a short line that
        # opens with the amount (the usual "💰 От 250 000 ₽" formatting).
        if not (SALARY_KEYWORD_RE.search(clean) or (len(clean) <= 80 and match.start() <= 3)):
            continue
        value = WS_RE.sub(" ", match.group(0)).strip(" .,;:")
        if 2 < len(value) <= 40:
            return value
    return None


SECTION_HEADER_RE = re.compile(
    r"^(?:что|чем|кого|кому|о нас|о компании|обязанност|требовани|ожидани|условия|задачи"
    r"|мы предлагаем|наш стек|бонусы|плюсы|формат|локация|зарплат|контакт|как откликнут"
    r"|responsibilit|requirement|what|about|benefits|stack|contact)",
    re.IGNORECASE | re.UNICODE,
)
CONTACT_RE = re.compile(
    r"пиши|напиши|откликн|резюме|контакт|телеграм|телеграмм|tg:|dm\b|apply|cv\b|writ[ei]",
    re.IGNORECASE | re.UNICODE,
)


def _short_description(text: str, title: str) -> str:
    body: list[str] = []
    for line in _lines(text)[1:]:
        if len(line) < 40:
            continue
        if SECTION_HEADER_RE.match(line) or CONTACT_RE.search(line):
            continue
        body.append(line)
        if sum(len(b) for b in body) > DESC_MAX_LEN * 2:
            break
    if not body:
        return ""
    joined = " ".join(body)
    sentences = re.split(r"(?<=[.!?])\s+", joined)
    out = ""
    for sentence in sentences:
        if not out:
            out = sentence
        elif len(out) + len(sentence) + 1 <= DESC_MAX_LEN:
            out = f"{out} {sentence}"
        else:
            break
    if len(out) > DESC_MAX_LEN:
        out = out[:DESC_MAX_LEN].rsplit(" ", 1)[0] + "…"
    return out.strip()


def _strip_company_suffix(title: str, company: str | None) -> str:
    """'Product Manager в Acme' -> 'Product Manager' once company is known."""
    if not company:
        return title
    trimmed = re.sub(
        rf"\s*(?:в компанию|в|to|at|@|—|–|\|)\s+[«\"']?{re.escape(company)}[»\"']?\s*$",
        "",
        title,
        flags=re.IGNORECASE | re.UNICODE,
    ).strip(" -–—|,")
    return trimmed if len(trimmed) >= 3 else title


def extract(text: str) -> dict:
    """Derive the vacancy card fields from the post text. No API calls."""
    body = _body(text)
    title = _title(body)
    remote = _remote(body)
    company = _company(body, title)
    title = _strip_company_suffix(title, company)
    return {
        "is_vacancy": True,
        "title": title,
        "company": company,
        "location": _location(body, remote),
        "grade": _grade(body, title),
        "ml_ai": _ml_ai(body, title),
        "remote": remote,
        "salary": _salary(body),
        "short_description": _short_description(body, title),
    }


def run() -> None:
    posts = json.loads(PARSED_PATH.read_text(encoding="utf-8"))
    if not posts:
        ENRICHED_PATH.write_text("[]", encoding="utf-8")
        print("[enrich] no posts to enrich")
        return

    enriched: list[dict] = []
    for i, post in enumerate(posts, 1):
        text = post.get("text", "")
        if not is_vacancy(text):
            continue
        enriched.append({**post, **extract(text)})
        if i % 50 == 0:
            print(f"[enrich] {i}/{len(posts)} processed, kept={len(enriched)}")

    ENRICHED_PATH.write_text(
        json.dumps(enriched, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"[enrich] kept {len(enriched)}/{len(posts)} as vacancies -> {ENRICHED_PATH}")


if __name__ == "__main__":
    run()
