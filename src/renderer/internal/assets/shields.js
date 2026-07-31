import { api, h, $, toggleRow, timeAgo } from './ui.js';

/** Global shield settings, filter list management, and custom rules. */

const DEFAULT_TOGGLES = [
  ['enabled', 'Block ads and trackers', 'The main switch. Off means no filtering anywhere.'],
  ['blockCosmetic', 'Hide ad placeholders', 'Collapse the empty boxes blocked ads leave behind.'],
  ['blockGenericCosmetic', 'Aggressive element hiding', 'Apply generic hiding rules, not just site-specific ones.'],
  ['upgradeHttps', 'Upgrade connections to HTTPS', 'Rewrite insecure page loads before they leave.'],
  ['blockThirdPartyCookies', 'Block third-party cookies', 'Drop cookies set by domains other than the one you are on.'],
  ['trimReferrer', 'Trim cross-site referrers', 'Send only the origin, never the full path, to other sites.'],
];

let summary = null;

async function renderStats() {
  $('#stats').replaceChildren(
    stat(summary.totalBlocked.toLocaleString(), 'requests blocked, all time'),
    stat(summary.rules.network.toLocaleString(), 'network rules loaded'),
    stat(summary.rules.cosmetic.toLocaleString(), 'element-hiding rules'),
    stat(summary.lists.filter((l) => l.enabled).length, 'active filter lists'),
  );
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', { text: String(value) }), h('span', { text: label }));
}

async function renderDefaults() {
  const settings = (await api.invoke('settings:get')).shieldDefaults;
  const container = $('#defaults');
  container.replaceChildren();
  for (const [key, label, hint] of DEFAULT_TOGGLES) {
    container.append(toggleRow(label, hint, settings[key], async (value) => {
      await api.invoke('shields:setGlobal', { patch: { [key]: value } });
    }));
  }
}

function renderLists() {
  const container = $('#lists');
  container.replaceChildren();

  for (const list of summary.lists) {
    const control = h('button', {
      class: 'toggle',
      role: 'switch',
      'aria-checked': String(Boolean(list.enabled)),
      'aria-label': list.title,
      onclick: async () => {
        const next = control.getAttribute('aria-checked') !== 'true';
        control.setAttribute('aria-checked', String(next));
        await api.invoke('shields:setList', { id: list.id, enabled: next });
        await load();
      },
    });

    let status;
    if (list.error) status = `Last attempt failed: ${list.error}`;
    else if (list.fetchedAt) status = `Updated ${timeAgo(list.fetchedAt)}`;
    else status = 'Not downloaded yet';

    container.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('span', { text: list.title }),
        h('small', { text: `${list.description} — ${status}` }),
      ),
      control,
    ));
  }
}

async function renderSites() {
  // Per-site overrides live under `shields.sites` in the store; the summary
  // does not carry them, so read them through the settings route.
  const container = $('#sites');
  const settings = await api.invoke('settings:get');
  const sites = settings.shieldSites || {};
  const entries = Object.entries(sites);

  container.replaceChildren();
  if (!entries.length) {
    container.append(h('p', { class: 'muted', style: { margin: 0 }, text: 'No site-specific changes yet. Use the shield button in the toolbar to adjust one site.' }));
    return;
  }

  for (const [hostname, patch] of entries) {
    const changes = Object.entries(patch).map(([key, value]) => `${key}: ${value ? 'on' : 'off'}`).join(', ');
    container.append(h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('span', { text: hostname }),
        h('small', { text: changes }),
      ),
      h('button', {
        class: 'small',
        text: 'Reset',
        onclick: async () => {
          await api.invoke('shields:resetSite', { hostname });
          renderSites();
        },
      }),
    ));
  }
}

$('#refresh').addEventListener('click', async () => {
  $('#refresh-status').textContent = 'Downloading…';
  await api.invoke('shields:refresh');
  $('#refresh-status').textContent = 'Done.';
  await load();
});

$('#save-custom').addEventListener('click', async () => {
  await api.invoke('shields:custom', { text: $('#custom').value });
  $('#custom-status').textContent = 'Saved and applied.';
  setTimeout(() => { $('#custom-status').textContent = ''; }, 2500);
  await load();
});

api.on('shields-summary', (payload) => {
  summary = payload;
  renderStats();
  renderLists();
});

async function load() {
  summary = await api.invoke('shields:summary');
  await renderStats();
  renderLists();
  await renderDefaults();
  await renderSites();
  $('#custom').value = await api.invoke('shields:custom', {});
}

load();
