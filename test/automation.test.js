'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WorkflowEngine,
  resolveTemplate,
  topologicalOrder,
  reachableFrom,
  matchesPattern,
} = require('../src/main/automation/engine');

/**
 * The engine takes its browser bindings by injection, so a workflow can be
 * executed against a fake browser and asserted on without Electron.
 */
function fakeBrowser(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return overrides[name] ? overrides[name](...args) : undefined;
  };
  return {
    calls,
    openTab: overrides.openTab || record('openTab'),
    closeTab: record('closeTab'),
    waitForSelector: record('waitForSelector'),
    extract: overrides.extract || record('extract'),
    click: record('click'),
    type: record('type'),
    screenshot: overrides.screenshot || record('screenshot'),
    notify: record('notify'),
    saveFile: overrides.saveFile || record('saveFile'),
  };
}

const engineWith = (browser, fetchImpl) => new WorkflowEngine({
  browser,
  fetch: fetchImpl,
  sleep: () => Promise.resolve(),   // never actually wait in tests
});

test('resolveTemplate substitutes item fields and variables', () => {
  const context = { runId: 'r1', vars: { site: 'example.com' } };
  assert.equal(resolveTemplate('Hello {{ item.name }}', { name: 'World' }, context), 'Hello World');
  assert.equal(resolveTemplate('{{ $vars.site }}/path', {}, context), 'example.com/path');
  assert.equal(resolveTemplate('{{ $runId }}', {}, context), 'r1');
  assert.equal(resolveTemplate('nothing to do', {}, context), 'nothing to do');
  // Missing values render empty rather than "undefined".
  assert.equal(resolveTemplate('[{{ item.missing }}]', {}, context), '[]');
});

test('resolveTemplate JSON-encodes whole objects', () => {
  const out = resolveTemplate('{{ item }}', { a: 1 }, { runId: 'r', vars: {} });
  assert.equal(out, '{"a":1}');
});

test('topologicalOrder sorts a chain and rejects cycles', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
  assert.deepEqual(topologicalOrder(new Set(['a', 'b', 'c']), edges), ['a', 'b', 'c']);

  assert.throws(
    () => topologicalOrder(new Set(['a', 'b']), [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]),
    /loop/i,
  );
});

test('reachableFrom ignores disconnected nodes', () => {
  const edges = [{ from: 'a', to: 'b' }];
  const reachable = reachableFrom('a', edges);
  assert.deepEqual([...reachable].sort(), ['a', 'b']);
  assert.ok(!reachable.has('orphan'));
});

test('runs a linear flow and threads items through it', async () => {
  const browser = fakeBrowser({
    openTab: async () => 7,
    extract: async () => ['First', 'Second'],
  });

  const workflow = {
    id: 'f1',
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'open', type: 'browser.openTab', params: { url: 'https://site.test', background: true } },
      { id: 'ex', type: 'browser.extract', params: { selector: 'h2', attribute: 'text', multiple: true, field: 'headline' } },
      { id: 'log', type: 'flow.log', params: { message: '{{ item.headline }}' } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'open' },
      { from: 'open', fromPort: 'main', to: 'ex' },
      { from: 'ex', fromPort: 'main', to: 'log' },
    ],
  };

  const result = await engineWith(browser).run(workflow);

  assert.equal(result.status, 'success');
  assert.equal(result.output.length, 2);
  assert.deepEqual(result.output.map((item) => item.headline), ['First', 'Second']);
  assert.deepEqual(result.logs.map((entry) => entry.message), ['First', 'Second']);
  assert.equal(result.nodeResults.ex.count, 2);
});

test('If sends items down exactly one branch and skips the other', async () => {
  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'set', type: 'data.set', params: { assignments: '{"score": "10"}' } },
      { id: 'if', type: 'data.if', params: { field: 'score', operator: 'equals', value: '10' } },
      { id: 'yes', type: 'flow.log', params: { message: 'matched' } },
      { id: 'no', type: 'flow.log', params: { message: 'did not match' } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'set' },
      { from: 'set', fromPort: 'main', to: 'if' },
      { from: 'if', fromPort: 'true', to: 'yes' },
      { from: 'if', fromPort: 'false', to: 'no' },
    ],
  };

  const result = await engineWith(fakeBrowser()).run(workflow);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.logs.map((l) => l.message), ['matched']);
  assert.equal(result.nodeResults.no.skipped, true);
  assert.equal(result.nodeResults.yes.count, 1);
});

test('filter drops non-matching items', async () => {
  const browser = fakeBrowser({ extract: async () => ['keep this', 'drop', 'keep that'] });
  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'ex', type: 'browser.extract', params: { selector: 'li', multiple: true, field: 'value' } },
      { id: 'filter', type: 'data.filter', params: { field: 'value', operator: 'contains', value: 'keep' } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'ex' },
      { from: 'ex', fromPort: 'main', to: 'filter' },
    ],
  };

  const result = await engineWith(browser).run(workflow);
  assert.equal(result.output.length, 2);
});

test('dedupe and limit shape the item list', async () => {
  const browser = fakeBrowser({ extract: async () => ['a', 'b', 'a', 'c', 'd'] });
  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'ex', type: 'browser.extract', params: { selector: 'li', multiple: true, field: 'value' } },
      { id: 'dedupe', type: 'data.dedupe', params: { field: 'value' } },
      { id: 'limit', type: 'data.limit', params: { count: 2 } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'ex' },
      { from: 'ex', fromPort: 'main', to: 'dedupe' },
      { from: 'dedupe', fromPort: 'main', to: 'limit' },
    ],
  };

  const result = await engineWith(browser).run(workflow);
  assert.deepEqual(result.output.map((i) => i.value), ['a', 'b']);
});

test('http.request parses JSON and records the status', async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () => JSON.stringify({ ok: true, count: 3 }),
  });

  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'req', type: 'http.request', params: { method: 'GET', url: 'https://api.test/x', field: 'response' } },
    ],
    edges: [{ from: 't', fromPort: 'main', to: 'req' }],
  };

  const result = await engineWith(fakeBrowser(), fetchImpl).run(workflow);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.output[0].response, { ok: true, count: 3 });
  assert.equal(result.output[0].statusCode, 200);
});

test('a failing node stops the run and reports which one', async () => {
  const browser = fakeBrowser({
    extract: async () => { throw new Error('selector not found'); },
  });

  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'ex', type: 'browser.extract', params: { selector: '.missing' } },
      { id: 'after', type: 'flow.log', params: { message: 'should not run' } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'ex' },
      { from: 'ex', fromPort: 'main', to: 'after' },
    ],
  };

  const result = await engineWith(browser).run(workflow);
  assert.equal(result.status, 'error');
  assert.equal(result.errorNodeId, 'ex');
  assert.match(result.error, /selector not found/);
  assert.equal(result.nodeResults.after, undefined);
});

test('continueOnFail lets the rest of the flow proceed', async () => {
  const browser = fakeBrowser({
    extract: async () => { throw new Error('boom'); },
  });

  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'ex', type: 'browser.extract', params: { selector: '.missing', continueOnFail: true } },
      { id: 'after', type: 'flow.log', params: { message: 'still here' } },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'ex' },
      { from: 'ex', fromPort: 'main', to: 'after' },
    ],
  };

  const result = await engineWith(browser).run(workflow);
  assert.equal(result.status, 'success');
  // The failing node produced nothing, so the downstream node is skipped
  // rather than run with stale data.
  assert.equal(result.nodeResults.after.skipped, true);
});

test('a workflow without a trigger is rejected, not silently ignored', async () => {
  const result = await engineWith(fakeBrowser()).run({ nodes: [{ id: 'x', type: 'flow.log', params: {} }], edges: [] });
  assert.equal(result.status, 'error');
  assert.match(result.error, /trigger/i);
});

test('a cyclic workflow reports the loop instead of hanging', async () => {
  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'a', type: 'flow.log', params: {} },
      { id: 'b', type: 'flow.log', params: {} },
    ],
    edges: [
      { from: 't', fromPort: 'main', to: 'a' },
      { from: 'a', fromPort: 'main', to: 'b' },
      { from: 'b', fromPort: 'main', to: 'a' },
    ],
  };

  const result = await engineWith(fakeBrowser()).run(workflow);
  assert.equal(result.status, 'error');
  assert.match(result.error, /loop/i);
});

test('an unknown node type warns but does not abort the run', async () => {
  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'x', type: 'does.not.exist', params: {} },
    ],
    edges: [{ from: 't', fromPort: 'main', to: 'x' }],
  };

  const result = await engineWith(fakeBrowser()).run(workflow);
  assert.equal(result.status, 'success');
  assert.ok(result.logs.some((entry) => /unknown node type/i.test(entry.message)));
});

test('an aborted run reports as cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  const workflow = {
    nodes: [
      { id: 't', type: 'trigger.manual', params: {} },
      { id: 'log', type: 'flow.log', params: { message: 'hi' } },
    ],
    edges: [{ from: 't', fromPort: 'main', to: 'log' }],
  };

  const result = await engineWith(fakeBrowser()).run(workflow, { signal: controller.signal });
  assert.equal(result.status, 'cancelled');
});

test('page-load trigger patterns match by substring and by regex', () => {
  assert.equal(matchesPattern('https://news.example.com/a', 'example.com'), true);
  assert.equal(matchesPattern('https://other.test/a', 'example.com'), false);
  assert.equal(matchesPattern('https://shop.test/item/42', '/item\\/\\d+/'), true);
  assert.equal(matchesPattern('https://shop.test/about', '/item\\/\\d+/'), false);
  // An empty pattern means "every page".
  assert.equal(matchesPattern('https://anything.test/', ''), true);
  assert.equal(matchesPattern('https://anything.test/', undefined), true);
});
