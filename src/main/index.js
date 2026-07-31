'use strict';

const path = require('node:path');
const { app, BrowserWindow, net, nativeTheme } = require('electron');

const { Store } = require('./store');
const { Shields } = require('./shields');
const { SessionManager } = require('./sessions');
const { TabManager, NEW_TAB_URL } = require('./tabs');
const { ExtensionManager } = require('./extensions');
const { DownloadManager } = require('./downloads');
const { FlowManager } = require('./automation/runtime');
const { VideoSearch } = require('./video/search');
const { Overlay } = require('./overlay');
const { registerScheme, registerHandler } = require('./protocol');
const { registerIpc, showPageContextMenu } = require('./ipc');

/**
 * BrowseMe — application entry point.
 *
 * Wiring order matters: the custom scheme must be declared before the app is
 * ready, Shields must exist before any session is created (it installs the
 * request filters), and the window is only shown once the first tab has a
 * surface to paint, so the user never sees an empty frame.
 */

const CHROME_PRELOAD = path.join(__dirname, '..', 'preload', 'browser.js');
const CHROME_PAGE = path.join(__dirname, '..', 'renderer', 'chrome.html');

const DEFAULT_SETTINGS = {
  searchEngine: 'duckduckgo',
  searchSuggestions: true,
  saveHistory: true,
  spellcheck: true,
  theme: 'system',
  restoreTabs: true,
  homepage: NEW_TAB_URL,
  videoBigTiles: true,
};

registerScheme();

// A second launch should focus the running window rather than start a rival
// process fighting over the same profile directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

class BrowseMe {
  constructor() {
    this.store = new Store(path.join(app.getPath('userData'), 'browseme.json'), {
      settings: DEFAULT_SETTINGS,
    });
    this.store.set('settings', { ...DEFAULT_SETTINGS, ...this.store.get('settings', {}) });

    this.window = null;
    this.tabs = null;
    this.overlay = null;
  }

  async start() {
    registerHandler();

    this.shields = new Shields({
      store: this.store,
      cacheDir: path.join(app.getPath('userData'), 'filterlists'),
      resolveTabUrl: (id) => this.tabs?.resolveTabUrl(id),
      fetchImpl: (url) => net.fetch(url),
    });

    this.sessions = new SessionManager({
      store: this.store,
      shields: this.shields,
      onPermissionRequest: (request) => this.overlay
        ? this.overlay.requestPermission(request)
        : Promise.resolve(false),
      // Sessions are created lazily, the first time a tab needs that mode.
      onSessionCreated: (session, mode) => {
        this.downloads.attach(session, mode);
        void this.extensions.attach(session, mode);
      },
    });

    this.extensions = new ExtensionManager({
      store: this.store,
      installDir: path.join(app.getPath('userData'), 'extensions'),
    });

    this.downloads = new DownloadManager({ store: this.store });
    this.video = new VideoSearch((url, init) => net.fetch(url, init));

    // Shields loads its bundled list synchronously enough to be ready before
    // the first request; remote lists stream in behind it.
    await this.shields.init();
    await this.extensions.init();

    this.createWindow();
    this.applyTheme();
  }

  createWindow() {
    const bounds = this.store.get('window.bounds', { width: 1440, height: 900 });

    this.window = new BrowserWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: '#f1f3f4',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      titleBarOverlay: process.platform === 'win32'
        ? { color: '#f1f3f4', symbolColor: '#3c4043', height: 40 }
        : false,
      webPreferences: {
        preload: CHROME_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Marks this renderer as the browser's own UI, which is what the
        // preload keys the IPC bridge off for non-browseme:// documents.
        additionalArguments: ['--browseme-surface=chrome'],
      },
    });

    if (this.store.get('window.maximized', false)) this.window.maximize();

    this.tabs = new TabManager({
      window: this.window,
      sessions: this.sessions,
      store: this.store,
      shields: this.shields,
    });

    this.overlay = new Overlay(this.window);

    this.flows = new FlowManager({
      store: this.store,
      tabs: this.tabs,
      shields: this.shields,
    });

    this.ctx = {
      window: this.window,
      store: this.store,
      tabs: this.tabs,
      shields: this.shields,
      sessions: this.sessions,
      extensions: this.extensions,
      flows: this.flows,
      downloads: this.downloads,
      video: this.video,
      overlay: this.overlay,
      broadcast: (type, payload) => this.broadcast(type, payload),
    };

    registerIpc(this.ctx);
    this.wireEvents();

    this.window.loadFile(CHROME_PAGE);

    this.window.webContents.once('did-finish-load', () => {
      this.restoreOrOpenTabs();
      this.window.show();
      this.flows.runStartupFlows();
    });
  }

  wireEvents() {
    const push = () => this.broadcast('tabs-changed', this.tabs.serialize());

    this.tabs.on('changed', push);
    this.tabs.on('mode-changed', (mode) => this.broadcast('mode-changed', mode));
    this.tabs.on('context-menu', ({ tabId, params }) => showPageContextMenu(this.ctx, tabId, params));
    this.tabs.on('found-in-page', (payload) => this.broadcast('found-in-page', payload));
    this.tabs.on('fullscreen', (on) => {
      // Full-screen video should own the whole window, chrome included.
      this.tabs.setLayout(on ? { top: 0, bottom: 0 } : { top: this.tabs.chromeTop || 88 });
      this.broadcast('fullscreen', on);
    });

    this.shields.on('counts-changed', () => {
      this.broadcast('shields-counts', this.tabs.serialize());
    });
    this.shields.on('lists-changed', () => this.broadcast('shields-summary', this.shields.summary()));

    this.extensions.on('changed', () => this.broadcast('extensions-changed', this.extensions.list()));
    this.extensions.on('error', (payload) => this.broadcast('extensions-error', payload));

    this.downloads.on('changed', () => this.broadcast('downloads-changed', this.downloads.list()));
    this.downloads.on('done', (record) => this.broadcast('download-done', record));

    this.flows.on('changed', () => this.broadcast('flows-changed', this.flows.list()));
    this.flows.on('run-started', (payload) => this.broadcast('flow-run-started', payload));
    this.flows.on('run-finished', (payload) => this.broadcast('flow-run-finished', payload));

    this.window.on('resize', () => {
      this.tabs.setLayout({});
      if (this.overlay.visible) this.overlay.setBounds(null);
      this.saveWindowBounds();
    });
    this.window.on('move', () => this.saveWindowBounds());
    this.window.on('maximize', () => {
      this.store.set('window.maximized', true);
      this.broadcast('window-state', { maximized: true });
    });
    this.window.on('unmaximize', () => {
      this.store.set('window.maximized', false);
      this.broadcast('window-state', { maximized: false });
    });

    this.window.on('close', () => this.persistSession());
    this.window.on('closed', () => {
      this.tabs.destroy();
      this.flows.destroy();
      this.overlay.destroy();
      this.window = null;
    });

    nativeTheme.on('updated', () => this.broadcast('theme-changed', {
      dark: nativeTheme.shouldUseDarkColors,
    }));
  }

  restoreOrOpenTabs() {
    const restore = this.store.get('settings.restoreTabs', true);
    const saved = restore ? this.store.get('session.tabs', []) : [];
    const urls = saved.filter((url) => typeof url === 'string' && url);

    if (!urls.length) {
      this.tabs.create({ url: this.store.get('settings.homepage', NEW_TAB_URL) });
      return;
    }
    urls.forEach((url, index) => this.tabs.create({ url, background: index > 0 }));
  }

  persistSession() {
    if (!this.tabs) return;
    // Only normal-mode tabs are ever written down.
    const urls = this.tabs.tabsInMode('normal')
      .map((tab) => tab.url)
      .filter((url) => /^(https?|browseme):/.test(url));
    this.store.set('session.tabs', urls);
    this.store.saveNow();
  }

  saveWindowBounds() {
    if (!this.window || this.window.isMaximized() || this.window.isMinimized()) return;
    this.store.set('window.bounds', this.window.getBounds());
  }

  applyTheme() {
    const theme = this.store.get('settings.theme', 'system');
    nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
  }

  broadcast(type, payload) {
    if (this.window && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send('browseme:event', { type, payload });
    }
  }
}

const browser = new BrowseMe();

app.whenReady().then(() => browser.start());

app.on('second-instance', () => {
  if (browser.window) {
    if (browser.window.isMinimized()) browser.window.restore();
    browser.window.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) browser.createWindow();
});

app.on('before-quit', () => {
  browser.persistSession();
});

// Never let a page's certificate error be silently accepted.
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  callback(false);
});

// Web content must not be able to spawn a privileged renderer.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

// `browser` is exported so an integration harness can drive the running
// instance directly instead of poking at it through the UI.
module.exports = { BrowseMe, DEFAULT_SETTINGS, browser };
