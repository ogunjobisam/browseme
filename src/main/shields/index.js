'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { FilterEngine } = require('./engine');
const { FilterListStore } = require('./lists');
const { registrableDomain, isThirdParty } = require('./psl');

const BASE_LIST = path.join(__dirname, 'lists', 'base.txt');

// Electron resource types -> the type names used in filter options.
const RESOURCE_TYPE_MAP = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const DEFAULT_SITE_SETTINGS = {
  enabled: true,
  blockCosmetic: true,
  blockGenericCosmetic: true,
  upgradeHttps: true,
  blockThirdPartyCookies: true,
  trimReferrer: true,
};

const LOCAL_HOST_RE = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|.*\.local|.*\.localhost)$/i;

/**
 * Shields: the per-site privacy controller.
 *
 * Owns the filter engine, decides per request whether to block, keeps the
 * per-tab counters the toolbar badge reads, and exposes the per-site
 * overrides the Shields panel writes to.
 */
class Shields extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../store')} opts.store persisted settings
   * @param {string} opts.cacheDir where downloaded lists live
   * @param {(webContentsId: number) => string|undefined} opts.resolveTabUrl
   * @param {(url: string) => Promise<Response>} [opts.fetchImpl]
   */
  constructor({ store, cacheDir, resolveTabUrl, fetchImpl }) {
    super();
    this.store = store;
    this.engine = new FilterEngine();
    this.lists = new FilterListStore(cacheDir, fetchImpl);
    this.resolveTabUrl = resolveTabUrl || (() => undefined);

    /** @type {Map<number, {count: number, byCategory: Record<string, number>, hosts: Set<string>}>} */
    this.tabStats = new Map();
    this.totalBlocked = store.get('shields.totalBlocked', 0);
    this.ready = false;
    this._attached = new WeakSet();
    this._flushTimer = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load the bundled list immediately, then remote lists in the background. */
  async init() {
    await this.lists.init();

    try {
      const base = await fs.readFile(BASE_LIST, 'utf8');
      this.engine.addFilters(base);
    } catch (err) {
      console.error('[shields] bundled list failed to load:', err.message);
    }

    this.ready = true;
    this.emit('ready', this.summary());

    // Cached lists first (fast, offline), then refresh anything stale.
    void this.loadLists({ allowNetwork: false }).then(() => this.refreshLists());
  }

  enabledListIds() {
    return this.store.get('shields.lists', FilterListStore.defaultEnabledIds());
  }

  async setListEnabled(id, enabled) {
    const current = new Set(this.enabledListIds());
    if (enabled) current.add(id);
    else current.delete(id);
    this.store.set('shields.lists', [...current]);
    await this.rebuild();
  }

  /** Rebuild the engine from scratch — needed when a list is turned off. */
  async rebuild() {
    this.engine = new FilterEngine();
    try {
      this.engine.addFilters(await fs.readFile(BASE_LIST, 'utf8'));
    } catch { /* base list is optional at this point */ }
    await this.loadLists({ allowNetwork: false });
    this.engine.addFilters(this.customFilters());
    this.emit('lists-changed', this.summary());
  }

  async loadLists({ allowNetwork = true } = {}) {
    for (const id of this.enabledListIds()) {
      const body = await this.lists.load(id, { allowNetwork });
      if (body) this.engine.addFilters(body);
    }
    this.engine.addFilters(this.customFilters());
    this.emit('lists-changed', this.summary());
  }

  /** Download every stale enabled list, then rebuild once. */
  async refreshLists({ force = false } = {}) {
    let changed = false;
    for (const id of this.enabledListIds()) {
      if (!force && !this.lists.isStale(id)) continue;
      const body = await this.lists.download(id);
      if (body) changed = true;
    }
    if (changed) await this.rebuild();
    return this.summary();
  }

  customFilters() {
    return this.store.get('shields.customFilters', '');
  }

  async setCustomFilters(text) {
    this.store.set('shields.customFilters', text);
    await this.rebuild();
  }

  // ------------------------------------------------------------ site settings

  /** Effective settings for a hostname: defaults <- global <- per-site. */
  settingsFor(hostname) {
    const globals = this.store.get('shields.defaults', {});
    const site = hostname
      ? this.store.get(`shields.sites.${registrableDomain(hostname)}`, {})
      : {};
    return { ...DEFAULT_SITE_SETTINGS, ...globals, ...site };
  }

  setSiteSetting(hostname, patch) {
    const key = `shields.sites.${registrableDomain(hostname)}`;
    const next = { ...this.store.get(key, {}), ...patch };
    this.store.set(key, next);
    this.emit('site-settings-changed', { hostname, settings: this.settingsFor(hostname) });
    return this.settingsFor(hostname);
  }

  clearSiteSetting(hostname) {
    this.store.delete(`shields.sites.${registrableDomain(hostname)}`);
    return this.settingsFor(hostname);
  }

  setGlobalSetting(patch) {
    const next = { ...this.store.get('shields.defaults', {}), ...patch };
    this.store.set('shields.defaults', next);
    this.emit('site-settings-changed', { hostname: null, settings: next });
    return next;
  }

  // -------------------------------------------------------------- attachment

  /**
   * Wire the request filters onto a session. Safe to call once per session.
   * @param {Electron.Session} session
   */
  attach(session) {
    if (this._attached.has(session)) return;
    this._attached.add(session);

    session.webRequest.onBeforeRequest((details, callback) => {
      try {
        callback(this._onBeforeRequest(details));
      } catch (err) {
        console.error('[shields] request filter error:', err);
        callback({});
      }
    });

    session.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        callback(this._onBeforeSendHeaders(details));
      } catch {
        callback({ requestHeaders: details.requestHeaders });
      }
    });

    session.webRequest.onHeadersReceived((details, callback) => {
      try {
        callback(this._onHeadersReceived(details));
      } catch {
        callback({ responseHeaders: details.responseHeaders });
      }
    });
  }

  /** Document URL for a request, preferring the frame tree over the tab. */
  _documentUrlFor(details) {
    const frame = details.frame;
    if (frame) {
      try {
        const top = frame.top || frame;
        if (top && top.url) return top.url;
      } catch { /* frame may already be gone */ }
    }
    if (typeof details.webContentsId === 'number') {
      const tabUrl = this.resolveTabUrl(details.webContentsId);
      if (tabUrl) return tabUrl;
    }
    return details.referrer || details.url;
  }

  _onBeforeRequest(details) {
    const type = RESOURCE_TYPE_MAP[details.resourceType] || 'other';
    const documentUrl = type === 'document' ? details.url : this._documentUrlFor(details);

    let documentHostname = '';
    try { documentHostname = new URL(documentUrl).hostname; } catch { /* opaque */ }

    const settings = this.settingsFor(documentHostname);
    if (!settings.enabled) return {};

    let requestHostname = '';
    try { requestHostname = new URL(details.url).hostname; } catch { return {}; }

    const verdict = this.engine.match({
      url: details.url,
      hostname: requestHostname,
      documentHostname,
      type,
    });

    if (verdict.blocked) {
      // Never block the page the user actually asked for — a bad rule on a
      // main frame turns into a blank window with no way back.
      if (type !== 'document') {
        this._recordBlock(details.webContentsId, requestHostname, type);
        return { cancel: true };
      }
    }

    if (
      settings.upgradeHttps &&
      details.url.startsWith('http://') &&
      !LOCAL_HOST_RE.test(requestHostname) &&
      (type === 'document' || type === 'subdocument')
    ) {
      return { redirectURL: 'https://' + details.url.slice('http://'.length) };
    }

    return {};
  }

  _onBeforeSendHeaders(details) {
    const headers = details.requestHeaders;
    const documentUrl = this._documentUrlFor(details);
    let documentHostname = '';
    let requestHostname = '';
    try { documentHostname = new URL(documentUrl).hostname; } catch { /* opaque */ }
    try { requestHostname = new URL(details.url).hostname; } catch { /* opaque */ }

    const settings = this.settingsFor(documentHostname);
    if (!settings.enabled) return { requestHeaders: headers };

    if (settings.trimReferrer && isThirdParty(requestHostname, documentHostname)) {
      const referer = headers.Referer || headers.referer;
      if (referer) {
        try {
          // Send only the origin cross-site: enough for anti-CSRF checks,
          // no path or query for the receiving party to log.
          const origin = new URL(referer).origin + '/';
          if (headers.Referer) headers.Referer = origin;
          if (headers.referer) headers.referer = origin;
        } catch { /* leave malformed referrers alone */ }
      }
    }

    return { requestHeaders: headers };
  }

  _onHeadersReceived(details) {
    const headers = details.responseHeaders;
    if (!headers) return { responseHeaders: headers };

    const documentUrl = this._documentUrlFor(details);
    let documentHostname = '';
    let requestHostname = '';
    try { documentHostname = new URL(documentUrl).hostname; } catch { /* opaque */ }
    try { requestHostname = new URL(details.url).hostname; } catch { /* opaque */ }

    const settings = this.settingsFor(documentHostname);
    if (settings.enabled && settings.blockThirdPartyCookies &&
        isThirdParty(requestHostname, documentHostname)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'set-cookie') delete headers[key];
      }
    }

    return { responseHeaders: headers };
  }

  // ------------------------------------------------------------------ counts

  _recordBlock(webContentsId, hostname, type) {
    this.totalBlocked++;
    if (typeof webContentsId !== 'number') return;

    let stat = this.tabStats.get(webContentsId);
    if (!stat) {
      stat = { count: 0, byCategory: {}, hosts: new Set() };
      this.tabStats.set(webContentsId, stat);
    }
    stat.count++;
    stat.byCategory[type] = (stat.byCategory[type] || 0) + 1;
    if (stat.hosts.size < 200) stat.hosts.add(hostname);

    // Blocked requests arrive in bursts; coalesce UI updates.
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.store.set('shields.totalBlocked', this.totalBlocked);
        this.emit('counts-changed');
      }, 250);
    }
  }

  statsFor(webContentsId) {
    const stat = this.tabStats.get(webContentsId);
    if (!stat) return { count: 0, byCategory: {}, hosts: [] };
    return { count: stat.count, byCategory: { ...stat.byCategory }, hosts: [...stat.hosts] };
  }

  resetTab(webContentsId) {
    this.tabStats.delete(webContentsId);
  }

  /**
   * Selectors for a page, honouring that page's shield settings.
   * @param {string} hostname
   * @param {string[]} [tokens] class names and ids present in the document
   */
  cosmeticFor(hostname, tokens) {
    const settings = this.settingsFor(hostname);
    if (!settings.enabled || !settings.blockCosmetic) return [];
    return this.engine.getCosmeticSelectors(hostname, {
      generic: settings.blockGenericCosmetic,
      tokens,
    });
  }

  summary() {
    return {
      ready: this.ready,
      rules: this.engine.stats,
      totalBlocked: this.totalBlocked,
      lists: this.lists.status().map((l) => ({
        ...l,
        enabled: this.enabledListIds().includes(l.id),
      })),
    };
  }
}

module.exports = { Shields, DEFAULT_SITE_SETTINGS, RESOURCE_TYPE_MAP };
