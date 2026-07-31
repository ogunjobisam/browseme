'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { shell, app } = require('electron');

/**
 * Download tracking.
 *
 * Electron hands us a DownloadItem per download; this keeps a live view of
 * the in-flight ones plus a persisted history, and deliberately drops
 * private-mode downloads from that history.
 */
class DownloadManager extends EventEmitter {
  /** @param {{store: import('./store').Store}} opts */
  constructor({ store }) {
    super();
    this.store = store;
    /** @type {Map<string, {item: Electron.DownloadItem, record: object}>} */
    this.active = new Map();
    this._nextId = 1;
  }

  /**
   * @param {Electron.Session} session
   * @param {'normal'|'private'} mode
   */
  attach(session, mode) {
    session.on('will-download', (_event, item) => {
      const id = `dl-${this._nextId++}`;
      const record = {
        id,
        mode,
        filename: item.getFilename(),
        url: item.getURL(),
        savePath: '',
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        startedAt: Date.now(),
        paused: false,
      };

      this.active.set(id, { item, record });
      this.emit('changed');

      item.on('updated', (__, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        record.paused = item.isPaused();
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        this.emit('changed');
      });

      item.once('done', (__, state) => {
        record.state = state;
        record.savePath = item.getSavePath();
        record.receivedBytes = item.getReceivedBytes();
        record.finishedAt = Date.now();
        this.active.delete(id);

        // Private downloads land on disk but leave no trace in the browser.
        if (mode !== 'private') {
          this.store.push('downloads', { ...record }, 200);
        }
        this.emit('changed');
        this.emit('done', record);
      });
    });
  }

  list() {
    const live = [...this.active.values()].map((entry) => entry.record);
    return [...live, ...this.store.get('downloads', [])];
  }

  pause(id) {
    const entry = this.active.get(id);
    if (entry) entry.item.pause();
  }

  resume(id) {
    const entry = this.active.get(id);
    if (entry && entry.item.canResume()) entry.item.resume();
  }

  cancel(id) {
    const entry = this.active.get(id);
    if (entry) entry.item.cancel();
  }

  reveal(id) {
    const record = this.list().find((r) => r.id === id);
    if (record?.savePath) shell.showItemInFolder(record.savePath);
  }

  open(id) {
    const record = this.list().find((r) => r.id === id);
    if (record?.savePath) void shell.openPath(record.savePath);
  }

  clearHistory() {
    this.store.set('downloads', []);
    this.emit('changed');
  }

  static defaultDirectory() {
    return app.getPath('downloads');
  }

  static basename(target) {
    return target ? path.basename(target) : '';
  }
}

module.exports = { DownloadManager };
