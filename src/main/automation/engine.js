'use strict';

const { NODES, getPath } = require('./nodes');

/**
 * Workflow execution engine.
 *
 * Runs a node graph in topological order over the subgraph reachable from the
 * trigger. Each node executes at most once per run and receives the
 * concatenation of everything delivered on its incoming edges; a node whose
 * inputs all arrived empty is skipped, which is what makes `If` branches
 * behave — the untaken branch simply never runs.
 *
 * The engine has no Electron dependency. Everything it can touch arrives
 * through the injected `browser` and `fetch`, so a workflow can be executed
 * and asserted on in a unit test.
 */

const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class WorkflowError extends Error {
  constructor(message, nodeId) {
    super(message);
    this.name = 'WorkflowError';
    this.nodeId = nodeId;
  }
}

/**
 * Substitute `{{ ... }}` expressions in a string.
 *
 * Supported references — deliberately not an eval:
 *   {{ item }}            the whole item, JSON encoded
 *   {{ item.a.b }}        a path into the current item
 *   {{ $vars.name }}      a workflow variable
 *   {{ $now }}            ISO timestamp
 *   {{ $runId }}          this run's id
 */
function resolveTemplate(template, item, context) {
  if (typeof template !== 'string') return template;
  if (!template.includes('{{')) return template;

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr) => {
    const value = resolveExpression(expr.trim(), item, context);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

function resolveExpression(expr, item, context) {
  if (expr === '$now') return new Date().toISOString();
  if (expr === '$today') return new Date().toISOString().slice(0, 10);
  if (expr === '$runId') return context.runId;
  if (expr === 'item') return item;

  if (expr.startsWith('$vars.')) return getPath(context.vars, expr.slice('$vars.'.length));
  if (expr.startsWith('item.')) return getPath(item, expr.slice('item.'.length));
  if (expr.startsWith('$.')) return getPath(context.vars, expr.slice(2));

  // Bare word: try the item, then variables.
  const fromItem = getPath(item, expr);
  return fromItem !== undefined ? fromItem : getPath(context.vars, expr);
}

/** Nodes reachable from `startId`, following edges forward. */
function reachableFrom(startId, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }

  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    for (const next of adjacency.get(stack.pop()) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/**
 * Kahn's algorithm over a node subset.
 * @throws {WorkflowError} when the subgraph contains a cycle
 */
function topologicalOrder(nodeIds, edges) {
  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map();

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const queue = [...indegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of outgoing.get(id) || []) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== nodeIds.size) {
    const cyclic = [...nodeIds].filter((id) => !order.includes(id));
    throw new WorkflowError(`Workflow contains a loop through: ${cyclic.join(', ')}`);
  }
  return order;
}

let runCounter = 0;

class WorkflowEngine {
  /**
   * @param {object} [opts]
   * @param {object} [opts.nodes] node catalog, defaults to the built-in one
   * @param {object} [opts.browser] browser-facing implementations
   * @param {Function} [opts.fetch]
   * @param {(ms: number) => Promise<void>} [opts.sleep]
   */
  constructor({ nodes = NODES, browser = {}, fetch: fetchImpl, sleep } = {}) {
    this.nodes = nodes;
    this.browser = browser;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Execute a workflow.
   *
   * @param {object} workflow `{ id, name, nodes: [], edges: [], vars: {} }`
   * @param {object} [opts]
   * @param {string} [opts.startNodeId] which trigger fired
   * @param {object[]} [opts.input] seed items
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{runId, status, logs, output, error, nodeResults}>}
   */
  async run(workflow, { startNodeId, input = [{}], signal, maxItems = DEFAULT_MAX_ITEMS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const runId = `run-${++runCounter}-${Date.now().toString(36)}`;
    const logs = [];
    const nodeResults = {};
    const startedAt = Date.now();

    const log = (message, level = 'info', nodeId = null) => {
      logs.push({ at: Date.now(), level, nodeId, message: String(message) });
    };

    const nodesById = new Map((workflow.nodes || []).map((n) => [n.id, n]));
    const edges = workflow.edges || [];

    const start = startNodeId
      ? nodesById.get(startNodeId)
      : (workflow.nodes || []).find((n) => this.nodes[n.type]?.category === 'trigger');

    if (!start) {
      return { runId, status: 'error', logs, output: [], error: 'Workflow has no trigger node.', nodeResults, durationMs: 0 };
    }

    const context = {
      runId,
      vars: { ...(workflow.vars || {}) },
      workingTab: null,
      fetch: this.fetch,
      sleep: (ms) => this.sleep(ms),
      log: (message) => log(message, 'info', null),
      setWorkingTab: (tabId) => { context.workingTab = tabId; },
      resolve: (template, item) => resolveTemplate(template, item, context),
      browser: this.browser,
      signal,
    };

    let reachable;
    let order;
    try {
      reachable = reachableFrom(start.id, edges);
      order = topologicalOrder(reachable, edges);
    } catch (err) {
      return { runId, status: 'error', logs, output: [], error: err.message, nodeResults, durationMs: Date.now() - startedAt };
    }

    /** @type {Map<string, object[]>} nodeId -> items waiting at its input */
    const inbox = new Map([[start.id, input]]);
    let lastOutput = [];

    for (const nodeId of order) {
      if (signal?.aborted) {
        log('Run cancelled.', 'warn');
        return { runId, status: 'cancelled', logs, output: lastOutput, nodeResults, durationMs: Date.now() - startedAt };
      }
      if (Date.now() - startedAt > timeoutMs) {
        log(`Run exceeded ${Math.round(timeoutMs / 1000)}s and was stopped.`, 'error');
        return { runId, status: 'error', logs, output: lastOutput, error: 'timeout', nodeResults, durationMs: Date.now() - startedAt };
      }

      const node = nodesById.get(nodeId);
      if (!node) continue;

      const items = inbox.get(nodeId) || [];
      // No data arrived — the branch feeding this node was not taken.
      if (nodeId !== start.id && items.length === 0) {
        nodeResults[nodeId] = { skipped: true, count: 0 };
        continue;
      }

      const definition = this.nodes[node.type];
      if (!definition) {
        log(`Unknown node type "${node.type}", skipping.`, 'warn', nodeId);
        nodeResults[nodeId] = { skipped: true, count: 0, error: 'unknown type' };
        continue;
      }

      let produced;
      const nodeStarted = Date.now();
      try {
        produced = await definition.execute(context, node.params || {}, items);
      } catch (err) {
        log(`${definition.label} failed: ${err.message}`, 'error', nodeId);
        nodeResults[nodeId] = { error: err.message, count: 0, durationMs: Date.now() - nodeStarted };
        if (node.params?.continueOnFail) {
          produced = [];
        } else {
          return {
            runId,
            status: 'error',
            logs,
            output: lastOutput,
            error: `${definition.label}: ${err.message}`,
            errorNodeId: nodeId,
            nodeResults,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      const byPort = normalizeOutput(produced, definition);
      for (const port of Object.keys(byPort)) {
        if (byPort[port].length > maxItems) {
          log(`${definition.label} produced ${byPort[port].length} items; truncated to ${maxItems}.`, 'warn', nodeId);
          byPort[port] = byPort[port].slice(0, maxItems);
        }
      }

      const total = Object.values(byPort).reduce((sum, list) => sum + list.length, 0);
      nodeResults[nodeId] = {
        count: total,
        ports: Object.fromEntries(Object.entries(byPort).map(([p, list]) => [p, list.length])),
        sample: (byPort.main || Object.values(byPort)[0] || []).slice(0, 3),
        durationMs: Date.now() - nodeStarted,
      };

      if (total > 0) lastOutput = byPort.main || Object.values(byPort).find((l) => l.length) || lastOutput;

      for (const edge of edges) {
        if (edge.from !== nodeId) continue;
        const port = edge.fromPort || 'main';
        const payload = byPort[port] || [];
        if (!payload.length) continue;
        const existing = inbox.get(edge.to);
        inbox.set(edge.to, existing ? existing.concat(payload) : payload.slice());
      }
    }

    return {
      runId,
      status: 'success',
      logs,
      output: lastOutput,
      nodeResults,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Coerce a node's return value into `{ port: items }`. */
function normalizeOutput(produced, definition) {
  if (produced && !Array.isArray(produced) && typeof produced === 'object' && produced.outputs) {
    const out = {};
    for (const port of definition.outputs || ['main']) {
      out[port] = toItems(produced.outputs[port]);
    }
    return out;
  }
  return { [definition.outputs?.[0] || 'main']: toItems(produced) };
}

function toItems(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);
  return [value];
}

/**
 * Does a URL match a page-load trigger's pattern?
 * `contains` by default, `/.../flags` for a regex, empty matches everything.
 */
function matchesPattern(url, pattern) {
  if (!pattern) return true;
  const text = String(pattern).trim();
  if (!text) return true;

  if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
    const end = text.lastIndexOf('/');
    try {
      return new RegExp(text.slice(1, end), text.slice(end + 1)).test(url);
    } catch {
      return false;
    }
  }
  return url.includes(text);
}

module.exports = {
  WorkflowEngine,
  WorkflowError,
  resolveTemplate,
  topologicalOrder,
  reachableFrom,
  matchesPattern,
};
