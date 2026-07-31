import { api, h, $, renderList } from './ui.js';

/** Extension manager page. */

function card(entry) {
  const badges = h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
    h('span', { class: 'pill', text: `v${entry.version}` }),
    h('span', { class: 'pill', text: `MV${entry.manifestVersion}` }),
    entry.loaded ? h('span', { class: 'pill on', text: 'Loaded' }) : h('span', { class: 'pill', text: 'Not loaded' }),
    entry.allowInPrivate ? h('span', { class: 'pill warn', text: 'Private mode' }) : null,
  );

  const enabledToggle = h('button', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(Boolean(entry.enabled)),
    'aria-label': `Enable ${entry.name}`,
    onclick: async () => {
      const next = enabledToggle.getAttribute('aria-checked') !== 'true';
      enabledToggle.setAttribute('aria-checked', String(next));
      await api.invoke('extensions:enable', { key: entry.key, enabled: next });
      refresh();
    },
  });

  const privateToggle = h('button', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(Boolean(entry.allowInPrivate)),
    'aria-label': `Allow ${entry.name} in private mode`,
    onclick: async () => {
      const next = privateToggle.getAttribute('aria-checked') !== 'true';
      privateToggle.setAttribute('aria-checked', String(next));
      await api.invoke('extensions:private', { key: entry.key, allow: next });
      refresh();
    },
  });

  const permissions = entry.permissions?.length
    ? h('details', { style: { marginTop: '10px' } },
        h('summary', { class: 'muted', style: { cursor: 'pointer', fontSize: '12.5px' }, text: `${entry.permissions.length} permissions` }),
        h('div', { class: 'mono muted', style: { marginTop: '6px' }, text: entry.permissions.join(', ') }),
      )
    : null;

  return h('div', { class: 'card' },
    h('div', { class: 'row', style: { borderBottom: 'none', paddingTop: 0 } },
      h('div', { class: 'grow' },
        h('h3', { text: entry.name }),
        h('small', { text: entry.description || 'No description provided.' }),
        badges,
      ),
      enabledToggle,
    ),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('span', { text: 'Allow in private mode' }),
        h('small', { text: 'The extension can read pages you open in private mode.' }),
      ),
      privateToggle,
    ),
    h('div', { class: 'row', style: { borderBottom: 'none' } },
      h('div', { class: 'grow mono truncate muted', text: entry.path }),
      h('button', {
        class: 'small danger',
        text: 'Remove',
        onclick: async () => {
          await api.invoke('extensions:uninstall', { key: entry.key });
          refresh();
        },
      }),
    ),
    permissions,
  );
}

async function refresh() {
  const list = await api.invoke('extensions:list');
  renderList($('#list'), list, card, 'No extensions installed yet.');
  $('#count').textContent = list.length
    ? `${list.filter((e) => e.enabled).length} of ${list.length} enabled`
    : '';
}

$('#add').addEventListener('click', async () => {
  const banner = $('#error-banner');
  banner.hidden = true;
  try {
    await api.invoke('extensions:install', {});
  } catch (err) {
    banner.hidden = false;
    banner.replaceChildren(
      h('h3', { text: 'Could not add that extension' }),
      h('p', { class: 'muted', text: String(err.message || err) }),
    );
  }
  refresh();
});

$('#store').addEventListener('click', () => api.invoke('extensions:openStore'));

api.on('extensions-changed', refresh);
api.on('extensions-error', ({ entry, error }) => {
  const banner = $('#error-banner');
  banner.hidden = false;
  banner.replaceChildren(
    h('h3', { text: `${entry.name || 'An extension'} failed to load` }),
    h('p', { class: 'muted', text: error }),
  );
});

refresh();
