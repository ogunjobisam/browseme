import { api, h, $, renderList, debounce } from './ui.js';

/**
 * Video search page.
 *
 * Search runs in the main process (no API keys, several providers tried in
 * order) and results render as large tiles. Picking one opens the theater
 * player above the grid rather than navigating away, so you can keep
 * scanning results while something plays.
 */

const els = {
  form: $('#search-form'),
  query: $('#query'),
  meta: $('#meta'),
  results: $('#results'),
  theater: $('#theater'),
  player: $('#player'),
  title: $('#theater-title'),
  author: $('#theater-author'),
  stats: $('#theater-stats'),
  description: $('#theater-description'),
};

let results = [];
let current = null;

// Tile size is a per-user preference, not a per-search one. The picker on
// this page wins; the browser setting only supplies the starting value.
const SIZE_KEY = 'browseme.video.size';
let size = localStorage.getItem(SIZE_KEY) || 'comfortable';

function applySize() {
  els.results.dataset.size = size;
  for (const button of document.querySelectorAll('.size-control button')) {
    button.setAttribute('aria-pressed', String(button.dataset.size === size));
  }
}

document.querySelector('.size-control').addEventListener('click', (event) => {
  const next = event.target.closest('button')?.dataset.size;
  if (!next) return;
  size = next;
  localStorage.setItem(SIZE_KEY, size);
  applySize();
});

// ---------------------------------------------------------------- results

function tile(video) {
  const thumb = h('div', { class: 'tile-thumb' },
    h('img', { src: video.thumbnail, alt: '', loading: 'lazy' }),
    h('span', {
      class: 'tile-duration' + (video.live ? ' live' : ''),
      text: video.live ? 'LIVE' : video.durationLabel,
    }),
  );

  const sub = h('div', { class: 'tile-sub' });
  if (video.author) sub.append(h('span', { text: video.author }));
  if (video.viewsLabel) sub.append(h('span', { text: video.viewsLabel }));
  if (video.published) sub.append(h('span', { text: video.published }));

  return h('article', {
    class: 'tile',
    tabindex: '0',
    onclick: () => play(video),
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        play(video);
      }
    },
    oncontextmenu: (event) => {
      // Middle-ground affordance: right-click opens the real page in a tab.
      event.preventDefault();
      if (video.url) api.invoke('tabs:create', { url: video.url, background: true });
    },
  },
    thumb,
    h('div', { class: 'tile-body' },
      h('h3', { class: 'tile-title', text: video.title }),
      sub,
    ),
  );
}

function skeleton() {
  els.results.replaceChildren();
  for (let i = 0; i < 6; i++) {
    els.results.append(h('article', { class: 'tile loading-tile' },
      h('div', { class: 'tile-thumb' }),
      h('div', { class: 'tile-body' },
        h('h3', { class: 'tile-title', text: 'Loading' }),
        h('div', { class: 'tile-sub', text: 'Loading' }),
      ),
    ));
  }
}

// ---------------------------------------------------------------- theater

function play(video) {
  current = video;
  els.theater.hidden = false;
  els.player.src = video.embedUrl ? `${video.embedUrl}&autoplay=1` : '';
  els.title.textContent = video.title;
  els.author.textContent = video.author || '';
  els.stats.textContent = [video.viewsLabel, video.published].filter(Boolean).join(' · ');
  els.description.textContent = video.description || '';
  els.theater.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeTheater() {
  els.theater.hidden = true;
  els.player.src = 'about:blank';   // stop playback
  current = null;
}

$('#close-theater').addEventListener('click', closeTheater);
$('#open-source').addEventListener('click', () => {
  if (current?.url) api.invoke('tabs:create', { url: current.url });
});
$('#copy-link').addEventListener('click', () => {
  if (current?.url) api.invoke('browser:copy', { text: current.url });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.theater.hidden) closeTheater();
  if (event.key === '/' && document.activeElement !== els.query) {
    event.preventDefault();
    els.query.focus();
    els.query.select();
  }
});

// ----------------------------------------------------------------- search

async function search(query, { refresh = false } = {}) {
  if (!query.trim()) return;

  els.meta.textContent = 'Searching…';
  skeleton();

  const response = await api.invoke('video:search', { query, limit: 48, refresh })
    .catch((err) => ({ results: [], provider: 'none', errors: [String(err.message || err)] }));

  results = response.results || [];
  renderList(els.results, results, tile, 'No videos found. Try different words.');

  if (results.length) {
    const source = response.provider.split(':')[0];
    els.meta.textContent = `${results.length} results via ${source}${response.cached ? ' (cached)' : ''}`;
  } else {
    els.meta.textContent = response.errors?.length
      ? `No results — every source failed. ${response.errors.slice(0, 2).join('; ')}`
      : 'No results.';
  }

  const url = new URL(location.href);
  url.searchParams.set('q', query);
  history.replaceState(null, '', url);
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  closeTheater();
  search(els.query.value);
});

// Typing keeps searching without needing the button, but not on every letter.
els.query.addEventListener('input', debounce(() => {
  if (els.query.value.trim().length >= 3) search(els.query.value);
}, 550));

// ---------------------------------------------------------------- startup

// First visit: honour the browser-wide "large video tiles" preference.
if (!localStorage.getItem(SIZE_KEY)) {
  api.invoke('settings:get')
    .then((settings) => {
      if (settings.videoBigTiles === false) {
        size = 'comfortable';
      } else {
        size = 'huge';
      }
      applySize();
    })
    .catch(() => {});
}

applySize();
const initialQuery = new URL(location.href).searchParams.get('q');
if (initialQuery) {
  els.query.value = initialQuery;
  search(initialQuery);
} else {
  els.results.append(h('div', { class: 'empty' },
    h('p', { text: 'Search once and results open in a player sized to your window.' }),
    h('p', { class: 'muted', text: 'Tip: Alt+T turns on theater mode for a video on any site.' }),
  ));
}
