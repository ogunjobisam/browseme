'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebContentsView, shell } = require('electron');

const CONTENT_PRELOAD = path.join(__dirname, '..', 'preload', 'browser.js');
const NEW_TAB_URL = 'browseme://newtab';

let nextTabId = 1;

/**
 * Tab manager.
 *
 * Tabs are `WebContentsView`s stacked on the window above the browser chrome.
 * Every tab is stamped with a mode — `normal` or `private` — and the window
 * shows exactly one mode at a time. That is what turns incognito from "a
 * second window" into a switch: flipping the mode hides one set of tabs and
 * reveals the other, and both keep running.
 */
class TabManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Electron.BrowserWindow} opts.window
   * @param {import('./sessions').SessionManager} opts.sessions
   * @param {import('./store').Store} opts.store
   * @param {import('./shields').Shields} opts.shields
   */
  constructor({ window, sessions, store, shields }) {
    super();
    this.window = window;
    this.sessions = sessions;
    this.store = store;
    this.shields = shields;

    /** @type {Map<number, object>} */
    this.tabs = new Map();
    /** @type {{normal: number|null, private: number|null}} */
    this.activeByMode = { normal: null, private: null };
    this.mode = 'normal';

    this.layout = { top: 88, bottom: 0, left: 0, right: 0 };
    this._destroyed = false;
  }

  // ------------------------------------------------------------------ helpers

  get activeId() {
    return this.activeByMode[this.mode];
  }

  get active() {
    const id = this.activeId;
    return id ? this.tabs.get(id) : null;
  }

  tabsInMode(mode = this.mode) {
    return [...this.tabs.values()].filter((t) => t.mode === mode);
  }

  byWebContentsId(id) {
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === id) return tab;
    }
    return null;
  }

  /** Top-level URL for a web contents id — used by Shields for 1p/3p checks. */
  resolveTabUrl(webContentsId) {
    const tab = this.byWebContentsId(webContentsId);
    return tab ? tab.url : undefined;
  }

  // -------------------------------------------------------------------- CRUD

  /**
   * Open a tab.
   * @param {object} [opts]
   * @param {string} [opts.url]
   * @param {'normal'|'private'} [opts.mode] defaults to the current mode
   * @param {boolean} [opts.background] open without focusing
   * @param {number} [opts.openerTabId] insert directly after this tab
   */
  create({ url = NEW_TAB_URL, mode = this.mode, background = false, openerTabId = null } = {}) {
    const session = this.sessions.for(mode);
    const view = new WebContentsView({
      webPreferences: {
        session,
        preload: CONTENT_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: this.store.get('settings.spellcheck', true),
        // Tabs are untrusted: the preload only exposes the IPC bridge when
        // the document itself is a browseme:// page.
        additionalArguments: [`--browseme-mode=${mode}`],
      },
    });

    view.setBackgroundColor(mode === 'private' ? '#1c1b22' : '#ffffff');

    const tab = {
      id: nextTabId++,
      mode,
      view,
      url,
      pendingUrl: url,
      title: 'New tab',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      pinned: false,
      blocked: 0,
      createdAt: Date.now(),
    };

    this.tabs.set(tab.id, tab);
    this._wireEvents(tab);

    // Insert after the opener so ctrl-clicked links land next to their source.
    if (openerTabId) {
      const order = this.tabsInMode(mode).map((t) => t.id);
      const at = order.indexOf(openerTabId);
      if (at !== -1) this._reinsert(tab.id, at + 1);
    }

    this.window.contentView.addChildView(view);
    view.webContents.loadURL(url).catch((err) => {
      if (!err.message.includes('ERR_ABORTED')) console.error('[tabs] load failed:', err.message);
    });

    if (!background || this.activeByMode[mode] === null) {
      this.select(tab.id);
    } else {
      this._applyVisibility();
    }

    this.emit('changed');
    return tab;
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const siblings = this.tabsInMode(tab.mode).map((t) => t.id);
    const index = siblings.indexOf(id);

    this.tabs.delete(id);
    try {
      this.window.contentView.removeChildView(tab.view);
    } catch { /* window may be closing */ }
    if (!tab.view.webContents.isDestroyed()) {
      this.shields.resetTab(tab.view.webContents.id);
      tab.view.webContents.close();
    }

    if (this.activeByMode[tab.mode] === id) {
      const remaining = this.tabsInMode(tab.mode).map((t) => t.id);
      const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
      this.activeByMode[tab.mode] = next;
      if (next) this.select(next);
    }

    // Closing the last normal tab closes the window; the last private tab
    // just drops you back to normal browsing, which is what the switch means.
    if (this.tabsInMode('normal').length === 0 && this.mode === 'normal') {
      this.create({ url: NEW_TAB_URL, mode: 'normal' });
    }
    if (this.mode === 'private' && this.tabsInMode('private').length === 0) {
      void this.setMode('normal');
    }

    this._applyVisibility();
    this.emit('changed');
  }

  select(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.mode = tab.mode;
    this.activeByMode[tab.mode] = id;
    this._applyVisibility();
    this._applyBounds();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
    this.emit('changed');
  }

  /** Move a tab to a new index within its own mode's strip. */
  _reinsert(id, index) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const entries = [...this.tabs.entries()];
    const others = entries.filter(([tid]) => tid !== id);

    const modeIds = others.filter(([, t]) => t.mode === tab.mode).map(([tid]) => tid);
    const clamped = Math.max(0, Math.min(index, modeIds.length));
    const anchor = modeIds[clamped];

    const rebuilt = new Map();
    let inserted = false;
    for (const [tid, t] of others) {
      if (tid === anchor) {
        rebuilt.set(id, tab);
        inserted = true;
      }
      rebuilt.set(tid, t);
    }
    if (!inserted) rebuilt.set(id, tab);
    this.tabs = rebuilt;
  }

  move(id, index) {
    this._reinsert(id, index);
    this.emit('changed');
  }

  // ------------------------------------------------------------------- modes

  /**
   * Flip the browser between normal and private browsing.
   * @param {'normal'|'private'} mode
   */
  async setMode(mode) {
    if (mode === this.mode) return this.mode;
    const leavingPrivate = this.mode === 'private' && mode === 'normal';

    this.mode = mode;

    if (leavingPrivate) {
      // Closing out of private mode must actually destroy the session, not
      // just hide it. Any private tabs still open go with it.
      for (const tab of this.tabsInMode('private')) {
        this.tabs.delete(tab.id);
        try { this.window.contentView.removeChildView(tab.view); } catch { /* closing */ }
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
      this.activeByMode.private = null;
      await this.sessions.resetPrivate();
    }

    if (this.tabsInMode(mode).length === 0) {
      this.create({ url: NEW_TAB_URL, mode });
    } else {
      const current = this.activeByMode[mode] ?? this.tabsInMode(mode)[0].id;
      this.select(current);
    }

    this._applyVisibility();
    this.emit('mode-changed', mode);
    this.emit('changed');
    return this.mode;
  }

  // ------------------------------------------------------------------ layout

  setLayout(patch) {
    this.layout = { ...this.layout, ...patch };
    // Remember the last real chrome height so leaving full screen can restore
    // it without the renderer having to report again.
    if (this.layout.top > 0) this.chromeTop = this.layout.top;
    this._applyBounds();
  }

  _applyBounds() {
    if (this._destroyed || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    const { top, bottom, left, right } = this.layout;
    const bounds = {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(width - left - right)),
      height: Math.max(0, Math.round(height - top - bottom)),
    };
    for (const tab of this.tabs.values()) {
      tab.view.setBounds(bounds);
    }
  }

  _applyVisibility() {
    const activeId = this.activeId;
    for (const tab of this.tabs.values()) {
      const visible = tab.id === activeId;
      if (typeof tab.view.setVisible === 'function') {
        tab.view.setVisible(visible);
      } else {
        // Older Electron: park hidden views off-screen at zero size.
        if (!visible) tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    }
    if (typeof this.tabs.get(activeId)?.view.setVisible !== 'function') this._applyBounds();
  }

  // ------------------------------------------------------------- navigation

  _withActive(fn) {
    const tab = this.active;
    if (!tab || tab.view.webContents.isDestroyed()) return;
    fn(tab.view.webContents, tab);
  }

  navigate(input, tabId = this.activeId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const url = normalizeInput(input, this.store.get('settings.searchEngine', 'duckduckgo'));
    tab.pendingUrl = url;
    tab.view.webContents.loadURL(url).catch((err) => {
      if (!err.message.includes('ERR_ABORTED')) console.error('[tabs] navigate failed:', err.message);
    });
  }

  goBack() { this._withActive((wc) => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); }); }
  goForward() { this._withActive((wc) => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); }); }
  reload({ ignoreCache = false } = {}) {
    this._withActive((wc) => (ignoreCache ? wc.reloadIgnoringCache() : wc.reload()));
  }
  stop() { this._withActive((wc) => wc.stop()); }
  toggleDevTools() {
    this._withActive((wc) => (wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'bottom' })));
  }
  setMuted(id, muted) {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.setAudioMuted(muted);
    tab.muted = muted;
    this.emit('changed');
  }
  setZoom(delta) {
    this._withActive((wc) => {
      const next = Math.max(0.25, Math.min(5, wc.zoomFactor + delta));
      wc.zoomFactor = next;
    });
  }
  resetZoom() { this._withActive((wc) => { wc.zoomFactor = 1; }); }

  // ------------------------------------------------------------------ events

  _wireEvents(tab) {
    const wc = tab.view.webContents;
    const touch = () => this.emit('changed');

    const syncNav = () => {
      tab.canGoBack = wc.navigationHistory.canGoBack();
      tab.canGoForward = wc.navigationHistory.canGoForward();
    };

    wc.on('page-title-updated', (_e, title) => { tab.title = title; touch(); });

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons && favicons.length ? favicons[0] : null;
      touch();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.shields.resetTab(wc.id);
      tab.blocked = 0;
      touch();
    });

    wc.on('did-stop-loading', () => { tab.loading = false; syncNav(); touch(); });

    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return;
      tab.pendingUrl = event.url;
      touch();
    });

    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      syncNav();
      this._recordHistory(tab, url);
      touch();
    });

    wc.on('did-finish-load', () => {
      this.emit('page-loaded', { tabId: tab.id, url: tab.url, mode: tab.mode });
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      syncNav();
      touch();
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
      tab.loading = false;
      const params = new URLSearchParams({ url: validatedURL, code: String(code), description });
      wc.loadURL(`browseme://error?${params}`).catch(() => {});
    });

    wc.on('audio-state-changed', (_e, { audible }) => { tab.audible = audible; touch(); });

    wc.on('render-process-gone', (_e, details) => {
      tab.loading = false;
      tab.title = 'Page crashed';
      console.error('[tabs] renderer gone:', details.reason);
      touch();
    });

    // Popups become tabs. Anything that is not http(s) goes to the OS so a
    // page cannot drive the browser into an arbitrary protocol handler.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:$/.test(safeProtocol(url)) || url.startsWith('browseme:')) {
        this.create({
          url,
          mode: tab.mode,
          background: disposition === 'background-tab',
          openerTabId: tab.id,
        });
      } else if (/^(mailto|tel):$/.test(safeProtocol(url))) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      const protocol = safeProtocol(url);
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'browseme:' && protocol !== 'about:') {
        event.preventDefault();
        if (protocol === 'mailto:' || protocol === 'tel:') void shell.openExternal(url);
      }
    });

    wc.on('context-menu', (_e, params) => {
      this.emit('context-menu', { tabId: tab.id, params });
    });

    wc.on('found-in-page', (_e, result) => {
      this.emit('found-in-page', { tabId: tab.id, result });
    });

    wc.on('enter-html-full-screen', () => this.emit('fullscreen', true));
    wc.on('leave-html-full-screen', () => this.emit('fullscreen', false));
  }

  _recordHistory(tab, url) {
    if (tab.mode === 'private') return;              // the whole point
    if (!/^https?:/.test(url)) return;
    if (!this.store.get('settings.saveHistory', true)) return;

    this.store.push('history', {
      url,
      title: tab.title,
      visitedAt: Date.now(),
    }, 5000);
  }

  // ---------------------------------------------------------------- snapshot

  /** Serialisable state for the chrome UI. */
  serialize() {
    const list = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      mode: tab.mode,
      title: tab.title || hostOf(tab.url) || 'New tab',
      url: tab.url,
      displayUrl: tab.loading ? tab.pendingUrl : tab.url,
      favicon: tab.favicon,
      loading: tab.loading,
      audible: tab.audible,
      muted: tab.muted,
      pinned: tab.pinned,
      active: tab.id === this.activeByMode[tab.mode],
      blocked: tab.view.webContents.isDestroyed()
        ? 0
        : this.shields.statsFor(tab.view.webContents.id).count,
    }));

    const active = this.active;
    return {
      mode: this.mode,
      tabs: list,
      activeId: this.activeId,
      canGoBack: active ? active.canGoBack : false,
      canGoForward: active ? active.canGoForward : false,
      loading: active ? active.loading : false,
    };
  }

  destroy() {
    this._destroyed = true;
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
  }
}

function safeProtocol(url) {
  try { return new URL(url).protocol; } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  google: 'https://www.google.com/search?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  startpage: 'https://www.startpage.com/sp/search?query=%s',
  ecosia: 'https://www.ecosia.org/search?q=%s',
};

/**
 * Turn omnibox text into a URL: keep real URLs, guess bare hostnames,
 * and search everything else.
 */
function normalizeInput(input, engine = 'duckduckgo') {
  const text = String(input || '').trim();
  if (!text) return NEW_TAB_URL;

  if (/^(https?|browseme|file|about|data|view-source):/i.test(text)) return text;
  if (text.startsWith('//')) return 'https:' + text;

  // Looks like a host (optionally with port/path) and has no spaces.
  const looksLikeHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(text);
  const isLocalhost = /^localhost(:\d+)?(\/.*)?$/i.test(text);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(text);
  if (looksLikeHost || isLocalhost || isIp) return 'https://' + text;

  const template = SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo;
  return template.replace('%s', encodeURIComponent(text));
}

module.exports = { TabManager, normalizeInput, SEARCH_ENGINES, NEW_TAB_URL };
