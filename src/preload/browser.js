'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The one preload script, used by every renderer in the browser.
 *
 * It is a single file on purpose: sandboxed preloads cannot `require` local
 * modules (only a handful of built-ins), so splitting this into shared pieces
 * would mean either giving up the sandbox or adding a bundler. One file with
 * clearly gated sections is the better trade.
 *
 * What a renderer gets depends on what it is:
 *
 *   Trusted surfaces — the chrome window and the overlay, flagged by the main
 *     process, and `browseme://` pages, identified by scheme — get the
 *     `window.browseme` IPC bridge.
 *
 *   Web pages get no bridge at all. They get cosmetic ad filtering and
 *     theater mode, neither of which is visible to page scripts.
 *
 * The bridge grants no authority by itself: the main process authorises every
 * route by checking the sender's URL. This gating just keeps the object off
 * `window` for content that has no business seeing it. A preload runs per
 * document, so navigating away from an internal page re-evaluates all of it.
 */

const IS_TRUSTED_SURFACE = process.argv.some((arg) => arg === '--browseme-surface=chrome');
const IS_INTERNAL_PAGE = location.protocol === 'browseme:';
const IS_WEB_PAGE = location.protocol === 'http:' || location.protocol === 'https:';

// ===========================================================================
// The window.browseme bridge
// ===========================================================================

function exposeBridge() {
  const listeners = new Map();

  const emit = (type, payload) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const callback of set) {
      try {
        callback(payload);
      } catch (err) {
        console.error(`[browseme] listener for ${type} threw:`, err);
      }
    }
  };

  ipcRenderer.on('browseme:event', (_event, message) => {
    emit(message.type, message.payload);
    emit('*', message);
  });

  ipcRenderer.on('browseme:overlay', (_event, message) => {
    emit(`overlay:${message.type}`, message);
  });

  contextBridge.exposeInMainWorld('browseme', {
    /**
     * Call a browser route.
     * @param {string} route e.g. `tabs:create`
     * @param {object} [payload]
     */
    invoke(route, payload) {
      return ipcRenderer.invoke('browseme:invoke', route, payload);
    },

    /**
     * Subscribe to a browser event. Returns an unsubscribe function.
     * @param {string} type event name, or `*` for everything
     * @param {(payload: any) => void} callback
     */
    on(type, callback) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(callback);
      return () => set.delete(callback);
    },

    platform: process.platform,
  });
}

if (IS_TRUSTED_SURFACE || IS_INTERNAL_PAGE) exposeBridge();

// ===========================================================================
// Cosmetic ad filtering
//
// Network blocking removes the ad; this removes the hole it leaves behind.
// Rather than injecting every generic hide rule (tens of thousands of
// selectors), the page is surveyed for the class names and ids it actually
// uses and only the matching rules are requested.
// ===========================================================================

const STYLE_ID = '__browseme_shield_styles__';
const THEATER_ID = '__browseme_theater__';

let injectedStyle = null;
const appliedSelectors = new Set();
const requestedTokens = new Set();

function styleElement() {
  if (injectedStyle && injectedStyle.isConnected) return injectedStyle;
  const root = document.head || document.documentElement;
  if (!root) return null;

  injectedStyle = document.getElementById(STYLE_ID) || document.createElement('style');
  injectedStyle.id = STYLE_ID;
  root.appendChild(injectedStyle);
  return injectedStyle;
}

function applySelectors(selectors) {
  const fresh = selectors.filter((sel) => sel && !appliedSelectors.has(sel));
  if (!fresh.length) return;
  for (const sel of fresh) appliedSelectors.add(sel);

  const style = styleElement();
  if (!style) return;

  // Chunked so one malformed selector cannot invalidate the whole rule, and
  // so the CSS parser is not handed a single multi-megabyte selector list.
  const CHUNK = 250;
  let css = '';
  for (let i = 0; i < fresh.length; i += CHUNK) {
    css += `${fresh.slice(i, i + CHUNK).join(',')}{display:none!important}\n`;
  }
  style.appendChild(document.createTextNode(css));
}

/** Class names and ids present in the document that we have not asked about. */
function surveyTokens() {
  const tokens = [];
  let elements;
  try {
    elements = document.querySelectorAll('[class],[id]');
  } catch {
    return tokens;
  }

  for (const el of elements) {
    const id = el.id;
    if (id && !requestedTokens.has(id)) {
      requestedTokens.add(id);
      tokens.push(id);
    }
    const className = typeof el.className === 'string' ? el.className : el.getAttribute('class');
    if (!className) continue;
    for (const name of className.split(/\s+/)) {
      if (!name || requestedTokens.has(name)) continue;
      requestedTokens.add(name);
      tokens.push(name);
    }
  }
  return tokens;
}

async function requestSelectors(tokens) {
  try {
    const selectors = await ipcRenderer.invoke('browseme:cosmetic', {
      hostname: location.hostname,
      tokens,
    });
    if (Array.isArray(selectors) && selectors.length) applySelectors(selectors);
  } catch {
    // Shields may still be loading its lists; the observer will retry.
  }
}

let surveyPending = false;
function scheduleSurvey() {
  if (surveyPending) return;
  surveyPending = true;
  // Batch bursts of DOM churn into one round trip.
  setTimeout(() => {
    surveyPending = false;
    const tokens = surveyTokens();
    if (tokens.length) void requestSelectors(tokens);
  }, 100);
}

function startCosmeticFiltering() {
  // First pass with no tokens: domain-specific rules, plus the generic rules
  // that are not reducible to a single class or id.
  void requestSelectors([]);

  const observe = () => {
    scheduleSurvey();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.addedNodes.length || record.type === 'attributes') {
          scheduleSurvey();
          return;
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id'],
    });
    // Late-loading ad slots keep arriving; stop churning after a minute.
    setTimeout(() => observer.disconnect(), 60_000);
  };

  if (document.documentElement) observe();
  else document.addEventListener('readystatechange', observe, { once: true });

  // Survey again once the initial document has parsed: the first pass runs
  // before most of the DOM exists.
  document.addEventListener('DOMContentLoaded', scheduleSurvey, { once: true });
  window.addEventListener('load', scheduleSurvey, { once: true });
}

// ===========================================================================
// Theater mode — the "bigger video" control, on any site
// ===========================================================================

function largestVideo() {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) return null;
  return videos.sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
  )[0];
}

function theaterStyles() {
  let style = document.getElementById(THEATER_ID);
  if (style) return style;
  style = document.createElement('style');
  style.id = THEATER_ID;
  style.textContent = `
    html.browseme-theater { overflow: hidden !important; }
    html.browseme-theater::before {
      content: ''; position: fixed; inset: 0; background: #000; z-index: 2147483645;
    }
    .browseme-theater-video {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: 100vw !important;
      max-height: 100vh !important;
      z-index: 2147483646 !important;
      object-fit: contain !important;
      background: #000 !important;
    }
    .browseme-theater-hint {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; padding: 8px 16px; border-radius: 999px;
      background: rgba(0,0,0,.72); color: #fff;
      font: 500 13px/1.4 system-ui, sans-serif;
      pointer-events: none; transition: opacity .4s ease;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
  return style;
}

let theaterVideo = null;

function onTheaterKey(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    exitTheater();
  }
}

function exitTheater() {
  if (!theaterVideo) return;
  theaterVideo.classList.remove('browseme-theater-video');
  document.documentElement.classList.remove('browseme-theater');
  document.getElementById('__browseme_theater_hint__')?.remove();
  theaterVideo = null;
  document.removeEventListener('keydown', onTheaterKey, true);
}

function enterTheater() {
  const video = largestVideo();
  if (!video) return false;

  theaterStyles();
  theaterVideo = video;
  video.classList.add('browseme-theater-video');
  document.documentElement.classList.add('browseme-theater');

  const hint = document.createElement('div');
  hint.id = '__browseme_theater_hint__';
  hint.className = 'browseme-theater-hint';
  hint.textContent = 'Theater mode — press Esc to exit';
  document.body.appendChild(hint);
  setTimeout(() => { hint.style.opacity = '0'; }, 2200);

  document.addEventListener('keydown', onTheaterKey, true);
  video.play?.().catch(() => {});
  return true;
}

function toggleTheater() {
  if (theaterVideo) {
    exitTheater();
    return false;
  }
  return enterTheater();
}

async function togglePictureInPicture() {
  const video = largestVideo();
  if (!video) return false;
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
}

function startPageFeatures() {
  startCosmeticFiltering();

  ipcRenderer.on('browseme:content', (_event, message) => {
    switch (message?.type) {
      case 'theater': toggleTheater(); break;
      case 'pip': void togglePictureInPicture(); break;
      case 'exitTheater': exitTheater(); break;
      default: break;
    }
  });

  // Alt+T is the keyboard route to the same thing. The page never sees it:
  // the listener runs in the isolated world during capture.
  window.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      toggleTheater();
    }
  }, true);
}

if (IS_WEB_PAGE) startPageFeatures();
