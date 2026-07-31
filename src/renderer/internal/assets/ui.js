/**
 * Tiny helpers shared by the browseme:// pages.
 *
 * These pages are plain DOM — no framework — so this is just the small set of
 * utilities that would otherwise be copy-pasted into each one.
 */

export const api = window.browseme;

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [props] `class`, `text`, `html`, `on<Event>` handlers, or attributes
 * @param {...(Node|string|null)} children
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** A labelled on/off switch row. */
export function toggleRow(label, hint, checked, onChange) {
  const control = h('button', {
    class: 'toggle',
    role: 'switch',
    'aria-checked': String(Boolean(checked)),
    'aria-label': label,
  });
  const row = h('div', { class: 'row' },
    h('div', { class: 'grow' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null),
    control,
  );
  control.addEventListener('click', () => {
    const next = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return row;
}

/** Relative time for history and download lists. */
export function timeAgo(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Favicon service that works offline for already-visited sites. */
export function faviconUrl(url) {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Open a URL in a new tab. */
export function openTab(url, background = false) {
  return api.invoke('tabs:create', { url, background });
}

/** Debounce a function by `wait` ms. */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Replace a container's children with a rendered list, or an empty state. */
export function renderList(container, items, renderItem, emptyMessage) {
  container.replaceChildren();
  if (!items.length) {
    container.append(h('div', { class: 'empty', text: emptyMessage }));
    return;
  }
  for (const item of items) container.append(renderItem(item));
}
