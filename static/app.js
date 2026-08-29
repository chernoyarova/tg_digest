// Vacancy digest — client-side filtering, search, sort & infinite scroll.

const data = JSON.parse(document.getElementById('vacancies-data').textContent || '[]');
const byUid = new Map();

const state = {
  tab: '24h',
  location: 'all',
  grade: 'all',
  sort: 'date',
  mlOnly: false,
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
  location: { all: 'Все', moscow: 'Москва', spb: 'СПб', regions: 'Регионы', remote: 'Remote' },
  grade:    { all: 'Все', Lead: 'Lead', Head: 'Head', Senior: 'Senior', Middle: 'Middle' },
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

function matchesLocation(v) {
  if (state.location === 'all') return true;
  if (state.location === 'remote') return v.remote === true;
  const loc = (v.location || '').toLowerCase();
  if (state.location === 'moscow') return loc.includes('моск') || loc.includes('moscow');
  if (state.location === 'spb') return loc.includes('спб') || loc.includes('петерб') || loc.includes('peters');
  if (state.location === 'regions') {
    if (v.remote) return false;
    if (!loc) return false;
    if (loc.includes('моск') || loc.includes('спб') || loc.includes('петерб')) return false;
    return true;
  }
  return true;
}

function matchesGrade(v) {
  if (state.grade === 'all') return true;
  return v.grade === state.grade;
}

function matchesTab(v) {
  if (state.tab === 'archive') return v.is_archived === true;
  if (v.is_archived) return false;
  const h = ageHours(v.date_iso);
  if (state.tab === '24h') return h <= 24;
  if (state.tab === '7d') return h <= 24 * 7;
  if (state.tab === '30d') return h <= 24 * 30;
  return false;
}

function matchesMl(v) { return state.mlOnly ? v.ml_ai === true : true; }

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
    matchesMl(v) && matchesQuery(v)
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
    return ok && matchesLocation(v) && matchesGrade(v) && matchesMl(v) && matchesQuery(v);
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
  if (v.ml_ai) tags.push('<span class="tag tag-ml">ML/AI</span>');
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
  return `<button class="btn-dupes" type="button" data-action="dupes" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${n}<span class="btn-dupes-icon" aria-hidden="true">↗</span><span class="dupes-tooltip">${items}</span></button>`;
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
    <article class="vacancy ${isNew}" data-uid="${escapeHtml(uid)}" role="button" tabindex="0">
      ${v.is_new ? '<div class="v-kicker mono">New</div>' : ''}
      <h2 class="v-title">${escapeHtml(v.title || '')}</h2>
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
                     state.mlOnly || state.query;
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

// ---------- ML toggle ----------
document.getElementById('ml-toggle').addEventListener('change', e => {
  state.mlOnly = e.target.checked;
  render();
});

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
  if (state.mlOnly) n++;
  return n;
}

function updateResetVisibility() {
  if (!resetBtnEl) return;
  const active = state.location !== 'all' || state.grade !== 'all' ||
                 state.mlOnly || state.query || state.sort !== 'date';
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
  state.mlOnly = false;
  state.query = '';
  document.getElementById('ml-toggle').checked = false;
  document.getElementById('search-input').value = '';
  render();
});

// Card-level actions (event delegation).
root.addEventListener('click', e => {
  // Dupes tooltip — handle separately and don't open the modal.
  const dupesBtn = e.target.closest('[data-action="dupes"]');
  if (dupesBtn) {
    if (e.target.closest('a')) return; // link inside tooltip — let it through
    document.querySelectorAll('.btn-dupes.is-open').forEach(b => {
      if (b !== dupesBtn) b.classList.remove('is-open');
    });
    dupesBtn.classList.toggle('is-open');
    e.stopPropagation();
    return;
  }

  // Card click → open modal with full text.
  const card = e.target.closest('.vacancy');
  if (card) openModal(card.dataset.uid);
});

root.addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.vacancy');
  if (!card) return;
  e.preventDefault();
  openModal(card.dataset.uid);
});

// Close dupes tooltip when clicking outside.
document.addEventListener('click', e => {
  if (!e.target.closest('.btn-dupes')) {
    document.querySelectorAll('.btn-dupes.is-open').forEach(b => b.classList.remove('is-open'));
  }
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
    <div class="modal-text">${renderTextWithLinks(v.text || '', v.entities)}</div>
    <div class="modal-actions">
      <a class="btn-open" href="${escapeHtml(v.link)}" target="_blank" rel="noopener">Открыть в Telegram →</a>
    </div>
    ${dupes ? `<div class="modal-dupes"><div class="modal-dupes-label mono">Также в:</div>${dupes}</div>` : ''}
  `;
}

modalCloseEl.addEventListener('click', closeModal);
overlayEl.addEventListener('click', e => {
  if (e.target === overlayEl) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ---------- Boot ----------
function pickInitialTab() {
  const counts = {
    '24h': data.filter(v => !v.is_archived && ageHours(v.date_iso) <= 24).length,
    '7d':  data.filter(v => !v.is_archived && ageHours(v.date_iso) <= 24 * 7).length,
    '30d': data.filter(v => !v.is_archived && ageHours(v.date_iso) <= 24 * 30).length,
  };
  if (counts['24h']) return '24h';
  if (counts['7d']) return '7d';
  return '30d';
}

data.forEach(v => byUid.set(vUid(v), v));

syncPeriodUI(pickInitialTab());
render();
