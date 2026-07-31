'use strict';

const path = require('node:path');
const { ipcMain, dialog, shell, app, Menu, clipboard, net } = require('electron');

const { SEARCH_ENGINES, normalizeInput } = require('./tabs');
const { FlowManager } = require('./automation/runtime');
const { CATALOG } = require('./shields/lists');

/**
 * The IPC surface.
 *
 * Everything the UI can ask the browser to do goes through one channel with
 * a route table, rather than a few dozen individually registered channels.
 * That keeps the allowlist reviewable in one place and makes the preload
 * bridge trivial: it forwards a route name and a payload, nothing else.
 */

const INVOKE_CHANNEL = 'browseme:invoke';
const EVENT_CHANNEL = 'browseme:event';

function registerIpc(ctx) {
  const { store, tabs, shields, sessions, extensions, flows, downloads, video, overlay } = ctx;

  const routes = {
    // ------------------------------------------------------------ tabs
    'tabs:state': () => tabs.serialize(),
    'tabs:create': ({ url, background, mode } = {}) => tabs.create({ url, background, mode }).id,
    'tabs:close': ({ id }) => tabs.close(id),
    'tabs:select': ({ id }) => tabs.select(id),
    'tabs:move': ({ id, index }) => tabs.move(id, index),
    'tabs:navigate': ({ input, id }) => tabs.navigate(input, id),
    'tabs:back': () => tabs.goBack(),
    'tabs:forward': () => tabs.goForward(),
    'tabs:reload': ({ ignoreCache } = {}) => tabs.reload({ ignoreCache }),
    'tabs:stop': () => tabs.stop(),
    'tabs:mute': ({ id, muted }) => tabs.setMuted(id, muted),
    'tabs:devtools': () => tabs.toggleDevTools(),
    'tabs:zoom': ({ delta }) => (delta === 0 ? tabs.resetZoom() : tabs.setZoom(delta)),
    'tabs:duplicate': ({ id }) => {
      const tab = tabs.tabs.get(id);
      return tab ? tabs.create({ url: tab.url, mode: tab.mode, openerTabId: id }).id : null;
    },

    // --------------------------------------------------------- browser
    'browser:mode': ({ mode }) => tabs.setMode(mode),
    'browser:layout': (patch) => tabs.setLayout(patch),
    'browser:find': ({ text, forward = true }) => {
      const active = tabs.active;
      if (!active) return null;
      if (!text) return active.view.webContents.stopFindInPage('clearSelection');
      return active.view.webContents.findInPage(text, { forward, findNext: false });
    },
    'browser:findStop': () => tabs.active?.view.webContents.stopFindInPage('clearSelection'),
    'browser:openExternal': ({ url }) => {
      if (/^https?:/.test(url)) return shell.openExternal(url);
      return null;
    },
    'browser:copy': ({ text }) => clipboard.writeText(String(text || '')),
    'browser:print': () => tabs.active?.view.webContents.print(),

    // ---------------------------------------------------------- window
    'window:minimize': () => ctx.window.minimize(),
    'window:maximize': () => (ctx.window.isMaximized() ? ctx.window.unmaximize() : ctx.window.maximize()),
    'window:close': () => ctx.window.close(),
    'window:state': () => ({
      maximized: ctx.window.isMaximized(),
      fullScreen: ctx.window.isFullScreen(),
      platform: process.platform,
    }),

    // --------------------------------------------------------- shields
    'shields:summary': () => shields.summary(),
    'shields:forTab': ({ id }) => {
      const tab = tabs.tabs.get(id ?? tabs.activeId);
      if (!tab) return null;
      let hostname = '';
      try { hostname = new URL(tab.url).hostname; } catch { /* internal page */ }
      const stats = tab.view.webContents.isDestroyed()
        ? { count: 0, byCategory: {}, hosts: [] }
        : shields.statsFor(tab.view.webContents.id);
      return { hostname, settings: shields.settingsFor(hostname), stats, url: tab.url };
    },
    'shields:setSite': ({ hostname, patch }) => {
      const next = shields.setSiteSetting(hostname, patch);
      tabs.reload();
      return next;
    },
    'shields:resetSite': ({ hostname }) => shields.clearSiteSetting(hostname),
    'shields:setGlobal': ({ patch }) => shields.setGlobalSetting(patch),
    'shields:setList': ({ id, enabled }) => shields.setListEnabled(id, enabled),
    'shields:refresh': () => shields.refreshLists({ force: true }),
    'shields:custom': ({ text }) => (text === undefined ? shields.customFilters() : shields.setCustomFilters(text)),
    'shields:catalog': () => CATALOG,

    // ------------------------------------------------------ extensions
    'extensions:list': () => extensions.list(),
    'extensions:install': async ({ source } = {}) => {
      let target = source;
      if (!target) {
        const result = await dialog.showOpenDialog(ctx.window, {
          title: 'Add extension',
          properties: ['openFile', 'openDirectory'],
          filters: [{ name: 'Extensions', extensions: ['crx', 'zip'] }],
        });
        if (result.canceled || !result.filePaths.length) return null;
        target = result.filePaths[0];
      }
      return extensions.install(target);
    },
    'extensions:enable': ({ key, enabled }) => extensions.setEnabled(key, enabled),
    'extensions:private': ({ key, allow }) => extensions.setPrivateAccess(key, allow),
    'extensions:uninstall': ({ key }) => extensions.uninstall(key),
    'extensions:openStore': () => shell.openExternal('https://chromewebstore.google.com/'),

    // ----------------------------------------------------------- flows
    'flows:list': () => flows.list(),
    'flows:get': ({ id }) => flows.get(id),
    'flows:save': ({ workflow }) => flows.save(workflow),
    'flows:remove': ({ id }) => flows.remove(id),
    'flows:duplicate': ({ id }) => flows.duplicate(id),
    'flows:run': ({ id, startNodeId }) => flows.run(id, { startNodeId }),
    'flows:cancel': ({ id }) => flows.cancel(id),
    'flows:catalog': () => FlowManager.catalog(),
    'flows:history': ({ id }) => flows.history(id),
    'flows:lastRun': ({ id }) => flows.lastRun(id),

    // ----------------------------------------------------------- video
    'video:search': ({ query, limit, refresh }) => video.search(query, { limit, refresh }),
    'video:openTheater': ({ url }) => tabs.create({ url }),

    // --------------------------------------------------------- history
    'history:list': ({ query, limit = 300 } = {}) => {
      const all = store.get('history', []);
      if (!query) return all.slice(0, limit);
      const needle = String(query).toLowerCase();
      return all
        .filter((h) => (h.title || '').toLowerCase().includes(needle) || h.url.toLowerCase().includes(needle))
        .slice(0, limit);
    },
    'history:remove': ({ url, visitedAt }) => {
      store.set('history', store.get('history', []).filter((h) => !(h.url === url && h.visitedAt === visitedAt)));
    },
    'history:clear': ({ range } = {}) => {
      if (!range || range === 'all') return store.set('history', []);
      const cutoff = Date.now() - ({ hour: 36e5, day: 864e5, week: 6048e5 }[range] || 0);
      return store.set('history', store.get('history', []).filter((h) => h.visitedAt < cutoff));
    },

    // ------------------------------------------------------- bookmarks
    'bookmarks:list': () => store.get('bookmarks', []),
    'bookmarks:add': ({ url, title, folder = 'Bookmarks' }) => {
      const list = store.get('bookmarks', []);
      if (list.some((b) => b.url === url)) return list;
      list.unshift({ url, title: title || url, folder, addedAt: Date.now() });
      return store.set('bookmarks', list);
    },
    'bookmarks:remove': ({ url }) =>
      store.set('bookmarks', store.get('bookmarks', []).filter((b) => b.url !== url)),
    'bookmarks:has': ({ url }) => store.get('bookmarks', []).some((b) => b.url === url),

    // ------------------------------------------------------- downloads
    'downloads:list': () => downloads.list(),
    'downloads:pause': ({ id }) => downloads.pause(id),
    'downloads:resume': ({ id }) => downloads.resume(id),
    'downloads:cancel': ({ id }) => downloads.cancel(id),
    'downloads:reveal': ({ id }) => downloads.reveal(id),
    'downloads:open': ({ id }) => downloads.open(id),
    'downloads:clear': () => downloads.clearHistory(),

    // -------------------------------------------------------- settings
    'settings:get': () => ({
      ...store.get('settings', {}),
      searchEngines: Object.keys(SEARCH_ENGINES),
      shieldDefaults: shields.settingsFor(null),
      shieldSites: store.get('shields.sites', {}),
      version: app.getVersion(),
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      userData: app.getPath('userData'),
    }),
    'settings:set': ({ patch }) => {
      const next = { ...store.get('settings', {}), ...patch };
      store.set('settings', next);
      ctx.broadcast('settings-changed', next);
      return next;
    },
    'settings:clearData': async ({ what = [] }) => {
      const session = sessions.for('normal');
      if (what.includes('cache')) await session.clearCache();
      if (what.includes('cookies')) await session.clearStorageData({ storages: ['cookies'] });
      if (what.includes('storage')) await session.clearStorageData();
      if (what.includes('history')) store.set('history', []);
      if (what.includes('downloads')) downloads.clearHistory();
      return true;
    },

    // -------------------------------------------------------- omnibox
    'omnibox:suggest': ({ query }) => suggest(ctx, query),

    // -------------------------------------------------------- overlay
    'overlay:show': ({ kind, payload, bounds }) => overlay.show(kind, payload, bounds),
    'overlay:hide': () => overlay.hide(),
    'overlay:resize': ({ bounds }) => overlay.setBounds(bounds),
    'overlay:action': ({ action, payload }) => overlay.handleAction(action, payload),
    'overlay:permission': ({ id, allow }) => overlay.resolvePermission(id, allow),

    // ----------------------------------------------------------- menus
    'menu:app': ({ x, y }) => showAppMenu(ctx, x, y),
    'menu:tab': ({ id, x, y }) => showTabMenu(ctx, id, x, y),
  };

  // Page content asks for its own cosmetic filters. Available to every page
  // by design — it only ever returns hide-selectors for a hostname, and the
  // content preload cannot reach any other route.
  ipcMain.handle('browseme:cosmetic', (_event, { hostname, tokens } = {}) => {
    try {
      return shields.cosmeticFor(
        String(hostname || ''),
        Array.isArray(tokens) ? tokens.slice(0, 5000) : undefined,
      );
    } catch {
      return [];
    }
  });

  ipcMain.handle(INVOKE_CHANNEL, async (event, route, payload) => {
    const handler = routes[route];
    if (!handler) throw new Error(`Unknown route: ${route}`);

    // Only the browser's own UI may drive the browser. Page content shares
    // the same preload, so the origin check is what separates them.
    if (!isTrustedSender(ctx, event.sender, route)) {
      throw new Error(`Route ${route} is not available to page content`);
    }

    return handler(payload || {});
  });

  return routes;
}

/**
 * Chrome UI and overlay may call anything. Internal `browseme://` pages get
 * the routes they need to function. Ordinary web pages get nothing.
 */
const PAGE_ROUTES = new Set([
  'video:search', 'video:openTheater',
  'flows:list', 'flows:get', 'flows:save', 'flows:remove', 'flows:duplicate',
  'flows:run', 'flows:cancel', 'flows:catalog', 'flows:history', 'flows:lastRun',
  'extensions:list', 'extensions:install', 'extensions:enable', 'extensions:private',
  'extensions:uninstall', 'extensions:openStore',
  'settings:get', 'settings:set', 'settings:clearData',
  'shields:summary', 'shields:setGlobal', 'shields:setList', 'shields:refresh',
  'shields:custom', 'shields:catalog', 'shields:resetSite',
  'history:list', 'history:remove', 'history:clear',
  'bookmarks:list', 'bookmarks:add', 'bookmarks:remove', 'bookmarks:has',
  'downloads:list', 'downloads:pause', 'downloads:resume', 'downloads:cancel',
  'downloads:reveal', 'downloads:open', 'downloads:clear',
  'tabs:create', 'tabs:navigate',
  'browser:openExternal', 'browser:copy',
]);

function isTrustedSender(ctx, sender, route) {
  if (sender === ctx.window.webContents) return true;
  if (ctx.overlay && sender === ctx.overlay.webContents) return true;

  let url = '';
  try { url = sender.getURL(); } catch { return false; }
  if (url.startsWith('browseme://')) return PAGE_ROUTES.has(route);
  return false;
}

// ------------------------------------------------------------- suggestions

/**
 * Omnibox suggestions: what you have visited and bookmarked first, then the
 * search engine's own completions. Suggestion lookups are skipped entirely in
 * private mode so typing does not leak to a third party.
 */
async function suggest(ctx, query) {
  const text = String(query || '').trim();
  if (!text) return [];

  const results = [];
  const seen = new Set();
  const needle = text.toLowerCase();

  const push = (entry) => {
    if (seen.has(entry.value)) return;
    seen.add(entry.value);
    results.push(entry);
  };

  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(text) || /^https?:/i.test(text)) {
    push({ kind: 'url', title: text, value: normalizeInput(text), subtitle: 'Open site' });
  }

  if (ctx.tabs.mode !== 'private') {
    for (const entry of ctx.store.get('bookmarks', [])) {
      if (results.length >= 4) break;
      if ((entry.title || '').toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)) {
        push({ kind: 'bookmark', title: entry.title, value: entry.url, subtitle: entry.url });
      }
    }

    const history = ctx.store.get('history', []);
    for (const entry of history) {
      if (results.length >= 8) break;
      if ((entry.title || '').toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)) {
        push({ kind: 'history', title: entry.title || entry.url, value: entry.url, subtitle: entry.url });
      }
    }
  }

  const engine = ctx.store.get('settings.searchEngine', 'duckduckgo');
  push({ kind: 'search', title: text, value: normalizeInput(text, engine), subtitle: `Search with ${engine}` });

  if (ctx.tabs.mode !== 'private' && ctx.store.get('settings.searchSuggestions', true)) {
    try {
      const res = await net.fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(text)}&type=list`, {
        signal: AbortSignal.timeout(2500),
      });
      const data = await res.json();
      const phrases = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
      for (const phrase of phrases.slice(0, 6)) {
        push({ kind: 'search', title: phrase, value: normalizeInput(phrase, engine), subtitle: 'Search' });
      }
    } catch { /* suggestions are optional */ }
  }

  return results.slice(0, 12);
}

// -------------------------------------------------------------------- menus

function showAppMenu(ctx, x, y) {
  const { tabs } = ctx;
  const menu = Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => tabs.create({}) },
    {
      label: tabs.mode === 'private' ? 'Leave private mode' : 'Private mode',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => tabs.setMode(tabs.mode === 'private' ? 'normal' : 'private'),
    },
    { type: 'separator' },
    { label: 'Bookmarks', click: () => tabs.create({ url: 'browseme://bookmarks' }) },
    { label: 'History', accelerator: 'CmdOrCtrl+Y', click: () => tabs.create({ url: 'browseme://history' }) },
    { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => tabs.create({ url: 'browseme://downloads' }) },
    { type: 'separator' },
    { label: 'Flows', click: () => tabs.create({ url: 'browseme://flows' }) },
    { label: 'Extensions', click: () => tabs.create({ url: 'browseme://extensions' }) },
    { label: 'Shields', click: () => tabs.create({ url: 'browseme://shields' }) },
    { type: 'separator' },
    { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: () => tabs.setZoom(0.1) },
    { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => tabs.setZoom(-0.1) },
    { label: 'Reset zoom', accelerator: 'CmdOrCtrl+0', click: () => tabs.resetZoom() },
    { type: 'separator' },
    { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => tabs.active?.view.webContents.print() },
    { label: 'Developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => tabs.toggleDevTools() },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => tabs.create({ url: 'browseme://settings' }) },
    { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
  ]);
  menu.popup({ window: ctx.window, x: Math.round(x), y: Math.round(y) });
}

function showTabMenu(ctx, id, x, y) {
  const { tabs } = ctx;
  const tab = tabs.tabs.get(id);
  if (!tab) return;

  const menu = Menu.buildFromTemplate([
    { label: 'Reload', click: () => tab.view.webContents.reload() },
    { label: 'Duplicate', click: () => tabs.create({ url: tab.url, mode: tab.mode, openerTabId: id }) },
    { label: tab.muted ? 'Unmute' : 'Mute', click: () => tabs.setMuted(id, !tab.muted) },
    { type: 'separator' },
    {
      label: 'Reopen in private mode',
      click: async () => {
        await tabs.setMode('private');
        tabs.create({ url: tab.url, mode: 'private' });
      },
      enabled: tab.mode === 'normal' && /^https?:/.test(tab.url),
    },
    { label: 'Copy address', click: () => clipboard.writeText(tab.url) },
    { type: 'separator' },
    { label: 'Close', click: () => tabs.close(id) },
    {
      label: 'Close other tabs',
      click: () => {
        for (const other of tabs.tabsInMode(tab.mode)) {
          if (other.id !== id) tabs.close(other.id);
        }
      },
    },
  ]);
  menu.popup({ window: ctx.window, x: Math.round(x), y: Math.round(y) });
}

/** Native context menu for page content. */
function showPageContextMenu(ctx, tabId, params) {
  const { tabs } = ctx;
  const tab = tabs.tabs.get(tabId);
  if (!tab) return;
  const wc = tab.view.webContents;
  const items = [];

  if (params.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => tabs.create({ url: params.linkURL, mode: tab.mode, background: true, openerTabId: tabId }) },
      {
        label: 'Open link in private mode',
        click: async () => {
          await tabs.setMode('private');
          tabs.create({ url: params.linkURL, mode: 'private' });
        },
      },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image') {
    items.push(
      { label: 'Open image in new tab', click: () => tabs.create({ url: params.srcURL, mode: tab.mode, openerTabId: tabId }) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image…', click: () => wc.downloadURL(params.srcURL) },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'video') {
    items.push(
      { label: 'Theater mode', click: () => wc.send('browseme:content', { type: 'theater' }) },
      { label: 'Picture in picture', click: () => wc.send('browseme:content', { type: 'pip' }) },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    items.push(
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
    );
  } else if (params.selectionText) {
    const selection = params.selectionText.trim().slice(0, 60);
    items.push(
      { role: 'copy' },
      {
        label: `Search for "${selection}"`,
        click: () => tabs.create({ url: normalizeInput(params.selectionText, ctx.store.get('settings.searchEngine', 'duckduckgo')), mode: tab.mode, openerTabId: tabId }),
      },
      {
        label: `Find videos of "${selection}"`,
        click: () => tabs.create({ url: `browseme://video?q=${encodeURIComponent(params.selectionText)}`, mode: tab.mode, openerTabId: tabId }),
      },
      { type: 'separator' },
    );
  }

  items.push(
    { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Reload', click: () => wc.reload() },
    { type: 'separator' },
    { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) },
  );

  Menu.buildFromTemplate(items).popup({ window: ctx.window });
}

module.exports = { registerIpc, showPageContextMenu, INVOKE_CHANNEL, EVENT_CHANNEL };
