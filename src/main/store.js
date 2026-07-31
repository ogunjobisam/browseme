'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * A small dot-path JSON store with debounced, atomic writes.
 *
 * Everything durable the browser keeps — settings, bookmarks, history,
 * workflows, extension registrations — lives here. Writes are debounced
 * because things like the blocked-request counter update constantly.
 */
class Store {
  /**
   * @param {string} file absolute path to the JSON file
   * @param {object} [defaults] merged under whatever is on disk
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    this._writeTimer = null;

    try {
      const raw = fs.readFileSync(file, 'utf8');
      this.data = { ...defaults, ...JSON.parse(raw) };
    } catch {
      // Missing or corrupt: start from defaults and write on first change.
    }
  }

  static _walk(obj, parts, create) {
    let node = obj;
    for (const part of parts) {
      if (node === null || typeof node !== 'object') return undefined;
      if (!(part in node)) {
        if (!create) return undefined;
        node[part] = {};
      }
      node = node[part];
    }
    return node;
  }

  get(keyPath, fallback) {
    const parts = keyPath.split('.');
    const last = parts.pop();
    const parent = Store._walk(this.data, parts, false);
    if (!parent || typeof parent !== 'object' || !(last in parent)) return fallback;
    const value = parent[last];
    return value === undefined ? fallback : value;
  }

  set(keyPath, value) {
    const parts = keyPath.split('.');
    const last = parts.pop();
    const parent = Store._walk(this.data, parts, true);
    parent[last] = value;
    this.save();
    return value;
  }

  delete(keyPath) {
    const parts = keyPath.split('.');
    const last = parts.pop();
    const parent = Store._walk(this.data, parts, false);
    if (parent && typeof parent === 'object') {
      delete parent[last];
      this.save();
    }
  }

  /** Append to an array value, keeping at most `limit` newest entries. */
  push(keyPath, value, limit = Infinity) {
    const list = this.get(keyPath, []);
    list.unshift(value);
    if (list.length > limit) list.length = limit;
    this.set(keyPath, list);
    return list;
  }

  save() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.saveNow();
    }, 400);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  saveNow() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  }
}

module.exports = { Store };
