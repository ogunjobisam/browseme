'use strict';

/**
 * Node catalog for the Flows automation system.
 *
 * Each node declares its metadata (so the canvas can render and configure it
 * without hardcoding anything) and an `execute` function. Nodes that touch
 * the browser reach it through `ctx.browser`, which is injected — that keeps
 * the whole catalog testable without an Electron window.
 *
 * A node receives an array of items and returns either an array of items or
 * `{ outputs: { <port>: items } }` when it branches.
 */

const OPERATORS = {
  equals: (a, b) => String(a) === String(b),
  notEquals: (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a ?? '').includes(String(b)),
  notContains: (a, b) => !String(a ?? '').includes(String(b)),
  startsWith: (a, b) => String(a ?? '').startsWith(String(b)),
  endsWith: (a, b) => String(a ?? '').endsWith(String(b)),
  matches: (a, b) => {
    try { return new RegExp(b).test(String(a ?? '')); } catch { return false; }
  },
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  isEmpty: (a) => a === undefined || a === null || a === '',
  isNotEmpty: (a) => !(a === undefined || a === null || a === ''),
};

/** Read `a.b.c` out of an object without throwing on missing links. */
function getPath(obj, path) {
  if (!path) return obj;
  let node = obj;
  for (const part of String(path).split('.')) {
    if (node === null || node === undefined) return undefined;
    node = node[part];
  }
  return node;
}

const NODES = {
  // ------------------------------------------------------------- triggers
  'trigger.manual': {
    label: 'Manual',
    category: 'trigger',
    description: 'Runs when you press Run.',
    icon: '▶',
    outputs: ['main'],
    inputs: [],
    params: [],
    execute: (ctx, params, items) => items,
  },

  'trigger.pageLoad': {
    label: 'On page load',
    category: 'trigger',
    description: 'Fires whenever a tab finishes loading a matching URL.',
    icon: '🌐',
    outputs: ['main'],
    inputs: [],
    params: [
      { key: 'urlPattern', label: 'URL contains or /regex/', type: 'text', placeholder: 'example.com' },
      { key: 'mode', label: 'Browsing mode', type: 'select', options: ['any', 'normal', 'private'], default: 'normal' },
    ],
    execute: (ctx, params, items) => items,
  },

  'trigger.interval': {
    label: 'Every N minutes',
    category: 'trigger',
    description: 'Runs on a timer while the browser is open.',
    icon: '⏱',
    outputs: ['main'],
    inputs: [],
    params: [{ key: 'minutes', label: 'Minutes', type: 'number', default: 30, min: 1 }],
    execute: (ctx, params, items) => items,
  },

  'trigger.startup': {
    label: 'On browser start',
    category: 'trigger',
    description: 'Runs once when the browser launches.',
    icon: '🚀',
    outputs: ['main'],
    inputs: [],
    params: [],
    execute: (ctx, params, items) => items,
  },

  'trigger.blocked': {
    label: 'On request blocked',
    category: 'trigger',
    description: 'Fires when Shields blocks a request. Useful for reporting.',
    icon: '🛡',
    outputs: ['main'],
    inputs: [],
    params: [{ key: 'minPerPage', label: 'Only after N blocks on a page', type: 'number', default: 10, min: 1 }],
    execute: (ctx, params, items) => items,
  },

  // -------------------------------------------------------------- browser
  'browser.openTab': {
    label: 'Open tab',
    category: 'browser',
    description: 'Opens a URL in a new tab and makes it the working tab.',
    icon: '🗂',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://example.com' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['current', 'normal', 'private'], default: 'current' },
      { key: 'background', label: 'Open in background', type: 'boolean', default: true },
    ],
    execute: async (ctx, params, items) => {
      const out = [];
      for (const item of items) {
        const url = ctx.resolve(params.url, item);
        const tabId = await ctx.browser.openTab({
          url,
          mode: params.mode === 'current' ? undefined : params.mode,
          background: params.background !== false,
        });
        ctx.setWorkingTab(tabId);
        out.push({ ...item, tabId, url });
      }
      return out;
    },
  },

  'browser.waitForSelector': {
    label: 'Wait for element',
    category: 'browser',
    description: 'Pauses until an element appears on the working tab.',
    icon: '⏳',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'selector', label: 'CSS selector', type: 'text', placeholder: '.results' },
      { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', default: 15000, min: 100 },
    ],
    execute: async (ctx, params, items) => {
      await ctx.browser.waitForSelector(ctx.workingTab, ctx.resolve(params.selector), Number(params.timeoutMs) || 15000);
      return items;
    },
  },

  'browser.extract': {
    label: 'Extract from page',
    category: 'browser',
    description: 'Pulls text, attributes or HTML out of the working tab.',
    icon: '🔍',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'selector', label: 'CSS selector', type: 'text', placeholder: 'h2 a' },
      { key: 'attribute', label: 'Attribute', type: 'text', placeholder: 'text | html | href | src', default: 'text' },
      { key: 'multiple', label: 'All matches (one item each)', type: 'boolean', default: true },
      { key: 'field', label: 'Store as field', type: 'text', default: 'value' },
    ],
    execute: async (ctx, params, items) => {
      const field = params.field || 'value';
      const out = [];
      for (const item of items) {
        const values = await ctx.browser.extract(ctx.workingTab, {
          selector: ctx.resolve(params.selector, item),
          attribute: params.attribute || 'text',
          multiple: params.multiple !== false,
        });
        if (params.multiple !== false) {
          for (const value of values) out.push({ ...item, [field]: value });
        } else {
          out.push({ ...item, [field]: values[0] ?? null });
        }
      }
      return out;
    },
  },

  'browser.click': {
    label: 'Click element',
    category: 'browser',
    description: 'Clicks the first matching element on the working tab.',
    icon: '👆',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'selector', label: 'CSS selector', type: 'text' }],
    execute: async (ctx, params, items) => {
      for (const item of items) {
        await ctx.browser.click(ctx.workingTab, ctx.resolve(params.selector, item));
      }
      return items;
    },
  },

  'browser.type': {
    label: 'Type into field',
    category: 'browser',
    description: 'Fills an input and dispatches the events a page expects.',
    icon: '⌨',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'selector', label: 'CSS selector', type: 'text' },
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'submit', label: 'Press Enter afterwards', type: 'boolean', default: false },
    ],
    execute: async (ctx, params, items) => {
      for (const item of items) {
        await ctx.browser.type(
          ctx.workingTab,
          ctx.resolve(params.selector, item),
          ctx.resolve(params.text, item),
          { submit: Boolean(params.submit) },
        );
      }
      return items;
    },
  },

  'browser.screenshot': {
    label: 'Screenshot',
    category: 'browser',
    description: 'Captures the working tab to a PNG file.',
    icon: '📷',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'directory', label: 'Save to folder', type: 'text', placeholder: 'leave blank for Downloads' }],
    execute: async (ctx, params, items) => {
      const out = [];
      for (const item of items) {
        const file = await ctx.browser.screenshot(ctx.workingTab, ctx.resolve(params.directory, item));
        out.push({ ...item, screenshot: file });
      }
      return out;
    },
  },

  'browser.closeTab': {
    label: 'Close tab',
    category: 'browser',
    description: 'Closes the working tab.',
    icon: '✕',
    outputs: ['main'],
    inputs: ['main'],
    params: [],
    execute: async (ctx, params, items) => {
      await ctx.browser.closeTab(ctx.workingTab);
      ctx.setWorkingTab(null);
      return items;
    },
  },

  // ----------------------------------------------------------------- data
  'http.request': {
    label: 'HTTP request',
    category: 'data',
    description: 'Calls an API and parses JSON when it can.',
    icon: '☁',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { key: 'url', label: 'URL', type: 'text' },
      { key: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"Content-Type": "application/json"}' },
      { key: 'body', label: 'Body', type: 'textarea' },
      { key: 'field', label: 'Store response as', type: 'text', default: 'response' },
    ],
    execute: async (ctx, params, items) => {
      const out = [];
      for (const item of items) {
        let headers = {};
        if (params.headers) {
          try { headers = JSON.parse(ctx.resolve(params.headers, item)); } catch { /* send none */ }
        }
        const init = { method: params.method || 'GET', headers };
        if (params.body && init.method !== 'GET') init.body = ctx.resolve(params.body, item);

        const res = await ctx.fetch(ctx.resolve(params.url, item), init);
        const text = await res.text();
        let value = text;
        try { value = JSON.parse(text); } catch { /* keep as text */ }
        out.push({ ...item, [params.field || 'response']: value, statusCode: res.status });
      }
      return out;
    },
  },

  'data.set': {
    label: 'Set fields',
    category: 'data',
    description: 'Adds or overwrites fields on every item.',
    icon: '✎',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'assignments', label: 'Fields (JSON)', type: 'textarea', placeholder: '{"name": "{{ item.title }}"}' }],
    execute: (ctx, params, items) => {
      let template = {};
      try { template = JSON.parse(params.assignments || '{}'); } catch { throw new Error('Set fields: assignments must be valid JSON'); }
      return items.map((item) => {
        const patch = {};
        for (const [key, value] of Object.entries(template)) {
          patch[key] = typeof value === 'string' ? ctx.resolve(value, item) : value;
        }
        return { ...item, ...patch };
      });
    },
  },

  'data.filter': {
    label: 'Filter',
    category: 'data',
    description: 'Drops items that fail the condition.',
    icon: '⚗',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'field', label: 'Field', type: 'text', placeholder: 'title' },
      { key: 'operator', label: 'Operator', type: 'select', options: Object.keys(OPERATORS), default: 'contains' },
      { key: 'value', label: 'Value', type: 'text' },
    ],
    execute: (ctx, params, items) => {
      const op = OPERATORS[params.operator] || OPERATORS.contains;
      return items.filter((item) => op(getPath(item, params.field), ctx.resolve(params.value, item)));
    },
  },

  'data.if': {
    label: 'If',
    category: 'data',
    description: 'Splits the flow into true and false branches.',
    icon: '⑂',
    outputs: ['true', 'false'],
    inputs: ['main'],
    params: [
      { key: 'field', label: 'Field', type: 'text' },
      { key: 'operator', label: 'Operator', type: 'select', options: Object.keys(OPERATORS), default: 'equals' },
      { key: 'value', label: 'Value', type: 'text' },
    ],
    execute: (ctx, params, items) => {
      const op = OPERATORS[params.operator] || OPERATORS.equals;
      const truthy = [];
      const falsy = [];
      for (const item of items) {
        (op(getPath(item, params.field), ctx.resolve(params.value, item)) ? truthy : falsy).push(item);
      }
      return { outputs: { true: truthy, false: falsy } };
    },
  },

  'data.limit': {
    label: 'Limit',
    category: 'data',
    description: 'Keeps only the first N items.',
    icon: '⋯',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'count', label: 'Keep', type: 'number', default: 10, min: 1 }],
    execute: (ctx, params, items) => items.slice(0, Math.max(1, Number(params.count) || 10)),
  },

  'data.dedupe': {
    label: 'Remove duplicates',
    category: 'data',
    description: 'Drops items sharing a field value.',
    icon: '≠',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'field', label: 'Field', type: 'text', default: 'value' }],
    execute: (ctx, params, items) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = JSON.stringify(getPath(item, params.field));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },
  },

  // ----------------------------------------------------------------- flow
  'flow.wait': {
    label: 'Wait',
    category: 'flow',
    description: 'Pauses before continuing.',
    icon: '⏸',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'seconds', label: 'Seconds', type: 'number', default: 2, min: 0 }],
    execute: async (ctx, params, items) => {
      await ctx.sleep(Math.max(0, Number(params.seconds) || 0) * 1000);
      return items;
    },
  },

  'flow.log': {
    label: 'Log',
    category: 'flow',
    description: 'Writes a line to the run log.',
    icon: '📝',
    outputs: ['main'],
    inputs: ['main'],
    params: [{ key: 'message', label: 'Message', type: 'text', default: '{{ item }}' }],
    execute: (ctx, params, items) => {
      for (const item of items) ctx.log(ctx.resolve(params.message || '{{ item }}', item));
      return items;
    },
  },

  'flow.notify': {
    label: 'Notify',
    category: 'flow',
    description: 'Shows a desktop notification.',
    icon: '🔔',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'title', label: 'Title', type: 'text', default: 'BrowseMe' },
      { key: 'body', label: 'Body', type: 'text' },
      { key: 'once', label: 'Only once per run', type: 'boolean', default: true },
    ],
    execute: async (ctx, params, items) => {
      const targets = params.once === false ? items : items.slice(0, 1);
      for (const item of targets) {
        await ctx.browser.notify(ctx.resolve(params.title, item), ctx.resolve(params.body, item));
      }
      return items;
    },
  },

  'flow.saveFile': {
    label: 'Save to file',
    category: 'flow',
    description: 'Appends items to a JSON or CSV file.',
    icon: '💾',
    outputs: ['main'],
    inputs: ['main'],
    params: [
      { key: 'path', label: 'File path', type: 'text', placeholder: '~/browseme-flow.json' },
      { key: 'format', label: 'Format', type: 'select', options: ['json', 'csv', 'text'], default: 'json' },
      { key: 'template', label: 'Text template', type: 'text', placeholder: '{{ item.value }}' },
    ],
    execute: async (ctx, params, items) => {
      await ctx.browser.saveFile({
        path: ctx.resolve(params.path),
        format: params.format || 'json',
        items,
        lines: items.map((item) => ctx.resolve(params.template || '{{ item }}', item)),
      });
      return items;
    },
  },
};

module.exports = { NODES, OPERATORS, getPath };
