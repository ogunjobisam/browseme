'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { protocol } = require('electron');

/**
 * The `browseme://` internal scheme.
 *
 * Internal pages are served from disk rather than loaded as `file://` URLs so
 * they get a real origin: that means a normal same-origin security model, a
 * stable identity for the preload to check before exposing privileged IPC,
 * and URLs the omnibox can display as `browseme://settings` instead of a
 * twelve-segment filesystem path.
 */

const INTERNAL_ROOT = path.join(__dirname, '..', 'renderer', 'internal');

const PAGES = new Set([
  'newtab', 'settings', 'video', 'flows', 'extensions',
  'history', 'bookmarks', 'downloads', 'error', 'shields',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Must run before `app.whenReady()`. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'browseme',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function notFound(message) {
  return new Response(`<h1>404</h1><p>${escapeHtml(message)}</p>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Resolve a request path inside the internal root, refusing traversal. */
function safeResolve(relative) {
  const target = path.join(INTERNAL_ROOT, relative);
  const normalized = path.normalize(target);
  if (!normalized.startsWith(INTERNAL_ROOT)) return null;
  return normalized;
}

async function serve(file) {
  try {
    const body = await fsp.readFile(file);
    const type = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': type,
        // Internal pages never need to reach the network for code.
        'Content-Security-Policy':
          "default-src 'self' browseme:; img-src 'self' browseme: data: https:; " +
          "style-src 'self' 'unsafe-inline' browseme:; script-src 'self' browseme:; " +
          "frame-src https:; media-src https: blob:; connect-src 'self' browseme:",
      },
    });
  } catch {
    return notFound(path.basename(file));
  }
}

/**
 * Register the handler on a protocol registry.
 *
 * `protocol.handle` only binds the default session, and every tab runs in a
 * named partition, so this has to be called once per session as well —
 * otherwise `browseme://newtab` fails to load in tabs while working fine in
 * the browser's own windows.
 *
 * @param {Electron.Protocol} [target] defaults to the global (default session)
 */
function registerHandler(target = protocol) {
  if (target.__browsemeRegistered) return;
  target.__browsemeRegistered = true;

  target.handle('browseme', async (request) => {
    const url = new URL(request.url);
    const host = url.hostname;
    const pathname = decodeURIComponent(url.pathname);

    if (host === 'assets') {
      const file = safeResolve(path.join('assets', pathname));
      return file ? serve(file) : notFound(pathname);
    }

    if (!PAGES.has(host)) return notFound(`browseme://${host}`);

    if (pathname === '/' || pathname === '') {
      return serve(path.join(INTERNAL_ROOT, `${host}.html`));
    }

    const file = safeResolve(pathname);
    return file && fs.existsSync(file) ? serve(file) : notFound(pathname);
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

module.exports = { registerScheme, registerHandler, PAGES, INTERNAL_ROOT };
