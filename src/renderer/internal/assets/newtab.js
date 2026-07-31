import { api, h, $, hostOf, faviconUrl } from './ui.js';

/**
 * New tab page.
 *
 * Shortcuts are derived from actual visit counts rather than a curated list,
 * and there is no sponsored content — that would be an odd thing to ship in
 * a browser whose selling point is blocking exactly that.
 */

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#q').value.trim();
  if (query) api.invoke('tabs:navigate', { input: query });
});

document.querySelector('.quick-actions').addEventListener('click', (event) => {
  const target = event.target.closest('[data-go]');
  if (target) api.invoke('tabs:navigate', { input: target.dataset.go });
});

/** Rank visited sites by how often they show up in history. */
function topSites(history, limit = 10) {
  const counts = new Map();
  for (const entry of history) {
    if (!/^https?:/.test(entry.url)) continue;
    let origin;
    try { origin = new URL(entry.url).origin; } catch { continue; }
    const existing = counts.get(origin);
    if (existing) {
      existing.count++;
      if (entry.visitedAt > existing.visitedAt) existing.title = entry.title || existing.title;
    } else {
      counts.set(origin, { origin, count: 1, title: entry.title || hostOf(entry.url), visitedAt: entry.visitedAt });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

function shortcut(site) {
  const glyph = h('span', { class: 'glyph' });
  const icon = faviconUrl(site.origin);
  if (icon) {
    const img = h('img', { src: icon, alt: '' });
    img.onerror = () => { img.remove(); glyph.textContent = hostOf(site.origin)[0]?.toUpperCase() || '?'; };
    glyph.append(img);
  } else {
    glyph.textContent = hostOf(site.origin)[0]?.toUpperCase() || '?';
  }

  return h('button', {
    class: 'shortcut',
    title: site.origin,
    onclick: () => api.invoke('tabs:navigate', { input: site.origin }),
  },
    glyph,
    h('span', { class: 'label', text: hostOf(site.origin) }),
  );
}

(async function init() {
  const [history, shields] = await Promise.all([
    api.invoke('history:list', { limit: 800 }).catch(() => []),
    api.invoke('shields:summary').catch(() => null),
  ]);

  const sites = topSites(history);
  const container = $('#shortcuts');
  if (sites.length) {
    for (const site of sites) container.append(shortcut(site));
  } else {
    container.append(h('p', { class: 'muted', style: { gridColumn: '1/-1' }, text: 'Sites you visit will show up here.' }));
  }

  if (shields) {
    $('#stats').append(
      h('div', {}, h('b', { text: shields.totalBlocked.toLocaleString() }), document.createTextNode('requests blocked')),
      h('div', {}, h('b', { text: shields.rules.network.toLocaleString() }), document.createTextNode('blocking rules')),
      h('div', {}, h('b', { text: shields.rules.cosmetic.toLocaleString() }), document.createTextNode('hiding rules')),
    );
  }
})();
