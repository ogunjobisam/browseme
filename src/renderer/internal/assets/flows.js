import { api, h, $, debounce } from './ui.js';

/**
 * Flows editor.
 *
 * A node-graph editor over the workflow engine in the main process: pick a
 * trigger, wire actions after it, configure each node in the inspector, and
 * run it. The canvas is plain DOM nodes positioned in a transformed layer
 * with SVG bezier edges behind them — no graph library.
 */

const state = {
  flows: [],
  catalog: [],
  current: null,          // the workflow being edited
  selectedNodeId: null,
  pan: { x: 40, y: 40 },
  zoom: 1,
  dirty: false,
  lastRun: null,
};

const els = {
  flowList: $('#flow-list'),
  paletteGroups: $('#palette-groups'),
  canvas: $('#canvas-wrap'),
  edges: $('#edges'),
  nodes: $('#nodes'),
  empty: $('#canvas-empty'),
  inspector: $('#inspector'),
  name: $('#flow-name'),
  enabled: $('#toggle-enabled'),
  enabledLabel: $('#enabled-label'),
  runLog: $('#run-log'),
  runStatus: $('#run-status'),
  runOutput: $('#run-output'),
};

const CATEGORY_ORDER = ['trigger', 'browser', 'data', 'flow'];
const CATEGORY_LABELS = { trigger: 'Triggers', browser: 'Browser', data: 'Data', flow: 'Flow control' };

let nodeSeq = 1;
function nextNodeId() {
  return `n${nodeSeq++}-${Math.random().toString(36).slice(2, 6)}`;
}

function definition(type) {
  return state.catalog.find((entry) => entry.type === type);
}

// ------------------------------------------------------------- flow list

function renderFlowList() {
  els.flowList.replaceChildren();
  if (!state.flows.length) {
    els.flowList.append(h('p', { class: 'muted', style: { padding: '4px 10px', fontSize: '12.5px' }, text: 'No flows yet.' }));
    return;
  }
  for (const flow of state.flows) {
    els.flowList.append(h('div', {
      class: 'flow-item' + (state.current?.id === flow.id ? ' active' : ''),
      onclick: () => openFlow(flow.id),
    },
      h('span', { class: 'dot' + (flow.enabled ? ' on' : '') }),
      h('span', { class: 'name', text: flow.name }),
    ));
  }
}

// --------------------------------------------------------------- palette

function renderPalette() {
  els.paletteGroups.replaceChildren();
  for (const category of CATEGORY_ORDER) {
    const entries = state.catalog.filter((entry) => entry.category === category);
    if (!entries.length) continue;

    const group = h('div', { class: 'palette-group' }, h('h3', { text: CATEGORY_LABELS[category] }));
    for (const entry of entries) {
      const node = h('div', {
        class: 'palette-node',
        draggable: 'true',
        title: entry.description,
        onclick: () => addNode(entry.type, { x: 120, y: 120 + Math.random() * 120 }),
        ondragstart: (event) => event.dataTransfer.setData('text/browseme-node', entry.type),
      },
        h('span', { class: 'icon', text: entry.icon || '•' }),
        h('span', { text: entry.label }),
      );
      group.append(node);
    }
    els.paletteGroups.append(group);
  }
}

// ---------------------------------------------------------------- canvas

function applyTransform() {
  const transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  els.nodes.style.transform = transform;
  els.edges.style.transform = transform;
}

const NODE_WIDTH = 190;
const NODE_HEIGHT = 96;

/**
 * Zoom and pan so the whole graph is on screen.
 * Loading a saved flow otherwise drops you at the origin, which for anything
 * wider than the canvas means staring at empty grid.
 */
function fitToView() {
  const nodes = state.current?.nodes || [];
  if (!nodes.length) {
    state.pan = { x: 40, y: 40 };
    state.zoom = 1;
    return applyTransform();
  }

  const rect = els.canvas.getBoundingClientRect();
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
  const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));

  const padding = 60;
  const scaleX = (rect.width - padding * 2) / Math.max(1, maxX - minX);
  const scaleY = (rect.height - padding * 2) / Math.max(1, maxY - minY);
  // Never zoom past 1:1 — a two-node flow blown up to fill the canvas looks
  // broken, not helpful.
  state.zoom = Math.max(0.35, Math.min(1, scaleX, scaleY));

  state.pan = {
    x: (rect.width - (maxX - minX) * state.zoom) / 2 - minX * state.zoom,
    y: (rect.height - (maxY - minY) * state.zoom) / 2 - minY * state.zoom,
  };
  applyTransform();
}

/** Convert a client-space point into canvas coordinates. */
function toCanvas(clientX, clientY) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.pan.x) / state.zoom,
    y: (clientY - rect.top - state.pan.y) / state.zoom,
  };
}

function portPosition(nodeId, port, direction) {
  const node = state.current.nodes.find((n) => n.id === nodeId);
  if (!node) return { x: 0, y: 0 };
  const def = definition(node.type);
  const outputs = def?.outputs || ['main'];

  if (direction === 'in') return { x: node.position.x, y: node.position.y + 28 };

  const index = Math.max(0, outputs.indexOf(port));
  return { x: node.position.x + 190, y: node.position.y + 28 + index * 22 };
}

function bezier(from, to) {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
}

function renderEdges() {
  els.edges.replaceChildren();
  if (!state.current) return;

  for (const [index, edge] of state.current.edges.entries()) {
    const from = portPosition(edge.from, edge.fromPort || 'main', 'out');
    const to = portPosition(edge.to, 'main', 'in');
    const path = bezier(from, to);

    // A wide invisible stroke underneath makes the thin edge clickable.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', path);
    hit.setAttribute('class', 'edge-hit');
    hit.addEventListener('click', () => {
      state.current.edges.splice(index, 1);
      markDirty();
      render();
    });

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', path);
    line.setAttribute('class', 'edge');

    const tooltip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tooltip.textContent = 'Click to remove this connection';
    line.append(tooltip);

    els.edges.append(hit, line);
  }
}

function summarise(node) {
  const def = definition(node.type);
  if (!def?.params?.length) return def?.description || '';
  const parts = [];
  for (const param of def.params) {
    const value = node.params?.[param.key];
    if (value === undefined || value === '' || value === null) continue;
    parts.push(`${param.label}: ${String(value).slice(0, 40)}`);
    if (parts.length === 2) break;
  }
  return parts.join(' · ') || def.description;
}

function renderNodes() {
  els.nodes.replaceChildren();
  if (!state.current) return;

  els.empty.hidden = state.current.nodes.length > 0;

  for (const node of state.current.nodes) {
    const def = definition(node.type);
    const result = state.lastRun?.nodeResults?.[node.id];

    const element = h('div', {
      class: 'node'
        + (state.selectedNodeId === node.id ? ' selected' : '')
        + (result?.error ? ' failed' : '')
        + (result?.skipped ? ' skipped' : '')
        + (result && !result.error && !result.skipped ? ' ok' : ''),
      'data-category': def?.category || 'data',
      'data-id': node.id,
      style: { left: `${node.position.x}px`, top: `${node.position.y}px` },
      onmousedown: (event) => startNodeDrag(event, node),
    },
      h('div', { class: 'node-head' },
        h('span', { class: 'icon', text: def?.icon || '•' }),
        h('span', { text: node.name || def?.label || node.type }),
      ),
      h('div', { class: 'node-body', text: summarise(node) }),
      result
        ? h('div', { class: 'node-result' },
            result.error
              ? h('span', { text: `error: ${result.error}` })
              : h('span', {}, h('b', { text: String(result.count ?? 0) }), document.createTextNode(' items')),
          )
        : null,
    );

    if ((def?.inputs || []).length) {
      element.append(h('span', {
        class: 'port in',
        title: 'Input',
        onmouseup: (event) => finishConnection(event, node.id),
      }));
    }

    (def?.outputs || ['main']).forEach((port, index) => {
      element.append(h('span', {
        class: 'port out',
        style: { top: `${22 + index * 22}px` },
        title: `Output: ${port}`,
        onmousedown: (event) => startConnection(event, node.id, port),
      }));
      if ((def?.outputs || []).length > 1) {
        element.append(h('span', {
          class: 'port-label',
          style: { top: `${18 + index * 22}px` },
          text: port,
        }));
      }
    });

    els.nodes.append(element);
  }
}

function render() {
  renderNodes();
  renderEdges();
  renderInspector();
  applyTransform();
}

// ------------------------------------------------------------ interaction

let drag = null;

function startNodeDrag(event, node) {
  if (event.target.classList.contains('port')) return;
  event.stopPropagation();
  selectNode(node.id);

  const start = toCanvas(event.clientX, event.clientY);
  drag = {
    kind: 'node',
    node,
    offset: { x: start.x - node.position.x, y: start.y - node.position.y },
  };
}

let pending = null;

function startConnection(event, nodeId, port) {
  event.stopPropagation();
  event.preventDefault();
  pending = { from: nodeId, fromPort: port };

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'edge pending');
  els.edges.append(path);
  pending.path = path;
}

function finishConnection(event, targetId) {
  if (!pending) return;
  event.stopPropagation();

  if (pending.from !== targetId) {
    const exists = state.current.edges.some(
      (edge) => edge.from === pending.from && edge.fromPort === pending.fromPort && edge.to === targetId,
    );
    if (!exists) {
      state.current.edges.push({ from: pending.from, fromPort: pending.fromPort, to: targetId });
      markDirty();
    }
  }
  clearPending();
  render();
}

function clearPending() {
  pending?.path?.remove();
  pending = null;
}

els.canvas.addEventListener('mousedown', (event) => {
  if (event.target.closest('.node')) return;
  drag = { kind: 'pan', start: { x: event.clientX - state.pan.x, y: event.clientY - state.pan.y } };
  els.canvas.classList.add('panning');
  selectNode(null);
});

window.addEventListener('mousemove', (event) => {
  if (pending) {
    const from = portPosition(pending.from, pending.fromPort, 'out');
    pending.path.setAttribute('d', bezier(from, toCanvas(event.clientX, event.clientY)));
    return;
  }
  if (!drag) return;

  if (drag.kind === 'pan') {
    state.pan = { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y };
    applyTransform();
  } else if (drag.kind === 'node') {
    const point = toCanvas(event.clientX, event.clientY);
    drag.node.position = {
      x: Math.round(point.x - drag.offset.x),
      y: Math.round(point.y - drag.offset.y),
    };
    markDirty();
    renderNodes();
    renderEdges();
  }
});

window.addEventListener('mouseup', () => {
  els.canvas.classList.remove('panning');
  drag = null;
  // A connection released over empty canvas is a cancel, not an error.
  if (pending) clearPending();
});

els.canvas.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  state.zoom = Math.max(0.35, Math.min(2, state.zoom * factor));
  applyTransform();
}, { passive: false });

els.canvas.addEventListener('dragover', (event) => event.preventDefault());
els.canvas.addEventListener('drop', (event) => {
  const type = event.dataTransfer.getData('text/browseme-node');
  if (!type) return;
  event.preventDefault();
  addNode(type, toCanvas(event.clientX, event.clientY));
});

window.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (typing) return;

  if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedNodeId) {
    event.preventDefault();
    deleteNode(state.selectedNodeId);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveFlow();
  }
});

// ----------------------------------------------------------- graph edits

function addNode(type, position) {
  if (!state.current) newFlow();
  const def = definition(type);
  const node = {
    id: nextNodeId(),
    type,
    name: def?.label || type,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    params: Object.fromEntries(
      (def?.params || [])
        .filter((param) => param.default !== undefined)
        .map((param) => [param.key, param.default]),
    ),
  };
  state.current.nodes.push(node);
  selectNode(node.id);
  markDirty();
  render();
  return node;
}

function deleteNode(id) {
  state.current.nodes = state.current.nodes.filter((node) => node.id !== id);
  state.current.edges = state.current.edges.filter((edge) => edge.from !== id && edge.to !== id);
  if (state.selectedNodeId === id) state.selectedNodeId = null;
  markDirty();
  render();
}

function selectNode(id) {
  state.selectedNodeId = id;
  renderNodes();
  renderInspector();
}

// ------------------------------------------------------------- inspector

function renderInspector() {
  const node = state.current?.nodes.find((n) => n.id === state.selectedNodeId);
  els.inspector.replaceChildren();

  if (!node) {
    els.inspector.append(h('div', { class: 'inspector-empty', text: 'Select a node to configure it.' }));
    return;
  }

  const def = definition(node.type);
  els.inspector.append(
    h('h2', { text: def?.label || node.type }),
    h('div', { class: 'node-type', text: node.type }),
  );

  const nameField = h('div', { class: 'field' },
    h('label', { text: 'Node name' }),
    h('input', {
      type: 'text',
      value: node.name || '',
      oninput: (event) => {
        node.name = event.target.value;
        markDirty();
        renderNodes();
      },
    }),
  );
  els.inspector.append(nameField);

  for (const param of def?.params || []) {
    els.inspector.append(paramField(node, param));
  }

  els.inspector.append(h('div', { class: 'template-help' },
    h('div', { html: 'Use <code>{{ item.field }}</code> to insert a value from the incoming item.' }),
    h('div', { html: 'Also available: <code>{{ $now }}</code>, <code>{{ $today }}</code>, <code>{{ item }}</code>.' }),
  ));

  els.inspector.append(h('button', {
    class: 'delete-node',
    text: 'Delete node',
    onclick: () => deleteNode(node.id),
  }));
}

function paramField(node, param) {
  const value = node.params?.[param.key] ?? param.default ?? '';
  const commit = (next) => {
    node.params = { ...(node.params || {}), [param.key]: next };
    markDirty();
    renderNodes();
  };

  let control;
  if (param.type === 'boolean') {
    control = h('div', { class: 'checkbox' },
      h('input', {
        type: 'checkbox',
        id: `p-${param.key}`,
        checked: Boolean(value),
        onchange: (event) => commit(event.target.checked),
      }),
      h('label', { for: `p-${param.key}`, text: param.label, style: { margin: 0 } }),
    );
    return h('div', { class: 'field' }, control);
  }

  if (param.type === 'select') {
    control = h('select', { onchange: (event) => commit(event.target.value) },
      ...param.options.map((option) => h('option', {
        value: option,
        selected: String(value) === option,
        text: option,
      })),
    );
  } else if (param.type === 'textarea') {
    control = h('textarea', {
      placeholder: param.placeholder || '',
      oninput: debounce((event) => commit(event.target.value), 300),
    });
    control.value = value;
  } else if (param.type === 'number') {
    control = h('input', {
      type: 'number',
      value: String(value),
      min: param.min ?? null,
      oninput: (event) => commit(Number(event.target.value)),
    });
  } else {
    control = h('input', {
      type: 'text',
      value: String(value),
      placeholder: param.placeholder || '',
      oninput: debounce((event) => commit(event.target.value), 250),
    });
  }

  return h('div', { class: 'field' },
    h('label', { text: param.label }),
    control,
    param.placeholder && param.type !== 'select'
      ? h('div', { class: 'hint', text: param.placeholder })
      : null,
  );
}

// ------------------------------------------------------------- flow CRUD

function markDirty() {
  state.dirty = true;
  els.name.classList.add('dirty');
}

function newFlow() {
  state.current = {
    id: undefined,
    name: 'New flow',
    enabled: true,
    nodes: [],
    edges: [],
    vars: {},
  };
  state.selectedNodeId = null;
  state.lastRun = null;
  syncHeader();
  render();
  renderFlowList();
}

async function openFlow(id) {
  const flow = await api.invoke('flows:get', { id });
  if (!flow) return;
  state.current = JSON.parse(JSON.stringify(flow));
  state.selectedNodeId = null;
  state.lastRun = (await api.invoke('flows:lastRun', { id }))?.result || null;
  state.dirty = false;
  syncHeader();
  render();
  fitToView();
  renderFlowList();
}

function syncHeader() {
  els.name.value = state.current?.name || '';
  els.name.classList.remove('dirty');
  const enabled = state.current?.enabled !== false;
  els.enabled.setAttribute('aria-checked', String(enabled));
  els.enabledLabel.textContent = enabled ? 'Enabled' : 'Disabled';
}

async function saveFlow() {
  if (!state.current) return;
  state.current.name = els.name.value.trim() || 'Untitled flow';
  const saved = await api.invoke('flows:save', { workflow: state.current });
  state.current = JSON.parse(JSON.stringify(saved));
  state.dirty = false;
  els.name.classList.remove('dirty');
  await refreshFlows();
  renderFlowList();
}

async function refreshFlows() {
  state.flows = await api.invoke('flows:list');
}

els.name.addEventListener('input', markDirty);

els.enabled.addEventListener('click', () => {
  if (!state.current) return;
  state.current.enabled = els.enabled.getAttribute('aria-checked') !== 'true';
  els.enabled.setAttribute('aria-checked', String(state.current.enabled));
  els.enabledLabel.textContent = state.current.enabled ? 'Enabled' : 'Disabled';
  markDirty();
});

$('#new-flow').addEventListener('click', newFlow);
$('#save-flow').addEventListener('click', saveFlow);

$('#duplicate-flow').addEventListener('click', async () => {
  if (!state.current?.id) return;
  const copy = await api.invoke('flows:duplicate', { id: state.current.id });
  await refreshFlows();
  if (copy) openFlow(copy.id);
});

$('#delete-flow').addEventListener('click', async () => {
  if (!state.current?.id) return newFlow();
  await api.invoke('flows:remove', { id: state.current.id });
  await refreshFlows();
  newFlow();
});

$('#close-log').addEventListener('click', () => { els.runLog.hidden = true; });

$('#run-flow').addEventListener('click', async () => {
  if (!state.current) return;
  if (state.dirty || !state.current.id) await saveFlow();

  els.runLog.hidden = false;
  els.runStatus.textContent = 'Running…';
  els.runStatus.className = '';
  els.runOutput.textContent = '';

  const result = await api.invoke('flows:run', { id: state.current.id })
    .catch((err) => ({ status: 'error', error: String(err.message || err), logs: [] }));

  state.lastRun = result;
  els.runStatus.textContent = result.status === 'success'
    ? `Finished in ${result.durationMs} ms — ${result.output?.length || 0} items`
    : `Failed: ${result.error}`;
  els.runStatus.className = result.status === 'success' ? 'ok' : 'failed';

  const lines = (result.logs || []).map((entry) => `[${entry.level}] ${entry.message}`);
  if (result.output?.length) {
    lines.push('', '— output —', JSON.stringify(result.output.slice(0, 20), null, 2));
  }
  els.runOutput.textContent = lines.join('\n') || 'No output.';
  render();
});

api.on('flows-changed', async () => {
  await refreshFlows();
  renderFlowList();
});

// --------------------------------------------------------------- startup

(async function init() {
  state.catalog = await api.invoke('flows:catalog');
  await refreshFlows();
  renderPalette();
  renderFlowList();

  if (state.flows.length) openFlow(state.flows[0].id);
  else {
    newFlow();
    seedExample();
  }
})();

/** A first flow that shows the shape of the thing without being magic. */
function seedExample() {
  const trigger = addNode('trigger.manual', { x: 60, y: 80 });
  const open = addNode('browser.openTab', { x: 320, y: 80 });
  const extract = addNode('browser.extract', { x: 580, y: 80 });
  const log = addNode('flow.log', { x: 840, y: 80 });

  open.params = { url: 'https://news.ycombinator.com', mode: 'current', background: true };
  extract.params = { selector: '.titleline > a', attribute: 'text', multiple: true, field: 'headline' };
  log.params = { message: '{{ item.headline }}' };

  state.current.name = 'Example — read Hacker News headlines';
  state.current.edges = [
    { from: trigger.id, fromPort: 'main', to: open.id },
    { from: open.id, fromPort: 'main', to: extract.id },
    { from: extract.id, fromPort: 'main', to: log.id },
  ];
  state.selectedNodeId = null;
  syncHeader();
  render();
  fitToView();
}
