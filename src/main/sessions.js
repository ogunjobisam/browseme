'use strict';

const { session: electronSession } = require('electron');

const { registerHandler } = require('./protocol');

/**
 * Session management for the two browsing modes.
 *
 * Normal mode uses a persistent partition. Private mode uses an in-memory
 * partition whose name carries a generation counter — leaving private mode
 * bumps the generation, so the next private tab gets a genuinely empty
 * session rather than a "cleared" one. Nothing survives the switch.
 */

const NORMAL_PARTITION = 'persist:browseme';

// Present as plain Chrome. Sites gate features on UA strings, and advertising
// "Electron/BrowseMe" both breaks pages and makes the browser trivially
// fingerprintable.
function chromeUserAgent() {
  const chrome = process.versions.chrome || '124.0.0.0';
  const platform = process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

// Permissions we never grant without the user saying so.
const SENSITIVE_PERMISSIONS = new Set([
  'media', 'geolocation', 'notifications', 'midi', 'midiSysex',
  'pointerLock', 'display-capture', 'clipboard-read', 'hid', 'serial', 'usb',
]);

class SessionManager {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {import('./shields').Shields} opts.shields
   * @param {(req: object) => Promise<boolean>} [opts.onPermissionRequest]
   * @param {(session: Electron.Session, mode: string) => void} [opts.onSessionCreated]
   *   called once per session, the first time a mode is used — this is where
   *   downloads and extensions attach themselves
   */
  constructor({ store, shields, onPermissionRequest, onSessionCreated }) {
    this.store = store;
    this.shields = shields;
    this.onPermissionRequest = onPermissionRequest;
    this.onSessionCreated = onSessionCreated;
    this.privateGeneration = 0;
    this.userAgent = chromeUserAgent();
    this._configured = new WeakSet();
  }

  get normalPartition() {
    return NORMAL_PARTITION;
  }

  get privatePartition() {
    // No `persist:` prefix -> Chromium keeps it entirely in memory.
    return `browseme-private-${this.privateGeneration}`;
  }

  partitionFor(mode) {
    return mode === 'private' ? this.privatePartition : this.normalPartition;
  }

  /** Get (and configure on first use) the session for a browsing mode. */
  for(mode) {
    const partition = this.partitionFor(mode);
    const sess = electronSession.fromPartition(partition);
    this._configure(sess, mode);
    return sess;
  }

  /**
   * Discard the current private session and start a fresh generation.
   * Called when the incognito switch is turned off.
   */
  async resetPrivate() {
    const partition = this.privatePartition;
    const sess = electronSession.fromPartition(partition);
    try {
      await sess.clearStorageData();
      await sess.clearCache();
      await sess.clearAuthCache();
    } catch (err) {
      console.error('[sessions] private cleanup failed:', err.message);
    }
    this.privateGeneration++;
  }

  _configure(sess, mode) {
    if (this._configured.has(sess)) return;
    this._configured.add(sess);

    sess.setUserAgent(this.userAgent);
    this.shields.attach(sess);

    // Internal pages must resolve inside this partition too, not just in the
    // default session.
    registerHandler(sess.protocol);

    // Chromium's own "do not track"-adjacent hints, plus a stable
    // Accept-Language so the header is not an extra fingerprinting bit.
    sess.setSpellCheckerEnabled(this.store.get('settings.spellcheck', true));

    sess.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
      if (!SENSITIVE_PERMISSIONS.has(permission)) return callback(true);

      // Private mode never persists a grant and never auto-grants.
      if (mode === 'private') {
        const allow = this.onPermissionRequest
          ? await this.onPermissionRequest({ permission, url: details?.requestingUrl || webContents?.getURL(), mode, persist: false })
          : false;
        return callback(Boolean(allow));
      }

      let origin = '';
      try { origin = new URL(details?.requestingUrl || webContents.getURL()).origin; } catch { /* opaque */ }

      const remembered = this.store.get(`permissions.${origin}.${permission}`);
      if (remembered === true || remembered === false) return callback(remembered);

      if (!this.onPermissionRequest) return callback(false);
      const allow = await this.onPermissionRequest({ permission, url: origin, mode, persist: true });
      if (allow !== null && origin) {
        this.store.set(`permissions.${origin}.${permission}`, Boolean(allow));
      }
      callback(Boolean(allow));
    });

    // Synchronous checks (e.g. a page querying permission state) must not
    // surprise-grant anything the async handler would have prompted for.
    sess.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (!SENSITIVE_PERMISSIONS.has(permission)) return true;
      if (mode === 'private') return false;
      return this.store.get(`permissions.${requestingOrigin}.${permission}`, false) === true;
    });

    sess.setDisplayMediaRequestHandler(() => {
      // Screen capture needs a picker UI; refuse rather than silently share.
    }, { useSystemPicker: true });

    this.onSessionCreated?.(sess, mode);
  }
}

module.exports = { SessionManager, chromeUserAgent, NORMAL_PARTITION };
