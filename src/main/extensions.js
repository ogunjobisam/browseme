'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { extractArchiveFile, isDirectory } = require('./unzip');

/**
 * Chrome extension support.
 *
 * Electron ships Chromium's extension system, but only for unpacked
 * directories and only per-session. This wraps that into something a user
 * can actually drive: install from a folder, a .zip or a .crx, keep the
 * registration across restarts, enable/disable, and load into whichever
 * sessions currently exist.
 *
 * Private-mode sessions deliberately do not get extensions unless the
 * extension is marked as allowed in private browsing, mirroring Chrome.
 */
class ExtensionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {string} opts.installDir where unpacked archives are staged
   */
  constructor({ store, installDir }) {
    super();
    this.store = store;
    this.installDir = installDir;
    /** @type {Set<Electron.Session>} */
    this.sessions = new Set();
    /** @type {Map<string, object>} chromium extension id -> loaded record */
    this.loaded = new Map();
  }

  /** Registered extensions as persisted (independent of load state). */
  registry() {
    return this.store.get('extensions.installed', []);
  }

  _saveRegistry(list) {
    this.store.set('extensions.installed', list);
  }

  async init() {
    await fs.mkdir(this.installDir, { recursive: true });
  }

  /** Extension API entry point, which moved in newer Electron. */
  static _api(session) {
    return session.extensions || session;
  }

  /**
   * Track a session and load every enabled extension into it.
   * @param {Electron.Session} session
   * @param {'normal'|'private'} mode
   */
  async attach(session, mode) {
    if (this.sessions.has(session)) return;
    this.sessions.add(session);
    session.__browsemeMode = mode;

    for (const entry of this.registry()) {
      if (!entry.enabled) continue;
      if (mode === 'private' && !entry.allowInPrivate) continue;
      await this._loadInto(session, entry);
    }
  }

  async _loadInto(session, entry) {
    try {
      const api = ExtensionManager._api(session);
      const ext = await api.loadExtension(entry.path, { allowFileAccess: Boolean(entry.allowFileAccess) });
      this.loaded.set(`${session.__browsemeMode}:${ext.id}`, ext);
      return ext;
    } catch (err) {
      console.error(`[extensions] failed to load ${entry.name || entry.path}:`, err.message);
      this.emit('error', { entry, error: err.message });
      return null;
    }
  }

  async _unloadFrom(session, extensionId) {
    try {
      ExtensionManager._api(session).removeExtension(extensionId);
    } catch { /* not loaded in this session */ }
    this.loaded.delete(`${session.__browsemeMode}:${extensionId}`);
  }

  /**
   * Install from a directory, .zip or .crx.
   * @param {string} source absolute path
   * @returns {Promise<object>} the registry entry
   */
  async install(source) {
    let dir = source;

    if (!isDirectory(source)) {
      const stamp = crypto.createHash('sha1').update(source + Date.now()).digest('hex').slice(0, 12);
      dir = path.join(this.installDir, stamp);
      await extractArchiveFile(source, dir);
      dir = await resolveManifestRoot(dir);
    }

    const manifest = await readManifest(dir);
    const entry = {
      key: crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16),
      path: dir,
      name: manifest.name || path.basename(dir),
      version: manifest.version || '0.0.0',
      manifestVersion: manifest.manifest_version || 2,
      description: manifest.description || '',
      permissions: [...(manifest.permissions || []), ...(manifest.host_permissions || [])],
      enabled: true,
      allowInPrivate: false,
      allowFileAccess: false,
      installedAt: Date.now(),
      unpacked: dir.startsWith(this.installDir),
    };

    const list = this.registry().filter((e) => e.path !== entry.path);
    list.push(entry);
    this._saveRegistry(list);

    for (const session of this.sessions) {
      if (session.__browsemeMode === 'private') continue;
      await this._loadInto(session, entry);
    }

    this.emit('changed');
    return entry;
  }

  async setEnabled(key, enabled) {
    const list = this.registry();
    const entry = list.find((e) => e.key === key);
    if (!entry) return null;
    entry.enabled = enabled;
    this._saveRegistry(list);

    for (const session of this.sessions) {
      if (enabled) {
        if (session.__browsemeMode === 'private' && !entry.allowInPrivate) continue;
        await this._loadInto(session, entry);
      } else {
        const api = ExtensionManager._api(session);
        for (const ext of api.getAllExtensions()) {
          if (ext.path === entry.path) await this._unloadFrom(session, ext.id);
        }
      }
    }

    this.emit('changed');
    return entry;
  }

  async setPrivateAccess(key, allow) {
    const list = this.registry();
    const entry = list.find((e) => e.key === key);
    if (!entry) return null;
    entry.allowInPrivate = allow;
    this._saveRegistry(list);
    this.emit('changed');
    return entry;
  }

  async uninstall(key) {
    const list = this.registry();
    const entry = list.find((e) => e.key === key);
    if (!entry) return false;

    for (const session of this.sessions) {
      const api = ExtensionManager._api(session);
      for (const ext of api.getAllExtensions()) {
        if (ext.path === entry.path) await this._unloadFrom(session, ext.id);
      }
    }

    // Only delete files we staged ourselves — never a folder the user pointed
    // us at, which is very likely a checkout they are working in.
    if (entry.unpacked && entry.path.startsWith(this.installDir)) {
      await fs.rm(entry.path, { recursive: true, force: true }).catch(() => {});
    }

    this._saveRegistry(list.filter((e) => e.key !== key));
    this.emit('changed');
    return true;
  }

  /** Registry annotated with live load state, for the manager UI. */
  list() {
    const liveByPath = new Map();
    for (const session of this.sessions) {
      try {
        for (const ext of ExtensionManager._api(session).getAllExtensions()) {
          liveByPath.set(ext.path, ext);
        }
      } catch { /* session torn down */ }
    }

    return this.registry().map((entry) => {
      const live = liveByPath.get(entry.path);
      return {
        ...entry,
        loaded: Boolean(live),
        id: live ? live.id : null,
        icon: pickIcon(entry, live),
      };
    });
  }
}

function pickIcon(entry, live) {
  const icons = live?.manifest?.icons;
  if (!icons || !live) return null;
  const best = Object.keys(icons).map(Number).sort((a, b) => b - a)[0];
  return best ? `chrome-extension://${live.id}/${icons[String(best)]}` : null;
}

/** Some archives wrap the extension in a single top-level folder. */
async function resolveManifestRoot(dir) {
  try {
    await fs.access(path.join(dir, 'manifest.json'));
    return dir;
  } catch { /* look one level down */ }

  const children = await fs.readdir(dir, { withFileTypes: true });
  const dirs = children.filter((c) => c.isDirectory());
  for (const child of dirs) {
    const candidate = path.join(dir, child.name);
    try {
      await fs.access(path.join(candidate, 'manifest.json'));
      return candidate;
    } catch { /* keep looking */ }
  }
  return dir;
}

async function readManifest(dir) {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    // Chrome tolerates comments in manifests; JSON.parse does not.
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  }
}

module.exports = { ExtensionManager };
