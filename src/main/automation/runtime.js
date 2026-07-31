'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Notification, app } = require('electron');

const { WorkflowEngine, matchesPattern } = require('./engine');
const { NODES } = require('./nodes');

/**
 * Flows: workflow storage, trigger wiring, and the browser-facing node
 * implementations the engine calls into.
 *
 * The engine itself knows nothing about Electron. This module is the seam:
 * it turns "click this selector" into an `executeJavaScript` call against a
 * real tab, and it decides when a workflow should run at all.
 */

const MAX_RUN_HISTORY = 25;

class FlowManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../store').Store} opts.store
   * @param {import('../tabs').TabManager} opts.tabs
   * @param {import('../shields').Shields} opts.shields
   */
  constructor({ store, tabs, shields }) {
    super();
    this.store = store;
    this.tabs = tabs;
    this.shields = shields;

    this.engine = new WorkflowEngine({ browser: this._browserApi() });
    /** @type {Map<string, {result: object, workflowId: string}>} */
    this.runs = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    /** @type {Map<string, AbortController>} */
    this.active = new Map();

    this._wireTriggers();
  }

  // ------------------------------------------------------------------- CRUD

  list() {
    return this.store.get('flows', []);
  }

  get(id) {
    return this.list().find((f) => f.id === id) || null;
  }

  save(workflow) {
    const list = this.list();
    const entry = {
      id: workflow.id || `flow-${crypto.randomUUID().slice(0, 8)}`,
      name: workflow.name || 'Untitled flow',
      enabled: workflow.enabled !== false,
      nodes: workflow.nodes || [],
      edges: workflow.edges || [],
      vars: workflow.vars || {},
      updatedAt: Date.now(),
      createdAt: workflow.createdAt || Date.now(),
    };

    const index = list.findIndex((f) => f.id === entry.id);
    if (index === -1) list.push(entry);
    else list[index] = entry;

    this.store.set('flows', list);
    this._scheduleTimers();
    this.emit('changed');
    return entry;
  }

  remove(id) {
    this.store.set('flows', this.list().filter((f) => f.id !== id));
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    this.emit('changed');
  }

  duplicate(id) {
    const source = this.get(id);
    if (!source) return null;
    return this.save({ ...source, id: undefined, name: `${source.name} copy`, createdAt: undefined });
  }

  // -------------------------------------------------------------- execution

  /**
   * Run a workflow now.
   * @param {string} id
   * @param {{startNodeId?: string, input?: object[]}} [opts]
   */
  async run(id, { startNodeId, input } = {}) {
    const workflow = this.get(id);
    if (!workflow) throw new Error(`No such flow: ${id}`);

    const controller = new AbortController();
    this.active.set(id, controller);
    this.emit('run-started', { workflowId: id });

    let result;
    try {
      result = await this.engine.run(workflow, {
        startNodeId,
        input: input || [{}],
        signal: controller.signal,
      });
    } catch (err) {
      result = { runId: `run-error-${Date.now()}`, status: 'error', error: err.message, logs: [], output: [], nodeResults: {} };
    } finally {
      this.active.delete(id);
    }

    this.runs.set(result.runId, { workflowId: id, result, at: Date.now() });
    if (this.runs.size > MAX_RUN_HISTORY) {
      this.runs.delete(this.runs.keys().next().value);
    }

    this.store.push(`flowRuns.${id}`, {
      runId: result.runId,
      status: result.status,
      at: Date.now(),
      durationMs: result.durationMs,
      error: result.error || null,
      items: result.output?.length || 0,
    }, 20);

    this.emit('run-finished', { workflowId: id, result });
    return result;
  }

  cancel(id) {
    const controller = this.active.get(id);
    if (controller) controller.abort();
  }

  history(id) {
    return this.store.get(`flowRuns.${id}`, []);
  }

  lastRun(id) {
    for (const [runId, entry] of [...this.runs.entries()].reverse()) {
      if (entry.workflowId === id) return { runId, ...entry };
    }
    return null;
  }

  // --------------------------------------------------------------- triggers

  _wireTriggers() {
    this.tabs.on('page-loaded', ({ tabId, url, mode }) => {
      for (const workflow of this.list()) {
        if (!workflow.enabled) continue;
        for (const node of workflow.nodes || []) {
          if (node.type !== 'trigger.pageLoad') continue;
          const wanted = node.params?.mode || 'normal';
          if (wanted !== 'any' && wanted !== mode) continue;
          if (!matchesPattern(url, node.params?.urlPattern)) continue;

          void this.run(workflow.id, {
            startNodeId: node.id,
            input: [{ url, tabId, trigger: 'pageLoad' }],
          }).catch((err) => console.error('[flows] pageLoad run failed:', err.message));
        }
      }
    });

    this.shields.on('counts-changed', () => {
      for (const workflow of this.list()) {
        if (!workflow.enabled) continue;
        for (const node of workflow.nodes || []) {
          if (node.type !== 'trigger.blocked') continue;
          const active = this.tabs.active;
          if (!active || active.view.webContents.isDestroyed()) continue;
          const stats = this.shields.statsFor(active.view.webContents.id);
          const threshold = Number(node.params?.minPerPage) || 10;
          if (stats.count < threshold) continue;

          // Fire once per page, not once per blocked request.
          const key = `${workflow.id}:${node.id}:${active.id}:${active.url}`;
          if (this._blockedFired === key) continue;
          this._blockedFired = key;

          void this.run(workflow.id, {
            startNodeId: node.id,
            input: [{ url: active.url, tabId: active.id, blocked: stats.count, trigger: 'blocked' }],
          }).catch(() => {});
        }
      }
    });

    this._scheduleTimers();
  }

  _scheduleTimers() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();

    for (const workflow of this.list()) {
      if (!workflow.enabled) continue;
      for (const node of workflow.nodes || []) {
        if (node.type !== 'trigger.interval') continue;
        const minutes = Math.max(1, Number(node.params?.minutes) || 30);
        const timer = setInterval(() => {
          void this.run(workflow.id, {
            startNodeId: node.id,
            input: [{ trigger: 'interval', at: new Date().toISOString() }],
          }).catch(() => {});
        }, minutes * 60 * 1000);
        if (timer.unref) timer.unref();
        this.timers.set(`${workflow.id}:${node.id}`, timer);
      }
    }
  }

  /** Fire every `trigger.startup` node. Called once the window is up. */
  runStartupFlows() {
    for (const workflow of this.list()) {
      if (!workflow.enabled) continue;
      for (const node of workflow.nodes || []) {
        if (node.type !== 'trigger.startup') continue;
        void this.run(workflow.id, {
          startNodeId: node.id,
          input: [{ trigger: 'startup' }],
        }).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------- browser bindings

  _webContentsFor(tabId) {
    const tab = tabId ? this.tabs.tabs.get(tabId) : this.tabs.active;
    if (!tab) throw new Error('No tab to work with. Add an "Open tab" node first.');
    if (tab.view.webContents.isDestroyed()) throw new Error('That tab has been closed.');
    return tab.view.webContents;
  }

  _browserApi() {
    return {
      openTab: async ({ url, mode, background }) => {
        const tab = this.tabs.create({ url, mode, background });
        // Give the navigation a moment to commit so a following extract or
        // wait node is not racing an about:blank document.
        await once(tab.view.webContents, 'did-finish-load', 20000).catch(() => {});
        return tab.id;
      },

      closeTab: async (tabId) => {
        if (tabId) this.tabs.close(tabId);
      },

      waitForSelector: async (tabId, selector, timeoutMs) => {
        const wc = this._webContentsFor(tabId);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const found = await wc.executeJavaScript(
            `!!document.querySelector(${JSON.stringify(selector)})`,
            true,
          ).catch(() => false);
          if (found) return true;
          await delay(200);
        }
        throw new Error(`Timed out waiting for "${selector}"`);
      },

      extract: async (tabId, { selector, attribute, multiple }) => {
        const wc = this._webContentsFor(tabId);
        const script = `(() => {
          const nodes = ${multiple ? 'Array.from(document.querySelectorAll(SEL))' : '[document.querySelector(SEL)]'};
          return nodes.filter(Boolean).map((el) => {
            const attr = ATTR;
            if (attr === 'text') return (el.innerText || el.textContent || '').trim();
            if (attr === 'html') return el.innerHTML;
            if (attr === 'outerHtml') return el.outerHTML;
            if (attr === 'value') return el.value ?? null;
            return el.getAttribute(attr);
          });
        })()`
          .replace(/SEL/g, JSON.stringify(selector))
          .replace(/ATTR/g, JSON.stringify(attribute || 'text'));
        return wc.executeJavaScript(script, true);
      },

      click: async (tabId, selector) => {
        const wc = this._webContentsFor(tabId);
        const ok = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`, true);
        if (!ok) throw new Error(`Nothing matched "${selector}"`);
      },

      type: async (tabId, selector, text, { submit } = {}) => {
        const wc = this._webContentsFor(tabId);
        const ok = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.focus();
          el.value = ${JSON.stringify(String(text ?? ''))};
          // Frameworks listen for these rather than reading .value directly.
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`, true);
        if (!ok) throw new Error(`Nothing matched "${selector}"`);
        if (submit) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        }
      },

      screenshot: async (tabId, directory) => {
        const wc = this._webContentsFor(tabId);
        const image = await wc.capturePage();
        const dir = expandHome(directory) || app.getPath('downloads');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `browseme-${Date.now()}.png`);
        await fs.writeFile(file, image.toPNG());
        return file;
      },

      notify: async (title, body) => {
        if (!Notification.isSupported()) return;
        new Notification({ title: title || 'BrowseMe', body: body || '' }).show();
      },

      saveFile: async ({ path: target, format, items, lines }) => {
        const file = expandHome(target) || path.join(app.getPath('downloads'), `browseme-flow.${format === 'csv' ? 'csv' : 'json'}`);
        await fs.mkdir(path.dirname(file), { recursive: true });

        if (format === 'csv') {
          const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
          let existing = '';
          try { existing = await fs.readFile(file, 'utf8'); } catch { /* new file */ }
          const header = existing ? '' : columns.join(',') + '\n';
          const body = items
            .map((item) => columns.map((c) => csvCell(item[c])).join(','))
            .join('\n');
          await fs.appendFile(file, header + body + '\n');
        } else if (format === 'text') {
          await fs.appendFile(file, lines.join('\n') + '\n');
        } else {
          let existing = [];
          try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new file */ }
          if (!Array.isArray(existing)) existing = [existing];
          await fs.writeFile(file, JSON.stringify(existing.concat(items), null, 2));
        }
        return file;
      },
    };
  }

  /** Node catalog shaped for the editor's palette. */
  static catalog() {
    return Object.entries(NODES).map(([type, def]) => ({
      type,
      label: def.label,
      category: def.category,
      description: def.description,
      icon: def.icon,
      inputs: def.inputs,
      outputs: def.outputs,
      params: def.params,
    }));
  }

  destroy() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    for (const controller of this.active.values()) controller.abort();
  }
}

// ------------------------------------------------------------------ helpers

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    emitter.once(event, handler);
  });
}

function expandHome(target) {
  if (!target) return null;
  const text = String(target).trim();
  if (!text) return null;
  return text.startsWith('~') ? path.join(os.homedir(), text.slice(1)) : text;
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = { FlowManager };
