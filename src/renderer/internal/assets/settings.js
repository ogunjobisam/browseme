import { api, h, $, toggleRow } from './ui.js';

/** Browser settings page. */

let settings = null;

const set = (patch) => api.invoke('settings:set', { patch });

function selectRow(label, hint, value, options, onChange) {
  const select = h('select', { onchange: (event) => onChange(event.target.value) },
    ...options.map((option) => h('option', {
      value: option.value ?? option,
      selected: (option.value ?? option) === value,
      text: option.label ?? option,
    })),
  );
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null),
    h('div', { style: { flex: '0 0 200px' } }, select),
  );
}

function textRow(label, hint, value, onChange) {
  return h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null),
    h('div', { style: { flex: '0 0 280px' } },
      h('input', { type: 'text', value: value || '', onchange: (event) => onChange(event.target.value) }),
    ),
  );
}

function renderSearch() {
  $('#search-settings').replaceChildren(
    selectRow(
      'Search engine',
      'Used for anything in the address bar that is not a URL.',
      settings.searchEngine,
      settings.searchEngines,
      (value) => set({ searchEngine: value }),
    ),
    toggleRow(
      'Search suggestions',
      'Sends what you type to the search engine as you type. Never used in private mode.',
      settings.searchSuggestions,
      (value) => set({ searchSuggestions: value }),
    ),
  );
}

function renderAppearance() {
  $('#appearance-settings').replaceChildren(
    selectRow('Theme', 'Applies to the browser frame and internal pages.', settings.theme, [
      { value: 'system', label: 'Match system' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ], (value) => set({ theme: value })),
    toggleRow('Spell check', 'Underline misspelled words in text fields.', settings.spellcheck,
      (value) => set({ spellcheck: value })),
    toggleRow('Large video tiles', 'Video search opens with the bigger grid by default.', settings.videoBigTiles,
      (value) => set({ videoBigTiles: value })),
  );
}

function renderPrivacy() {
  $('#privacy-settings').replaceChildren(
    toggleRow('Save browsing history', 'Private-mode browsing is never recorded regardless of this setting.',
      settings.saveHistory, (value) => set({ saveHistory: value })),
    h('div', { class: 'row' },
      h('div', { class: 'grow' },
        h('span', { text: 'Ad and tracker blocking' }),
        h('small', { text: 'Filter lists, per-site rules and your own filters.' }),
      ),
      h('button', { class: 'small', text: 'Open Shields', onclick: () => api.invoke('tabs:navigate', { input: 'browseme://shields' }) }),
    ),
  );
}

const CLEAR_TARGETS = [
  ['cache', 'Cached files and images'],
  ['cookies', 'Cookies and site logins'],
  ['storage', 'All site storage (local storage, IndexedDB)'],
  ['history', 'Browsing history'],
  ['downloads', 'Download history'],
];

function renderClearOptions() {
  const container = $('#clear-options');
  container.replaceChildren();
  for (const [key, label] of CLEAR_TARGETS) {
    container.append(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } },
      h('input', { type: 'checkbox', id: `clear-${key}`, value: key, style: { width: 'auto' } }),
      h('label', { for: `clear-${key}`, text: label, style: { margin: 0, color: 'var(--text)' } }),
    ));
  }
}

$('#clear').addEventListener('click', async () => {
  const what = CLEAR_TARGETS
    .map(([key]) => key)
    .filter((key) => document.getElementById(`clear-${key}`).checked);
  if (!what.length) {
    $('#clear-status').textContent = 'Nothing selected.';
    return;
  }
  $('#clear-status').textContent = 'Clearing…';
  await api.invoke('settings:clearData', { what });
  $('#clear-status').textContent = 'Cleared.';
  for (const [key] of CLEAR_TARGETS) document.getElementById(`clear-${key}`).checked = false;
});

function renderStartup() {
  $('#startup-settings').replaceChildren(
    toggleRow('Reopen tabs from last time', 'Only normal-mode tabs are ever restored.', settings.restoreTabs,
      (value) => set({ restoreTabs: value })),
    textRow('Home page', 'Where the home button and new windows go.', settings.homepage,
      (value) => set({ homepage: value || 'browseme://newtab' })),
  );
}

function renderAbout() {
  $('#about').replaceChildren(
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('span', { text: 'BrowseMe' }), h('small', { text: `Version ${settings.version}` }))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('span', { text: 'Chromium' }), h('small', { text: settings.chrome }))),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('span', { text: 'Electron' }), h('small', { text: settings.electron }))),
    h('div', { class: 'row' }, h('div', { class: 'grow mono truncate' }, h('span', { text: 'Profile folder' }), h('small', { text: settings.userData }))),
  );
}

(async function init() {
  settings = await api.invoke('settings:get');
  renderSearch();
  renderAppearance();
  renderPrivacy();
  renderClearOptions();
  renderStartup();
  renderAbout();
})();
