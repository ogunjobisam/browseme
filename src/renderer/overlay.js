/**
 * Overlay renderer.
 *
 * One document that draws whichever floating surface the browser asks for.
 * It reports user actions back through `overlay:action`, which the main
 * process forwards to the chrome UI — the overlay never mutates browser
 * state directly except where it owns it outright (Shields toggles,
 * permission answers).
 */

const api = window.browseme;
const root = document.getElementById('root');

let selectedIndex = 0;
let currentSuggestions = [];

api.on('overlay:render', ({ kind, payload }) => {
  document.body.dataset.mode = payload?.mode || 'normal';
  const renderers = { suggestions: renderSuggestions, shields: renderShields, permission: renderPermission };
  const render = renderers[kind];
  root.replaceChildren();
  if (render) render(payload);
});

api.on('overlay:clear', () => {
  root.replaceChildren();
  currentSuggestions = [];
  selectedIndex = 0;
});

api.on('overlay-action', ({ action, payload }) => {
  if (action === 'suggestions:move') moveSelection(payload.delta);
});

// Clicking the transparent area around a panel dismisses it, the same way a
// click outside a menu does.
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.panel')) api.invoke('overlay:hide');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.invoke('overlay:hide');
});

function panel(className) {
  const node = document.createElement('div');
  node.className = `panel ${className}`;
  return node;
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
}

// ----------------------------------------------------------- suggestions

const SUGGESTION_ICONS = { url: '🌐', bookmark: '★', history: '🕘', search: '🔍' };

function renderSuggestions({ results }) {
  currentSuggestions = results;
  selectedIndex = 0;

  const list = panel('suggestions');
  results.forEach((result, index) => {
    const row = h('div', {
      class: 'suggestion' + (index === 0 ? ' selected' : ''),
      'data-index': String(index),
      onmousedown: (event) => {
        event.preventDefault();
        accept(index);
      },
      onmouseenter: () => setSelection(index),
    },
      h('span', { class: 'suggestion-icon', text: SUGGESTION_ICONS[result.kind] || '🔍' }),
      h('div', { class: 'suggestion-text' },
        h('div', { class: 'suggestion-title', text: result.title }),
        result.subtitle ? h('div', { class: 'suggestion-subtitle', text: result.subtitle }) : null,
      ),
    );
    list.append(row);
  });

  root.append(list);
}

function setSelection(index) {
  selectedIndex = index;
  for (const node of root.querySelectorAll('.suggestion')) {
    node.classList.toggle('selected', Number(node.dataset.index) === index);
  }
}

function moveSelection(delta) {
  if (!currentSuggestions.length) return;
  const next = (selectedIndex + delta + currentSuggestions.length) % currentSuggestions.length;
  setSelection(next);
  root.querySelector('.suggestion.selected')?.scrollIntoView({ block: 'nearest' });
}

function accept(index) {
  const result = currentSuggestions[index ?? selectedIndex];
  if (!result) return;
  api.invoke('overlay:action', { action: 'suggestions:accept', payload: { value: result.value } });
  api.invoke('overlay:hide');
}

// --------------------------------------------------------------- shields

const SHIELD_TOGGLES = [
  { key: 'enabled', label: 'Shields', hint: 'Block ads and trackers on this site' },
  { key: 'blockCosmetic', label: 'Hide ad placeholders', hint: 'Remove the empty space ads leave behind' },
  { key: 'blockGenericCosmetic', label: 'Aggressive element hiding', hint: 'Broader rules; can occasionally hit real content' },
  { key: 'upgradeHttps', label: 'Upgrade to HTTPS', hint: 'Rewrite insecure page loads' },
  { key: 'blockThirdPartyCookies', label: 'Block third-party cookies', hint: 'Drop cookies set by other sites' },
  { key: 'trimReferrer', label: 'Trim referrers', hint: 'Send only the origin to other sites' },
];

const CATEGORY_LABELS = {
  script: 'Scripts', image: 'Images', xmlhttprequest: 'Requests', subdocument: 'Frames',
  stylesheet: 'Stylesheets', media: 'Media', font: 'Fonts', ping: 'Beacons', other: 'Other',
};

function renderShields({ hostname, settings, stats, tabId }) {
  const node = panel('shields');

  node.append(
    h('div', { class: 'shields-head' },
      h('h2', { class: 'shields-host', text: hostname || 'This page' }),
      h('div', { class: 'shields-sub', text: settings.enabled ? 'Shields are up' : 'Shields are down for this site' }),
    ),
    h('div', { class: 'shields-count' },
      h('b', { text: String(stats.count) }),
      h('span', { text: stats.count === 1 ? 'request blocked on this page' : 'requests blocked on this page' }),
    ),
  );

  const body = h('div', { class: 'shields-body' });

  for (const toggle of SHIELD_TOGGLES) {
    const value = Boolean(settings[toggle.key]);
    const control = h('span', {
      class: 'toggle',
      role: 'switch',
      'aria-checked': String(value),
      tabindex: '0',
    });

    const row = h('div', {
      class: 'shield-row',
      onclick: async () => {
        const next = control.getAttribute('aria-checked') !== 'true';
        control.setAttribute('aria-checked', String(next));
        await api.invoke('shields:setSite', { hostname, patch: { [toggle.key]: next } });
        api.invoke('overlay:action', { action: 'shields:changed', payload: { hostname } });
      },
    },
      h('div', { class: 'label' },
        h('span', { text: toggle.label }),
        h('small', { text: toggle.hint }),
      ),
      control,
    );
    body.append(row);
  }

  const categories = Object.entries(stats.byCategory || {}).sort((a, b) => b[1] - a[1]);
  if (categories.length) {
    const summary = categories
      .map(([type, count]) => `${CATEGORY_LABELS[type] || type}: ${count}`)
      .join(' · ');
    body.append(h('div', { class: 'shield-hosts' }, h('div', { text: summary })));
  }

  if (stats.hosts?.length) {
    const list = h('ul');
    for (const host of stats.hosts.slice(0, 40)) list.append(h('li', { text: host }));
    body.append(h('div', { class: 'shield-hosts' },
      h('div', { text: `Blocked domains (${stats.hosts.length})` }),
      list,
    ));
  }

  node.append(body);
  node.append(h('div', { class: 'shields-foot' },
    h('button', {
      text: 'Reset this site',
      onclick: async () => {
        await api.invoke('shields:resetSite', { hostname });
        await api.invoke('tabs:reload', {});
        api.invoke('overlay:hide');
      },
    }),
    h('button', {
      text: 'Global settings',
      onclick: () => {
        api.invoke('tabs:create', { url: 'browseme://shields' });
        api.invoke('overlay:hide');
      },
    }),
  ));

  root.append(node);
  void tabId;
}

// ------------------------------------------------------------ permission

const PERMISSION_LABELS = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'send you notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
  pointerLock: 'lock your mouse pointer',
  'display-capture': 'capture your screen',
  'clipboard-read': 'read your clipboard',
  hid: 'connect to HID devices',
  serial: 'connect to serial devices',
  usb: 'connect to USB devices',
};

function renderPermission({ id, permission, url, mode }) {
  const node = panel('permission');
  let origin = url || 'This site';
  try { origin = new URL(url).origin; } catch { /* already an origin */ }

  node.append(
    h('h3', { text: `Allow ${origin}?` }),
    h('p', {},
      document.createTextNode('It wants to '),
      h('code', { text: PERMISSION_LABELS[permission] || permission }),
      document.createTextNode(mode === 'private'
        ? '. In private mode this choice is never remembered.'
        : '. Your choice is remembered for this site.'),
    ),
    h('div', { class: 'actions' },
      h('button', { text: 'Block', onclick: () => api.invoke('overlay:permission', { id, allow: false }) }),
      h('button', { class: 'primary', text: 'Allow', onclick: () => api.invoke('overlay:permission', { id, allow: true }) }),
    ),
  );

  root.append(node);
}

// Enter on the suggestions panel accepts the highlighted row.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && currentSuggestions.length) accept();
});
