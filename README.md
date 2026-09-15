# tg_digest

**Your personal vacancy radar — built on Telegram, served on GitHub Pages, no AI API required.**

Forget scrolling through twelve job channels every morning. `tg_digest` watches a folder of Telegram channels, filters out everything that isn't a vacancy, pulls out the structured stuff (company, grade, salary, remote, stack tags) with a set of rules, kills duplicates, and serves you a clean, searchable, filterable digest. Every morning. On autopilot. For free — the only credentials it needs are Telegram's.

It was built for Product Manager jobs and ships with that profile, plus a `frontend` one. What makes it a digest of one role rather than another is a single YAML file — see [Other roles](#other-roles).

**[Live demo →](https://chernoyarova.github.io/tg_digest/)**

![Desktop and mobile view](docs/screenshots/hero.png)

---

## Why this exists

Twelve Telegram channels post 50+ job posts a day. Maybe two of them are actually relevant. Reading all of them by hand is the worst part of looking for a Product job.

`tg_digest` solves exactly that one problem:

- **One page, all channels, deduplicated.** A vacancy that got cross-posted to four channels shows up once.
- **Filter, don't scroll.** Filters by grade, location, remote, ML/AI focus. Search across company and full text.
- **Real source, one click away.** Click any card → the full original Telegram post opens in a modal, with all links from the post (including hidden ones) clickable.
- **Smart enough to know what's a job.** A two-stage filter (role regex → hiring-signal rules) keeps most of the noise out. Job-seeker posts, courses, and promo posts don't make it in.

## What you get

| Feature | What it does |
|---|---|
| **Daily auto-digest** | Runs every morning via GitHub Actions (scheduled for 06:23 MSK; GitHub often starts such runs a few hours late). Zero ongoing maintenance. |
| **Cross-channel dedup** | Same vacancy in 4 channels = one card with a `×4` badge listing all sources. |
| **Extracted metadata** | Company, grade (Junior → Head), location, salary, remote flag, tags (ML/AI for product; React / Vue / TypeScript for frontend) — parsed out of the post text by rules in `enrich.py`. No LLM, nothing generated. |
| **Roundups, split** | A post listing five vacancies becomes five cards, whether they are blocks of text or one-liners linking to the posting. |
| **Any role** | The role is a profile: a YAML of regexes for the titles you want, the neighbouring ones you don't, and the tags. Two ship; copying one is how you make your own. |
| **Full text + clickable links** | Tap a card → modal with the full TG post and every link (including hidden `[text](url)` ones) preserved. |
| **Bounded store** | Vacancies drop out after `purge_after_days`. Nothing else deletes them, so without it the page grows for ever — the data is embedded in it. |
| **NEW badge for fresh posts** | Anything posted in the last 24h gets a NEW tag, so you spot what changed since yesterday. |
| **Mobile-first** | The whole UI works on a phone. The desktop layout is the bonus, not the other way around. |
| **Free to run** | GitHub Pages + GitHub Actions free tier. No paid API at all. |

---

## How it works

A six-step pipeline. Each step reads a JSON file from `data/` and writes the next one — so any step can be debugged in isolation.

```
fetch_tg  →  parse  →  enrich  →  deduplicate  →  state  →  render
 Telethon    regex     rules     SequenceMatcher   NEW     Jinja2
```

1. **`fetch_tg`** — reads a Telegram folder via Telethon. Adding a channel to the folder in TG auto-includes it next run. Captures message entities so hidden links (`[click here](https://...)`) survive.
2. **`parse`** — fast regex prefilter: keeps posts that name the role (patterns from the profile).
3. **`enrich`** — second-stage filter plus field extraction, entirely rule-based: keyword rules decide whether a post is a real opening, then regexes pull out title, company, grade, location, salary, remote flag and tags. Roundup posts are split into one card per vacancy. `short_description` is an excerpt of the post itself — nothing is generated.
4. **`deduplicate`** — `difflib.SequenceMatcher` on normalized text. Merges duplicates across channels into one card with all source links.
5. **`state`** — marks posts as NEW (< 24h, unseen before) or archived (> 30d).
6. **`render`** — Jinja2 template + inline JSON → a single static `index.html`. Client-side filtering, search, infinite scroll.

## Tech stack

- **Backend pipeline:** Python 3.11+, [Telethon](https://github.com/LonamiWebs/Telethon), Jinja2. No LLM API.
- **Frontend:** Plain JavaScript + CSS, no framework. Search/filter/sort/modal all client-side.
- **Infra:** GitHub Actions (daily cron) + GitHub Pages (static hosting). Zero servers.

---

## Run it yourself

### 1. Clone and install

```bash
git clone https://github.com/<you>/tg_digest.git
cd tg_digest
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in API keys (see below)
```

### 2. Get Telegram API credentials

1. Go to https://my.telegram.org → API Development Tools → create an app.
2. Copy `api_id` and `api_hash` into `.env` as `TG_API_ID` and `TG_API_HASH`.

### 3. Generate a Telegram session (one-time)

```bash
python scripts/generate_session.py
```

Asks for your phone number, login code from Telegram, and 2FA password if you have one. Prints a base64 `StringSession`. Paste it into `.env` as `TG_SESSION_B64` (and into GitHub Secrets later for CI).

### 4. Tell it which channels to read

In your Telegram app, create a folder (default name: `vacancy`) and add the channels you want to track. The pipeline reads whatever is currently in that folder — no separate channel list to maintain.

### 5. Run

```bash
python scripts/main.py
open index.html
```

That's it. You now have your own digest.

## Deploy on GitHub Pages

1. Push to GitHub.
2. **Settings → Secrets and variables → Actions** → add the three secrets below:

| Secret | Where to get it |
|---|---|
| `TG_API_ID` | https://my.telegram.org |
| `TG_API_HASH` | https://my.telegram.org |
| `TG_SESSION_B64` | Output of `generate_session.py` |

3. Run the **digest** workflow once (**Actions → digest → Run workflow**). It creates the `gh-pages` branch.
4. **Settings → Pages** → set source to the `gh-pages` branch, root.

The workflow runs the pipeline daily and publishes the result to `gh-pages`: `index.html`, `static/`, and the pipeline state in `data/` (`vacancies.json`, `history.json`), which the next run reads back. The branch is replaced by a single commit each time, so the daily rebuilds do not pile up in the repository's history. `main` holds only code.

To run locally on top of the published state instead of a fresh 30-day backfill:

```bash
git fetch origin gh-pages
git show origin/gh-pages:data/vacancies.json > data/vacancies.json
git show origin/gh-pages:data/history.json > data/history.json
```

## Configuration

`config/sources.yml`:

```yaml
profile: product               # which profiles/<name>.yml to use
tg_folder_name: vacancy        # the Telegram folder to watch
initial_backfill_days: 30      # how far back the first run reaches
archive_after_days: 30         # vacancies older than this move to Archive tab
purge_after_days: 90           # ...and older than this are dropped for good
new_window_hours: 24           # how recent counts as NEW
ignore_lines: []               # regexes for lines a channel repeats in every post
```

`ignore_lines` is for channels that end every post with the same navigation row or ad. Such a line would otherwise become a title or land in the description; listed here, it is skipped when the card is built (the modal still shows the post whole). For example:

```yaml
ignore_lines:
  - '^Вакансии\s*│'
  - 'первый ai ассистент'
```

### Other roles

Everything about *which* jobs the digest is for lives in `profiles/<name>.yml`, and `profile:` in `sources.yml` picks the file. The pipeline itself — reading the folder, telling a hiring post from a course ad, dedup, NEW/archive, the page — is the same for any role.

To make a digest for, say, QA engineers:

1. Copy `profiles/frontend.yml` to `profiles/qa.yml` and edit:
   - `roles.patterns` — regexes that name the role and nothing else (`\bqa\b`, `тестировщик\w*`, `test automation`…). A post is looked at only if one matches somewhere in it.
   - `roles.loose` — spellings that mean this role as often as another one; they let a post in, but do not settle its role.
   - `roles.exclude` — neighbouring roles. A card whose title names one of these, and none of yours, is dropped. This is where most of the precision comes from: for frontend it is backend, mobile, QA; for QA it would be developers and analysts.
   - `roles.hint` — words that mark a headline inside a roundup post as yours.
   - `grades_extra` — level words specific to the role (`head of qa`); the generic ones (senior, lead, стажёр…) are built in.
   - `tags` — each becomes a chip on the card and a "Только …" toggle in the filters. Stack, domain, whatever you filter by.
   - `site.title` / `site.tagline` — the headline of the page.
2. Set `profile: qa` in `config/sources.yml`, and point `tg_folder_name` at a folder with the channels.
3. Run `python scripts/main.py` and look at the cards. Every post the rules drop, and why, is easy to trace: `parse.matches(text)`, then `enrich.is_vacancy(...)`, then `enrich.is_role_title(title)`.

The `product` profile has been tuned on real channels for months; `frontend` for a shorter while, on three channels. A fresh profile will need a few rounds of looking at what came through and what did not — that is the trade-off for running without an LLM.

Grade is only set when the post names a level, so it stays empty more often than an LLM would leave it. Cards without a grade still show up under the "Все" filter.

### Visit stats (optional, off by default)

The page can report how many people open it and which vacancies they click
through to. It uses [GoatCounter](https://www.goatcounter.com): free for
personal sites, ~3 KB, no cookies and so no consent banner.

1. Register a site at https://www.goatcounter.com — you pick a name, and get
   `<name>.goatcounter.com`.
2. Put that name in `config/sources.yml` as `goatcounter_site`.

The next run picks it up. While the field is empty no analytics script is
added to the page at all, and nothing is sent anywhere.

Two events are recorded besides the page visit: `card-open/<vacancy>` when a
card is opened, and `tg-open/<vacancy>` when the reader follows the link to
Telegram — so the dashboard shows which vacancies people actually go for.

The footer can also show the visitor total to everyone. That needs
**Settings → "Allow adding visitor counts to your site"** switched on in
GoatCounter; until then (or if the request fails) the line stays hidden.

`scripts/enrich.py` — the role-agnostic part of the rules: `HIRING_RE` / `PROMO_RE` / `SEEKER_RE` decide what counts as a hiring post, `CITIES`, `MONEY_RE`, `REMOTE_RE` and friends do the extraction, `split_digest` takes roundups apart. Tune these for your channels' style; tune the profile for the role.

---

## License

MIT. Use it, fork it, make it yours.
