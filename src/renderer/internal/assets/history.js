import { api, h, $, timeAgo, hostOf, debounce } from './ui.js';

/** History page, grouped by day. */

function groupByDay(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const day = new Date(entry.visitedAt).toDateString();
    const list = groups.get(day);
    if (list) list.push(entry);
    else groups.set(day, [entry]);
  }
  return groups;
}

function dayLabel(day) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return day;
}

function entryRow(entry) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: () => api.invoke('tabs:navigate', { input: entry.url }) },
      h('span', { text: entry.title || hostOf(entry.url) }),
      h('small', { class: 'truncate', text: entry.url }),
    ),
    h('span', { class: 'muted', style: { flex: '0 0 90px', textAlign: 'right', fontSize: '12.5px' }, text: timeAgo(entry.visitedAt) }),
    h('button', {
      class: 'small ghost',
      text: '✕',
      title: 'Remove from history',
      onclick: async () => {
        await api.invoke('history:remove', { url: entry.url, visitedAt: entry.visitedAt });
        load();
      },
    }),
  );
}

async function load() {
  const entries = await api.invoke('history:list', { query: $('#search').value, limit: 500 });
  const container = $('#list');
  container.replaceChildren();

  if (!entries.length) {
    container.append(h('div', { class: 'empty', text: 'Nothing here.' }));
    return;
  }

  for (const [day, items] of groupByDay(entries)) {
    container.append(h('h2', { text: dayLabel(day) }));
    const card = h('div', { class: 'card' });
    for (const entry of items) card.append(entryRow(entry));
    container.append(card);
  }
}

$('#search').addEventListener('input', debounce(load, 200));

$('#clear').addEventListener('click', async () => {
  const range = $('#range').value;
  await api.invoke('history:clear', { range });
  load();
});

load();
