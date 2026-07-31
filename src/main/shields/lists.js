'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Filter list catalog + on-disk cache.
 *
 * The bundled base list makes blocking work offline and on first run; the
 * remote lists are what make it comprehensive. Lists are cached under the
 * user data directory and refreshed in the background, never on the hot path
 * of a page load.
 */

const REFRESH_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

const CATALOG = [
  {
    id: 'easylist',
    title: 'EasyList',
    description: 'The primary list of advertising filters.',
    url: 'https://easylist.to/easylist/easylist.txt',
    defaultEnabled: true,
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    description: 'Tracking scripts, analytics beacons and pixels.',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    defaultEnabled: true,
  },
  {
    id: 'ublock-filters',
    title: 'uBlock Origin — Ads',
    description: "uBlock's own additions on top of EasyList.",
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    defaultEnabled: true,
  },
  {
    id: 'ublock-privacy',
    title: 'uBlock Origin — Privacy',
    description: 'Extra anti-tracking rules.',
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
    defaultEnabled: true,
  },
  {
    id: 'ublock-badware',
    title: 'uBlock Origin — Badware',
    description: 'Domains known to host malware and scams.',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
    defaultEnabled: true,
  },
  {
    id: 'easylist-cookie',
    title: 'EasyList Cookie',
    description: 'Removes cookie-consent banners.',
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    defaultEnabled: true,
  },
  {
    id: 'peter-lowe',
    title: "Peter Lowe's Ad & Tracking Servers",
    description: 'A long-maintained server blocklist.',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    defaultEnabled: true,
  },
  {
    id: 'fanboy-annoyance',
    title: 'Fanboy Annoyances',
    description: 'Newsletter popups, social widgets, in-page nags. Can be aggressive.',
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    defaultEnabled: false,
  },
  {
    id: 'fanboy-social',
    title: 'Fanboy Social',
    description: 'Social media share buttons and embeds.',
    url: 'https://secure.fanboy.co.nz/fanboy-social.txt',
    defaultEnabled: false,
  },
];

class FilterListStore {
  /**
   * @param {string} cacheDir directory to hold downloaded lists
   * @param {(url: string) => Promise<Response>} fetchImpl injectable for tests
   */
  constructor(cacheDir, fetchImpl) {
    this.cacheDir = cacheDir;
    this.fetch = fetchImpl || globalThis.fetch;
    /** @type {Map<string, {fetchedAt: number, bytes: number, error?: string}>} */
    this.meta = new Map();
  }

  static get catalog() {
    return CATALOG;
  }

  static defaultEnabledIds() {
    return CATALOG.filter((l) => l.defaultEnabled).map((l) => l.id);
  }

  _pathFor(id) {
    return path.join(this.cacheDir, `${id}.txt`);
  }

  _metaPath() {
    return path.join(this.cacheDir, 'meta.json');
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    try {
      const raw = await fs.readFile(this._metaPath(), 'utf8');
      this.meta = new Map(Object.entries(JSON.parse(raw)));
    } catch {
      this.meta = new Map();
    }
  }

  async _saveMeta() {
    try {
      await fs.writeFile(this._metaPath(), JSON.stringify(Object.fromEntries(this.meta), null, 2));
    } catch {
      /* cache metadata is best-effort */
    }
  }

  /** Read a cached list body, or null when absent. */
  async read(id) {
    try {
      return await fs.readFile(this._pathFor(id), 'utf8');
    } catch {
      return null;
    }
  }

  isStale(id) {
    const meta = this.meta.get(id);
    if (!meta || !meta.fetchedAt) return true;
    return Date.now() - meta.fetchedAt > REFRESH_INTERVAL_MS;
  }

  /**
   * Download a list and cache it. Returns the body, or null on failure —
   * callers fall back to whatever is already cached.
   */
  async download(id) {
    const entry = CATALOG.find((l) => l.id === id);
    if (!entry) throw new Error(`Unknown filter list: ${id}`);

    try {
      const res = await this.fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (body.length < 100) throw new Error('suspiciously small response');

      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this._pathFor(id), body, 'utf8');
      this.meta.set(id, { fetchedAt: Date.now(), bytes: body.length });
      await this._saveMeta();
      return body;
    } catch (err) {
      const prev = this.meta.get(id) || {};
      this.meta.set(id, { ...prev, error: String(err.message || err), triedAt: Date.now() });
      await this._saveMeta();
      return null;
    }
  }

  /** Cached body if fresh, otherwise download; falls back to stale cache. */
  async load(id, { allowNetwork = true } = {}) {
    const cached = await this.read(id);
    if (cached && !this.isStale(id)) return cached;
    if (!allowNetwork) return cached;
    const fresh = await this.download(id);
    return fresh || cached;
  }

  status() {
    return CATALOG.map((entry) => ({
      ...entry,
      ...(this.meta.get(entry.id) || {}),
      stale: this.isStale(entry.id),
    }));
  }
}

module.exports = { FilterListStore, CATALOG, REFRESH_INTERVAL_MS };
