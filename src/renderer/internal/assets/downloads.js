import { api, h, $, renderList, formatBytes, timeAgo, hostOf } from './ui.js';

/** Downloads page: live progress for in-flight items, history below. */

const STATE_LABELS = {
  progressing: 'Downloading',
  completed: 'Completed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function row(item) {
  const done = item.state === 'completed';
  const progress = item.totalBytes
    ? Math.round((item.receivedBytes / item.totalBytes) * 100)
    : null;

  const detail = done
    ? `${formatBytes(item.receivedBytes)} · ${timeAgo(item.finishedAt || item.startedAt)}`
    : item.state === 'progressing'
      ? `${formatBytes(item.receivedBytes)}${item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ''}${progress !== null ? ` (${progress}%)` : ''}`
      : STATE_LABELS[item.state] || item.state;

  const actions = h('div', { style: { display: 'flex', gap: '6px' } });
  if (item.state === 'progressing') {
    actions.append(
      h('button', {
        class: 'small',
        text: item.paused ? 'Resume' : 'Pause',
        onclick: () => api.invoke(item.paused ? 'downloads:resume' : 'downloads:pause', { id: item.id }),
      }),
      h('button', { class: 'small danger', text: 'Cancel', onclick: () => api.invoke('downloads:cancel', { id: item.id }) }),
    );
  } else if (done) {
    actions.append(
      h('button', { class: 'small', text: 'Open', onclick: () => api.invoke('downloads:open', { id: item.id }) }),
      h('button', { class: 'small', text: 'Show in folder', onclick: () => api.invoke('downloads:reveal', { id: item.id }) }),
    );
  }

  return h('div', { class: 'row' },
    h('div', { class: 'grow' },
      h('span', { text: item.filename }),
      h('small', { text: `${hostOf(item.url)} · ${detail}` }),
      item.state === 'progressing' && progress !== null
        ? h('div', {
            style: {
              height: '3px', marginTop: '6px', borderRadius: '2px',
              background: 'var(--border)', overflow: 'hidden',
            },
          }, h('div', { style: { width: `${progress}%`, height: '100%', background: 'var(--accent)' } }))
        : null,
    ),
    actions,
  );
}

async function load() {
  const items = await api.invoke('downloads:list');
  renderList($('#list'), items, row, 'No downloads yet.');
}

$('#clear').addEventListener('click', async () => {
  await api.invoke('downloads:clear');
  load();
});

api.on('downloads-changed', load);

load();
