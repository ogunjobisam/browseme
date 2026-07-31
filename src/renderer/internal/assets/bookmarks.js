import { api, h, $, renderList, hostOf, timeAgo, debounce } from './ui.js';

/** Bookmarks page. */

let all = [];

function row(entry) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: () => api.invoke('tabs:navigate', { input: entry.url }) },
      h('span', { text: entry.title || hostOf(entry.url) }),
      h('small', { class: 'truncate', text: entry.url }),
    ),
    h('span', { class: 'muted', style: { flex: '0 0 100px', textAlign: 'right', fontSize: '12.5px' }, text: timeAgo(entry.addedAt) }),
    h('button', {
      class: 'small',
      text: 'Open in new tab',
      onclick: () => api.invoke('tabs:create', { url: entry.url, background: true }),
    }),
    h('button', {
      class: 'small danger',
      text: 'Remove',
      onclick: async () => {
        await api.invoke('bookmarks:remove', { url: entry.url });
        load();
      },
    }),
  );
}

function apply() {
  const needle = $('#search').value.trim().toLowerCase();
  const filtered = needle
    ? all.filter((b) => (b.title || '').toLowerCase().includes(needle) || b.url.toLowerCase().includes(needle))
    : all;
  renderList($('#list'), filtered, row, needle ? 'No matching bookmarks.' : 'No bookmarks yet.');
  $('#count').textContent = all.length ? `${filtered.length} of ${all.length}` : '';
}

async function load() {
  all = await api.invoke('bookmarks:list');
  apply();
}

$('#search').addEventListener('input', debounce(apply, 150));

load();
