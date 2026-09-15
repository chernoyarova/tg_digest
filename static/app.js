// Vacancy digest — client-side filtering, search, sort & infinite scroll.

const dataEl = document.getElementById('vacancies-data');
const data = JSON.parse(dataEl.textContent || '[]');
// The profile's tags: [{key, label}]. Each is a boolean field on a vacancy,
// a chip on the card and a "Только <label>" toggle in the filters.
const TAGS = JSON.parse(document.getElementById('digest-tags')?.textContent || '[]');
const byUid = new Map();

const state = {
  tab: '24h',
  location: 'all',
  grade: 'all',
  sort: 'date',
  tags: new Set(),   // keys of the toggles that are on; a card must have them all
  query: '',
};

const root = document.getElementById('vacancies');
const searchIndicatorEl = document.getElementById('search-indicator');
const searchIndicatorQEl = document.getElementById('search-indicator-q');
const filtersToggleEl = document.getElementById('filters-toggle');
const filtersCountEl = document.getElementById('filters-count');
const controlsEl = document.querySelector('.controls');
const resetBtnEl = document.querySelector('.reset-btn');

const FILTER_LABELS = {
  location: { all: 'Все', moscow: 'Москва', spb: 'СПб', regions: 'Регионы РФ', abroad: 'За рубежом', remote: 'Remote' },
  grade:    { all: 'Все', Head: 'Head', Lead: 'Lead', Senior: 'Senior', Middle: 'Middle', Junior: 'Junior' },
  sort:     { date: 'По дате', grade: 'По грейду' },
};

const GRADE_ORDER = { Head: 5, Lead: 4, Senior: 3, Middle: 2, Junior: 1 };

// ---------- Helpers ----------
const HOUR = 3600 * 1000;

function ageHours(iso) { return (Date.now() - new Date(iso).getTime()) / HOUR; }

function relativeTime(iso) {
  const h = ageHours(iso);
  if (h < 1) return 'JUST NOW';
  if (h < 24) return `${Math.floor(h)}H AGO`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}D AGO`;
  if (d < 30) return `${Math.floor(d / 7)}W AGO`;
  return `${Math.floor(d / 30)}MO AGO`;
}

// Vacancies split out of one roundup message share channel_id + msg_id,
// so `part` is what keeps their cards addressable separately.
function vUid(v) { return `${v.channel_id}:${v.msg_id}:${v.part || 0}`; }

// --- stats -----------------------------------------------------------------
// Counted only when the page was built with a GoatCounter site configured; the
// script is absent otherwise and every call here is a no-op. Nothing is stored
// on the reader's device and no personal data is sent — just which vacancy was
// opened, so it is visible which ones people actually go for.
function slug(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function countEvent(path, title) {
  try {
    if (window.goatcounter && typeof window.goatcounter.count === 'function') {
      window.goatcounter.count({ path, title: title || path, event: true });
    }
  } catch (e) {
    /* stats must never break the page */
  }
}

// Visitor total for the page footer. GoatCounter serves it only once public
// counts are switched on for the site, so the line stays hidden by default —
// and on any failure, rather than showing a broken or zero count.
function showVisitorCount() {
  const el = document.getElementById('visitor-count');
  const endpoint = window.GOATCOUNTER_ENDPOINT;
  if (!el || !endpoint) return;
  fetch(endpoint.replace(/\/count$/, '/counter/TOTAL.json'))
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      // count_unique is visitors; count sums every hit, events included, so it
      // would read far higher than the number of people who came.
      const readers = data.count_unique || data.count;
      if (!readers) return;
      el.textContent = `${readers} читателей`;
      el.hidden = false;
    })
    .catch(() => { /* no counter, no line */ });
}

function countVacancy(kind, v) {
  if (!v) return;
  const label = [v.title, v.company].filter(Boolean).join(' — ');
  countEvent(`${kind}/${slug(v.title) || vUid(v)}`, label);
}

// Location is free text taken from the post ("Лимасол, Кипр", "г. Воронеж,
// ул. …", "London, Hybrid"), so the region buckets go by place names. One
// that names no known place, like a bare "гибрид", only shows under "Все".
// JS \b is ASCII-only, hence the explicit Cyrillic lookarounds.
const MOSCOW_RE = /моск|moscow/;
const SPB_RE = /спб|петерб|питер|peters/;
const RU_REGION_RE = new RegExp([
  'росси', '(?<![а-яё])рф(?![а-яё])', 'russia',
  'екатеринбург', 'казан(?![а-яё]*хстан)', 'новосибирск', 'нижн[а-яё]* новгород', 'самар', 'ростов',
  'краснодар', 'воронеж', 'перм[ьи]', '(?<![а-яё])уф[аеы](?![а-яё])', 'челябинск', '(?<![а-яё])омск', 'томск',
  'тюмен', 'красноярск', 'иркутск', 'владивосток', 'хабаровск', 'калининград', 'сочи', 'адлер',
  'волгоград', 'саратов', 'ярославл', '(?<![а-яё])тул[аеы](?![а-яё])', 'рязан', 'иннополис', 'курган',
  'ижевск', 'барнаул', 'кемерово', 'оренбург', 'тольятти', 'махачкал', 'мурманск', 'архангельск',
  '(?<![а-яё])твер[ьи]', 'липецк', 'пенз[аеы]', 'ульяновск', 'чебоксар', 'белгород', 'брянск',
  '(?<![а-яё])владимир(?![а-яё])', 'калуг', 'смоленск', 'сургут', 'якутск', 'петрозаводск',
].join('|'));
// Short stems also occur inside ordinary words ("пОСЛЕ", "выСШАя",
// "поГРУЗИться"), so these must start a word.
const WORD_START = '(?<![а-яё])';
const ABROAD_RE = new RegExp([
  ...['осло', 'сша', 'грузи', 'баку', 'бали', 'манил', 'праг[аеи]', 'чехи'].map(s => WORD_START + s),
  'казахстан', 'kazakhstan', 'алмат', 'almaty', 'астан', 'astana', 'узбекистан', 'uzbekistan',
  'ташкент', 'tashkent', 'беларус', 'belarus', 'минск', 'minsk', 'кыргыз', 'киргиз', 'бишкек',
  'армени', 'armenia', 'ереван', 'yerevan', 'georgia', 'тбилиси', 'tbilisi',
  'азербайджан', 'baku', 'кипр', 'cyprus', 'лимас', 'limassol', 'никоси', 'турци', 'turkey',
  'стамбул', 'istanbul', 'оаэ', '\\buae\\b', 'дубай', 'dubai', 'серби', 'serbia', 'белград', 'belgrade',
  'черногори', 'montenegro', 'польш', 'poland', 'варшав', 'warsaw', 'герман', 'germany', 'берлин',
  'berlin', 'нидерланд', 'netherlands', 'амстердам', 'amsterdam', 'португал', 'portugal', 'лиссабон',
  'lisbon', 'испани', 'spain', 'барселон', 'barcelona', 'франци', 'france', 'великобритан',
  'united kingdom', '\\buk\\b', 'лондон', 'london', 'manchester', 'люксембург', 'финлянди',
  'хельсинки', 'норвеги', 'швеци', 'румыни', 'romania', 'bucharest',
  'израил', 'israel', 'tel aviv', '\\busa\\b', 'united states', 'san jose', 'mountain view',
  'канад', 'canada', 'панам', 'panama', 'сингапур', 'singapore', 'таиланд', 'thailand', 'бангкок',
  'bangkok', 'вьетнам', 'vietnam', 'ханой', 'индонези', 'малайзи', 'филиппин',
  'китай', 'china', 'гуанчжоу', 'гонконг', 'япони', 'европ', 'europe',
].join('|'));

function matchesLocation(v) {
  if (state.location === 'all') return true;
  if (state.location === 'remote') return v.remote === true;
  const loc = (v.location || '').toLowerCase();
  if (state.location === 'moscow') return MOSCOW_RE.test(loc);
  if (state.location === 'spb') return SPB_RE.test(loc);
  if (v.remote || !loc) return false;
  if (state.location === 'regions') {
    return RU_REGION_RE.test(loc) && !MOSCOW_RE.test(loc) && !SPB_RE.test(loc);
  }
  if (state.location === 'abroad') return ABROAD_RE.test(loc);
  return true;
}

function matchesGrade(v) {
  if (state.grade === 'all') return true;
  return v.grade === state.grade;
}

// The archive is decided against the reader's clock, like the other tabs. The
// build-time is_archived flag goes stale during the day, which left a vacancy
// just past the limit in neither "30 дней" nor "Архив" until the next build.
const ARCHIVE_HOURS = 24 * (Number(dataEl.dataset.archiveAfterDays) || 30);

function matchesTab(v) {
  const h = ageHours(v.date_iso);
  if (state.tab === 'archive') return h > ARCHIVE_HOURS;
  if (h > ARCHIVE_HOURS) return false;
  if (state.tab === '24h') return h <= 24;
  if (state.tab === '7d') return h <= 24 * 7;
  if (state.tab === '30d') return h <= 24 * 30;
  return false;
}

function matchesTags(v) {
  for (const key of state.tags) if (v[key] !== true) return false;
  return true;
}

function matchesQuery(v) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  const hay = [v.title, v.company, v.short_description, v.text, v.location, v.channel_username, v.channel_title]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function sortItems(arr) {
  const sorted = arr.slice();
  if (state.sort === 'date') {
    sorted.sort((a, b) => b.date_iso.localeCompare(a.date_iso));
  } else if (state.sort === 'grade') {
    sorted.sort((a, b) => {
      const ga = GRADE_ORDER[a.grade] || 0;
      const gb = GRADE_ORDER[b.grade] || 0;
      if (gb !== ga) return gb - ga;
      return b.date_iso.localeCompare(a.date_iso);
    });
  }
  return sorted;
}

function filtered() {
  const items = data.filter(v =>
    matchesTab(v) && matchesLocation(v) && matchesGrade(v) &&
    matchesTags(v) && matchesQuery(v)
  );
  return sortItems(items);
}

// Count items per tab (respecting all OTHER filters except tab itself).
function tabCount(tab) {
  return data.filter(v => {
    const prev = state.tab;
    state.tab = tab;
    const ok = matchesTab(v);
    state.tab = prev;
    return ok && matchesLocation(v) && matchesGrade(v) && matchesTags(v) && matchesQuery(v);
  }).length;
}

function updateTabCounts() {
  ['24h', '7d', '30d', 'archive'].forEach(t => {
    const el = document.querySelector(`[data-count="${t}"]`);
    if (el) el.textContent = tabCount(t);
  });
}

// ---------- Render ----------
function escapeHtml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Render text with clickable links: applies TG entities (covers hidden links
// like "[here](url)") then linkifies remaining plain http(s) URLs by regex.
// JS strings are UTF-16, matching TG entity offset units — slice directly.
const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

function safeHref(url) {
  const u = String(url || '').trim();
  return /^https?:\/\//i.test(u) ? u : '#';
}

function linkifyPlain(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    const url = m[0];
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function renderTextWithLinks(text, entities) {
  if (!text) return '';
  const ents = (entities || [])
    .filter(e => (e.type === 'url' || e.type === 'text_url') && e.length > 0)
    .slice()
    .sort((a, b) => a.offset - b.offset);

  let out = '';
  let cursor = 0;
  for (const e of ents) {
    if (e.offset < cursor) continue; // skip overlaps
    if (e.offset > cursor) out += linkifyPlain(text.slice(cursor, e.offset));
    const visible = text.slice(e.offset, e.offset + e.length);
    const href = e.type === 'text_url' ? e.url : visible;
    out += `<a href="${escapeHtml(safeHref(href))}" target="_blank" rel="noopener">${escapeHtml(visible)}</a>`;
    cursor = e.offset + e.length;
  }
  out += linkifyPlain(text.slice(cursor));
  return out;
}

function tagList(v) {
  const tags = [];
  if (v.grade) tags.push(`<span class="tag tag-grade">${escapeHtml(v.grade)}</span>`);
  for (const t of TAGS) {
    if (v[t.key]) tags.push(`<span class="tag tag-accent">${escapeHtml(t.label)}</span>`);
  }
  if (v.remote) tags.push('<span class="tag">Remote</span>');
  if (v.salary) tags.push(`<span class="tag">${escapeHtml(v.salary)}</span>`);
  return tags.join('');
}

function bylineLine(v) {
  const company = v.company || '';
  const location = v.location || (v.remote ? 'Remote' : '');
  if (company && location) return `<span class="byline-company">${escapeHtml(company)}</span> — ${escapeHtml(location)}.`;
  if (company) return `<span class="byline-company">${escapeHtml(company)}</span>.`;
  if (location) return escapeHtml(location) + '.';
  return '';
}

function dupesButton(v) {
  const dupes = v.duplicates || [];
  if (!dupes.length) return '';
  const items = dupes.map(d => {
    const label = d.channel_title || d.channel_username || 'канал';
    return `<a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }).join('');
  const n = dupes.length;
  const label = `Та же вакансия ещё в ${n} ${n === 1 ? 'канале' : 'каналах'}`;
  // The links sit next to the button, not inside it: interactive content
  // inside a <button> is invalid and gets flattened by screen readers.
  return `<span class="dupes"><button class="btn-dupes" type="button" aria-expanded="false" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${n}<span class="btn-dupes-icon" aria-hidden="true">↗</span></button><span class="dupes-tooltip">${items}</span></span>`;
}

function metaLine(v) {
  const channel = v.channel_username ? `@${v.channel_username}` : (v.channel_title || '');
  const parts = [];
  if (v.company) parts.push(v.company);
  if (v.location) parts.push(v.location);
  else if (v.remote) parts.push('Remote');
  if (channel) parts.push(channel);
  return parts.map(escapeHtml).join(' · ');
}

function renderCard(v) {
  const uid = vUid(v);
  const isNew = v.is_new ? 'is-new' : '';
  const channel = v.channel_username ? `@${v.channel_username}` : (v.channel_title || '');
  const byline = bylineLine(v);
  const desc = v.short_description || '';
  const tags = tagList(v);
  const dupes = dupesButton(v);

  return `
    <article class="vacancy ${isNew}" data-uid="${escapeHtml(uid)}">
      ${v.is_new ? '<div class="v-kicker mono">New</div>' : ''}
      <h2 class="v-title"><button class="v-open" type="button">${escapeHtml(v.title || '')}</button></h2>
      ${byline ? `<div class="v-byline">${byline}</div>` : ''}
      ${desc ? `<p class="v-desc">${escapeHtml(desc)}</p>` : ''}
      <div class="v-footer">
        ${tags ? `<div class="v-tags">${tags}</div>` : ''}
        <div class="v-stamp mono">
          <span>${escapeHtml(channel)}</span>
          <span class="v-stamp-sep">·</span>
          <span>${relativeTime(v.date_iso)}</span>
          ${dupes ? `<span class="v-stamp-sep">·</span>${dupes}` : ''}
        </div>
      </div>
    </article>`;
}

// ---------- Infinite scroll ----------
const BATCH_SIZE = 20;
let currentItems = [];
let renderedCount = 0;
let scrollObserver = null;

function appendBatch() {
  const next = currentItems.slice(renderedCount, renderedCount + BATCH_SIZE);
  if (!next.length) {
    if (scrollObserver) scrollObserver.disconnect();
    document.getElementById('scroll-sentinel')?.remove();
    return;
  }
  const html = next.map(renderCard).join('');
  document.getElementById('scroll-sentinel')?.remove();
  root.insertAdjacentHTML('beforeend', html);
  renderedCount += next.length;
  if (renderedCount < currentItems.length) {
    const sentinel = document.createElement('div');
    sentinel.id = 'scroll-sentinel';
    sentinel.style.cssText = 'height:1px;';
    root.appendChild(sentinel);
    scrollObserver.observe(sentinel);
  }
}

function render() {
  scrollObserver?.disconnect();
  currentItems = filtered();
  renderedCount = 0;
  root.innerHTML = '';

  // Active-search indicator next to the count.
  if (searchIndicatorEl) {
    if (state.query) {
      searchIndicatorQEl.textContent = state.query;
      searchIndicatorEl.hidden = false;
    } else {
      searchIndicatorEl.hidden = true;
    }
  }

  updateTabCounts();
  updateResetVisibility();
  updateFiltersBadge();

  if (!currentItems.length) {
    const canReset = state.location !== 'all' || state.grade !== 'all' ||
                     state.tags.size || state.query;
    root.innerHTML = `
      <div class="empty">
        <p class="empty-title">Ничего не найдено</p>
        <p class="empty-hint">${canReset
          ? 'Попробуй сбросить фильтры или сменить временной период.'
          : 'В этом окне пока пусто. Загляни в другую вкладку.'}</p>
        ${canReset ? '<button class="empty-reset" type="button" id="empty-reset">Сбросить фильтры</button>' : ''}
      </div>`;
    document.getElementById('empty-reset')?.addEventListener('click', () => {
      resetBtnEl?.click();
    });
    return;
  }

  if (!scrollObserver) {
    scrollObserver = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) appendBatch();
    }, { rootMargin: '600px 0px' });
  }
  appendBatch();
}

// ---------- Dropdowns ----------
function closeAllPopovers(except = null) {
  document.querySelectorAll('.filter-dropdown.is-open').forEach(d => {
    if (d !== except) d.classList.remove('is-open');
  });
}

function setFilterValue(filter, value) {
  state[filter] = value;
  const dropdown = document.querySelector(`[data-filter="${filter}"]`);
  const valueEl = dropdown.querySelector('.filter-value');
  valueEl.textContent = FILTER_LABELS[filter][value] || value;
  const isAllOrDate = value === 'all' || (filter === 'sort' && value === 'date');
  dropdown.classList.toggle('has-value', !isAllOrDate);
  dropdown.querySelectorAll('.popover-item').forEach(item => {
    item.classList.toggle('is-active', item.dataset.value === value);
  });
  dropdown.classList.remove('is-open');
}

document.querySelectorAll('.filter-dropdown').forEach(dropdown => {
  const trigger = dropdown.querySelector('.filter-trigger');
  const popover = dropdown.querySelector('.filter-popover');
  if (!trigger || !popover) return; // skip non-popover dropdowns (e.g. filters-toggle wrapper)
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = dropdown.classList.contains('is-open');
    closeAllPopovers();
    if (!wasOpen) dropdown.classList.add('is-open');
  });
  popover.addEventListener('click', e => {
    const item = e.target.closest('.popover-item');
    if (!item) return;
    const filter = dropdown.dataset.filter;
    if (filter === 'period') return; // handled by setPeriod() separately
    setFilterValue(filter, item.dataset.value);
    render();
  });
});

document.addEventListener('click', () => closeAllPopovers());

// ---------- Period (tabs on desktop, dropdown on mobile) ----------
const PERIOD_LABELS = { '24h': '24ч', '7d': '7 дней', '30d': '30 дней', archive: 'Архив' };

function syncPeriodUI(value) {
  state.tab = value;
  document.querySelectorAll('.tab').forEach(b => {
    const active = b.dataset.tab === value;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const dd = document.querySelector('.filter-dropdown--period');
  if (dd) {
    const valueEl = dd.querySelector('.filter-value');
    if (valueEl) valueEl.textContent = PERIOD_LABELS[value] || value;
    dd.querySelectorAll('.popover-item').forEach(item =>
      item.classList.toggle('is-active', item.dataset.value === value)
    );
    dd.classList.remove('is-open');
  }
}

function setPeriod(value) {
  syncPeriodUI(value);
  render();
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => setPeriod(btn.dataset.tab));
});

document.querySelector('.filter-dropdown--period .filter-popover')?.addEventListener('click', e => {
  const item = e.target.closest('.popover-item');
  if (!item) return;
  setPeriod(item.dataset.value);
});

// ---------- Tag toggles ----------
const tagToggles = document.querySelectorAll('input[data-tag]');
tagToggles.forEach(input => input.addEventListener('change', e => {
  if (e.target.checked) state.tags.add(e.target.dataset.tag);
  else state.tags.delete(e.target.dataset.tag);
  render();
}));

// ---------- Search ----------
const SEARCH_DEBOUNCE_MS = 150;
let searchTimer = null;
document.getElementById('search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    render();
  }, SEARCH_DEBOUNCE_MS);
});

// ---------- Reset & filters toggle ----------
function activeFilterCount() {
  let n = 0;
  if (state.location !== 'all') n++;
  if (state.grade !== 'all') n++;
  n += state.tags.size;
  return n;
}

function updateResetVisibility() {
  if (!resetBtnEl) return;
  const active = state.location !== 'all' || state.grade !== 'all' ||
                 state.tags.size || state.query || state.sort !== 'date';
  resetBtnEl.hidden = !active;
}

function updateFiltersBadge() {
  const n = activeFilterCount();
  if (n > 0) {
    filtersCountEl.textContent = '· ' + n;
    filtersCountEl.hidden = false;
    filtersToggleEl.classList.add('has-active');
  } else {
    filtersCountEl.hidden = true;
    filtersToggleEl.classList.remove('has-active');
  }
}

function setFiltersPanelOpen(open) {
  const apply = () => {
    controlsEl.classList.toggle('filters-open', open);
    filtersToggleEl.classList.toggle('is-open', open);
    filtersToggleEl.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('filters-open', open);
  };
  // View Transitions on desktop look great; on mobile the sheet has its own slide-in
  // animation, and view transitions can fight with position:fixed elements.
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  if (!isMobile && document.startViewTransition) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

function isFiltersOpen() { return controlsEl.classList.contains('filters-open'); }

filtersToggleEl.addEventListener('click', e => {
  e.stopPropagation();
  setFiltersPanelOpen(!isFiltersOpen());
});

document.addEventListener('click', e => {
  if (!isFiltersOpen()) return;
  if (e.target.closest('#filters-inline') || e.target.closest('#filters-toggle')) return;
  setFiltersPanelOpen(false);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && isFiltersOpen()) setFiltersPanelOpen(false);
});

resetBtnEl?.addEventListener('click', () => {
  setFilterValue('location', 'all');
  setFilterValue('grade', 'all');
  setFilterValue('sort', 'date');
  state.tags.clear();
  state.query = '';
  tagToggles.forEach(input => { input.checked = false; });
  document.getElementById('search-input').value = '';
  render();
});

function closeDupes(except = null) {
  document.querySelectorAll('.dupes.is-open').forEach(d => {
    if (d === except) return;
    d.classList.remove('is-open');
    d.querySelector('.btn-dupes')?.setAttribute('aria-expanded', 'false');
  });
}

// Card-level actions (event delegation). The keyboard reaches the card through
// its title button, whose Enter/Space arrive here as a click — so the dupes
// button handles its own keys instead of having them taken for the card's.
root.addEventListener('click', e => {
  // Dupes list: toggled by its button; neither it nor its links open the modal.
  const dupes = e.target.closest('.dupes');
  if (dupes) {
    const btn = e.target.closest('.btn-dupes');
    if (btn) {
      closeDupes(dupes);
      btn.setAttribute('aria-expanded', String(dupes.classList.toggle('is-open')));
    }
    return;
  }

  // Card click → open modal with full text.
  const card = e.target.closest('.vacancy');
  if (card) openModal(card.dataset.uid);
});

// Close dupes tooltip when clicking outside.
document.addEventListener('click', e => {
  if (!e.target.closest('.dupes')) closeDupes();
});

// ---------- Modal ----------
const overlayEl = document.getElementById('modal-overlay');
const modalContentEl = document.getElementById('modal-content');
const modalCloseEl = document.getElementById('modal-close');
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea';
let modalOpenerEl = null;

function openModal(uid) {
  const v = byUid.get(uid);
  if (!v) return;
  countVacancy('card-open', v);
  modalOpenerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalContentEl.innerHTML = renderModalContent(v);
  overlayEl.hidden = false;
  document.body.classList.add('modal-open');
  modalCloseEl.focus();
}

function closeModal() {
  if (overlayEl.hidden) return;
  overlayEl.hidden = true;
  document.body.classList.remove('modal-open');
  modalContentEl.innerHTML = '';
  // Return focus to the card (or whatever element opened the modal) so keyboard
  // users don't get dropped at the top of the page.
  if (modalOpenerEl && document.contains(modalOpenerEl)) {
    modalOpenerEl.focus();
  }
  modalOpenerEl = null;
}

// Focus trap: cycle Tab/Shift+Tab within the modal while it's open.
overlayEl.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const focusables = overlayEl.querySelectorAll(FOCUSABLE_SELECTOR);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

function renderModalContent(v) {
  const date = new Date(v.date_iso);
  const dateStr = date.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  const channel = v.channel_username ? `@${v.channel_username}` : (v.channel_title || '');
  const byline = bylineLine(v);
  const tags = tagList(v);
  const dupes = (v.duplicates || []).map(d => {
    const label = d.channel_title || d.channel_username || 'канал';
    return `<a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }).join('');

  return `
    <div class="modal-meta-bar mono">
      ${v.is_new ? '<span class="modal-meta-new">New</span><span class="modal-meta-sep">·</span>' : ''}
      <span>${escapeHtml(channel)}</span>
      <span class="modal-meta-sep">·</span>
      <span>${escapeHtml(dateStr)}</span>
    </div>
    <h2 class="modal-title" id="modal-title">${escapeHtml(v.title || '')}</h2>
    ${byline ? `<div class="modal-byline">${byline}</div>` : ''}
    ${tags ? `<div class="v-tags modal-tags">${tags}</div>` : ''}
    <div class="modal-text${(v.text || '').includes('\n') ? '' : ' modal-text--line'}">${renderTextWithLinks(v.text || '', v.entities)}</div>
    <div class="modal-actions">
      <a class="btn-open" href="${escapeHtml(v.link)}" target="_blank" rel="noopener"
         data-count-uid="${escapeHtml(vUid(v))}">Открыть в Telegram →</a>
    </div>
    ${dupes ? `<div class="modal-dupes"><div class="modal-dupes-label mono">Также в:</div>${dupes}</div>` : ''}
  `;
}

modalContentEl.addEventListener('click', e => {
  const link = e.target.closest('[data-count-uid]');
  if (link) countVacancy('tg-open', byUid.get(link.dataset.countUid));
});

modalCloseEl.addEventListener('click', closeModal);
overlayEl.addEventListener('click', e => {
  if (e.target === overlayEl) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeModal();
  closeDupes();
});

// ---------- Boot ----------
// Runs before any filter is set, so tabCount() counts the whole tab.
function pickInitialTab() {
  if (tabCount('24h')) return '24h';
  if (tabCount('7d')) return '7d';
  return '30d';
}

data.forEach(v => byUid.set(vUid(v), v));

syncPeriodUI(pickInitialTab());
render();
showVisitorCount();
