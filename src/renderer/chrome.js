/**
 * Browser chrome controller.
 *
 * Renders the tab strip and toolbar, keeps the page-view geometry in sync
 * with its own measured height, and owns the incognito switch. Panels that
 * need to draw over the page (omnibox suggestions, Shields) are delegated to
 * the overlay view, because page content is stacked above this document.
 */

const api = window.browseme;

const el = {
  body: document.body,
  tabs: document.getElementById('tabs'),
  newTab: document.getElementById('new-tab'),
  modeBadge: document.getElementById('mode-badge'),
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  home: document.getElementById('home'),
  address: document.getElementById('address'),
  shieldButton: document.getElementById('shield-button'),
  shieldCount: document.getElementById('shield-count'),
  bookmark: document.getElementById('bookmark'),
  privateSwitch: document.getElementById('private-switch'),
  menuButton: document.getElementById('menu-button'),
  videoSearch: document.getElementById('video-search'),
  flowsButton: document.getElementById('flows-button'),
  extensionsButton: document.getElementById('extensions-button'),
  windowControls: document.getElementById('window-controls'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
};

let state = { mode: 'normal', tabs: [], activeId: null, canGoBack: false, canGoForward: false, loading: false };
let addressFocused = false;
let suggestionsOpen = false;
let bookmarked = false;

// ------------------------------------------------------------------ layout

/** Tell the main process exactly how much vertical space the chrome uses. */
function publishLayout() {
  const height = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  api.invoke('browser:layout', { top: Math.round(height), bottom: 0, left: 0, right: 0 });
}

const layoutObserver = new ResizeObserver(publishLayout);
layoutObserver.observe(document.querySelector('.toolbar'));
window.addEventListener('resize', publishLayout);

// -------------------------------------------------------------- tab strip

function faviconFor(tab) {
  if (tab.favicon) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = tab.favicon;
    img.onerror = () => img.replaceWith(placeholderFavicon());
    return img;
  }
  return placeholderFavicon();
}

function placeholderFavicon() {
  const span = document.createElement('span');
  span.className = 'tab-favicon placeholder';
  return span;
}

function renderTabs() {
  const visible = state.tabs.filter((tab) => tab.mode === state.mode);
  el.tabs.replaceChildren();

  for (const tab of visible) {
    const node = document.createElement('div');
    node.className = 'tab' + (tab.active ? ' active' : '');
    node.dataset.id = String(tab.id);
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(Boolean(tab.active)));
    node.title = tab.title;
    node.draggable = true;

    node.append(tab.loading ? spinner() : faviconFor(tab));

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;
    node.append(title);

    if (tab.audible || tab.muted) {
      const audio = document.createElement('span');
      audio.className = 'tab-audio';
      audio.textContent = tab.muted ? '🔇' : '🔊';
      audio.title = tab.muted ? 'Unmute tab' : 'Mute tab';
      audio.addEventListener('click', (event) => {
        event.stopPropagation();
        api.invoke('tabs:mute', { id: tab.id, muted: !tab.muted });
      });
      node.append(audio);
    }

    if (tab.blocked > 0) {
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.textContent = tab.blocked > 99 ? '99+' : String(tab.blocked);
      badge.title = `${tab.blocked} requests blocked`;
      node.append(badge);
    }

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close tab');
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      api.invoke('tabs:close', { id: tab.id });
    });
    node.append(close);

    node.addEventListener('mousedown', (event) => {
      if (event.button === 0) api.invoke('tabs:select', { id: tab.id });
      if (event.button === 1) {
        event.preventDefault();
        api.invoke('tabs:close', { id: tab.id });
      }
    });
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api.invoke('menu:tab', { id: tab.id, x: event.clientX, y: event.clientY });
    });

    wireTabDrag(node, tab);
    el.tabs.append(node);
  }
}

function spinner() {
  const span = document.createElement('span');
  span.className = 'tab-spinner';
  return span;
}

let dragId = null;
function wireTabDrag(node, tab) {
  node.addEventListener('dragstart', (event) => {
    dragId = tab.id;
    node.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(tab.id));
  });
  node.addEventListener('dragend', () => {
    dragId = null;
    node.classList.remove('dragging');
  });
  node.addEventListener('dragover', (event) => {
    if (dragId === null || dragId === tab.id) return;
    event.preventDefault();
  });
  node.addEventListener('drop', (event) => {
    event.preventDefault();
    if (dragId === null) return;
    const siblings = [...el.tabs.children];
    api.invoke('tabs:move', { id: dragId, index: siblings.indexOf(node) });
    dragId = null;
  });
}

// -------------------------------------------------------------- addressbar

function prettyUrl(url) {
  if (!url || url === 'browseme://newtab' || url === 'about:blank') return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'browseme:') return `browseme://${parsed.hostname}`;
    return url;
  } catch {
    return url;
  }
}

function renderToolbar() {
  const active = state.tabs.find((tab) => tab.id === state.activeId);

  el.back.disabled = !state.canGoBack;
  el.forward.disabled = !state.canGoForward;
  el.reload.querySelector('.icon-reload').hidden = state.loading;
  el.reload.querySelector('.icon-stop').hidden = !state.loading;
  el.reload.title = state.loading ? 'Stop' : 'Reload (Ctrl+R)';

  if (!addressFocused) {
    el.address.value = prettyUrl(active?.displayUrl || active?.url || '');
  }

  el.privateSwitch.setAttribute('aria-checked', String(state.mode === 'private'));
  el.body.dataset.mode = state.mode;
  el.modeBadge.hidden = state.mode !== 'private';

  refreshShieldButton(active);
  refreshBookmarkButton(active);
}

async function refreshShieldButton(active) {
  const count = active?.blocked || 0;
  el.shieldCount.hidden = count === 0;
  el.shieldCount.textContent = count > 999 ? '999+' : String(count);

  if (!active || !/^https?:/.test(active.url || '')) {
    el.shieldButton.classList.remove('active');
    el.shieldButton.classList.add('disabled');
    return;
  }

  const info = await api.invoke('shields:forTab', { id: active.id }).catch(() => null);
  el.shieldButton.classList.toggle('disabled', !info?.settings?.enabled);
  el.shieldButton.classList.toggle('active', Boolean(info?.settings?.enabled));
}

async function refreshBookmarkButton(active) {
  if (!active || !/^https?:/.test(active.url || '')) {
    bookmarked = false;
    el.bookmark.classList.remove('saved');
    return;
  }
  bookmarked = await api.invoke('bookmarks:has', { url: active.url }).catch(() => false);
  el.bookmark.classList.toggle('saved', bookmarked);
}

// ----------------------------------------------------------- omnibox panel

function omniboxBounds() {
  const rect = document.getElementById('omnibox').getBoundingClientRect();
  return {
    x: Math.round(rect.left - 8),
    y: Math.round(rect.bottom + 4),
    width: Math.round(rect.width + 16),
    height: 420,
  };
}

let suggestToken = 0;
async function updateSuggestions() {
  const query = el.address.value.trim();
  if (!query) return closeSuggestions();

  const token = ++suggestToken;
  const results = await api.invoke('omnibox:suggest', { query }).catch(() => []);
  if (token !== suggestToken || !addressFocused) return;

  if (!results.length) return closeSuggestions();
  suggestionsOpen = true;
  api.invoke('overlay:show', {
    kind: 'suggestions',
    payload: { results, query, mode: state.mode },
    bounds: omniboxBounds(),
  });
}

function closeSuggestions() {
  if (!suggestionsOpen) return;
  suggestionsOpen = false;
  api.invoke('overlay:hide');
}

function navigate(input) {
  closeSuggestions();
  el.address.blur();
  api.invoke('tabs:navigate', { input });
}

// ---------------------------------------------------------- shields panel

async function toggleShieldsPanel() {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (!active) return;
  const info = await api.invoke('shields:forTab', { id: active.id });
  if (!info) return;

  const rect = el.shieldButton.getBoundingClientRect();
  api.invoke('overlay:show', {
    kind: 'shields',
    payload: { ...info, tabId: active.id, mode: state.mode },
    bounds: { x: Math.round(rect.left - 12), y: Math.round(rect.bottom + 6), width: 400, height: 560 },
  });
}

// -------------------------------------------------------------- listeners

el.newTab.addEventListener('click', () => api.invoke('tabs:create', {}));
el.back.addEventListener('click', () => api.invoke('tabs:back'));
el.forward.addEventListener('click', () => api.invoke('tabs:forward'));
el.reload.addEventListener('click', () => api.invoke(state.loading ? 'tabs:stop' : 'tabs:reload', {}));
el.home.addEventListener('click', () => api.invoke('tabs:navigate', { input: 'browseme://newtab' }));
el.videoSearch.addEventListener('click', () => api.invoke('tabs:create', { url: 'browseme://video' }));
el.flowsButton.addEventListener('click', () => api.invoke('tabs:create', { url: 'browseme://flows' }));
el.extensionsButton.addEventListener('click', () => api.invoke('tabs:create', { url: 'browseme://extensions' }));
el.shieldButton.addEventListener('click', toggleShieldsPanel);

el.menuButton.addEventListener('click', () => {
  const rect = el.menuButton.getBoundingClientRect();
  api.invoke('menu:app', { x: rect.left, y: rect.bottom });
});

el.privateSwitch.addEventListener('click', () => {
  api.invoke('browser:mode', { mode: state.mode === 'private' ? 'normal' : 'private' });
});

el.bookmark.addEventListener('click', async () => {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (!active || !/^https?:/.test(active.url)) return;
  if (bookmarked) await api.invoke('bookmarks:remove', { url: active.url });
  else await api.invoke('bookmarks:add', { url: active.url, title: active.title });
  refreshBookmarkButton(active);
});

el.windowControls.addEventListener('click', (event) => {
  const action = event.target.closest('[data-window]')?.dataset.window;
  if (action) api.invoke(`window:${action}`);
});

el.address.addEventListener('focus', () => {
  addressFocused = true;
  el.address.select();
});

el.address.addEventListener('blur', () => {
  addressFocused = false;
  // Let a click on a suggestion land before the overlay disappears.
  setTimeout(() => {
    if (!addressFocused) {
      closeSuggestions();
      renderToolbar();
    }
  }, 180);
});

el.address.addEventListener('input', updateSuggestions);

el.address.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    navigate(el.address.value);
  } else if (event.key === 'Escape') {
    closeSuggestions();
    el.address.blur();
    renderToolbar();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!suggestionsOpen) return;
    event.preventDefault();
    api.invoke('overlay:action', { action: 'suggestions:move', payload: { delta: event.key === 'ArrowDown' ? 1 : -1 } });
  }
});

// -------------------------------------------------------------- find bar

function openFindBar() {
  el.findbar.hidden = false;
  el.findInput.focus();
  el.findInput.select();
}

function closeFindBar() {
  el.findbar.hidden = true;
  el.findCount.textContent = '';
  api.invoke('browser:findStop');
}

el.findInput.addEventListener('input', () => api.invoke('browser:find', { text: el.findInput.value }));
el.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') api.invoke('browser:find', { text: el.findInput.value, forward: !event.shiftKey });
  if (event.key === 'Escape') closeFindBar();
});
document.getElementById('find-next').addEventListener('click', () => api.invoke('browser:find', { text: el.findInput.value, forward: true }));
document.getElementById('find-prev').addEventListener('click', () => api.invoke('browser:find', { text: el.findInput.value, forward: false }));
document.getElementById('find-close').addEventListener('click', closeFindBar);

// ------------------------------------------------------------- shortcuts

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return;

  const key = event.key.toLowerCase();
  if (key === 't' && !event.shiftKey) { event.preventDefault(); api.invoke('tabs:create', {}); }
  else if (key === 'w') { event.preventDefault(); api.invoke('tabs:close', { id: state.activeId }); }
  else if (key === 'l') { event.preventDefault(); el.address.focus(); }
  else if (key === 'r') { event.preventDefault(); api.invoke('tabs:reload', { ignoreCache: event.shiftKey }); }
  else if (key === 'f') { event.preventDefault(); openFindBar(); }
  else if (key === 'd') { event.preventDefault(); el.bookmark.click(); }
  else if (key === 'n' && event.shiftKey) { event.preventDefault(); el.privateSwitch.click(); }
  else if (key === 'y') { event.preventDefault(); api.invoke('tabs:create', { url: 'browseme://history' }); }
  else if (key === 'j') { event.preventDefault(); api.invoke('tabs:create', { url: 'browseme://downloads' }); }
  else if (key === ',') { event.preventDefault(); api.invoke('tabs:create', { url: 'browseme://settings' }); }
  else if (key === 'tab') {
    event.preventDefault();
    const visible = state.tabs.filter((t) => t.mode === state.mode);
    const index = visible.findIndex((t) => t.id === state.activeId);
    const next = visible[(index + (event.shiftKey ? -1 : 1) + visible.length) % visible.length];
    if (next) api.invoke('tabs:select', { id: next.id });
  } else if (/^[1-9]$/.test(key)) {
    event.preventDefault();
    const visible = state.tabs.filter((t) => t.mode === state.mode);
    const target = key === '9' ? visible[visible.length - 1] : visible[Number(key) - 1];
    if (target) api.invoke('tabs:select', { id: target.id });
  }
});

// ----------------------------------------------------------------- events

api.on('tabs-changed', (payload) => {
  state = payload;
  renderTabs();
  renderToolbar();
});

api.on('shields-counts', (payload) => {
  state = payload;
  renderTabs();
  renderToolbar();
});

api.on('mode-changed', () => closeSuggestions());

api.on('found-in-page', ({ result }) => {
  if (!result) return;
  el.findCount.textContent = result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : 'No results';
});

api.on('fullscreen', (on) => {
  el.body.classList.toggle('fullscreen', Boolean(on));
});

api.on('window-state', ({ maximized }) => {
  el.body.classList.toggle('maximized', Boolean(maximized));
});

api.on('overlay-action', ({ action, payload }) => {
  switch (action) {
    case 'suggestions:accept':
      navigate(payload.value);
      break;
    case 'suggestions:close':
      closeSuggestions();
      break;
    case 'shields:changed':
      refreshShieldButton(state.tabs.find((tab) => tab.id === state.activeId));
      break;
    default:
      break;
  }
});

// --------------------------------------------------------------- start up

(async function init() {
  el.body.dataset.platform = api.platform;
  const windowState = await api.invoke('window:state');
  el.body.classList.toggle('maximized', windowState.maximized);
  state = await api.invoke('tabs:state');
  renderTabs();
  renderToolbar();
  publishLayout();
})();
