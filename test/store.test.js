'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/main/store');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browseme-store-'));
  return path.join(dir, 'settings.json');
}

test('reads defaults when no file exists', () => {
  const store = new Store(tempFile(), { settings: { theme: 'system' } });
  assert.equal(store.get('settings.theme'), 'system');
  assert.equal(store.get('settings.missing', 'fallback'), 'fallback');
});

test('sets and reads nested paths, creating intermediate objects', () => {
  const store = new Store(tempFile());
  store.set('shields.sites.example.com', { enabled: false });
  assert.deepEqual(store.get('shields.sites.example.com'), { enabled: false });
  assert.deepEqual(store.get('shields.sites.other.com', {}), {});
});

test('delete removes a key without disturbing siblings', () => {
  const store = new Store(tempFile());
  store.set('a.b', 1);
  store.set('a.c', 2);
  store.delete('a.b');
  assert.equal(store.get('a.b'), undefined);
  assert.equal(store.get('a.c'), 2);
});

test('push prepends and enforces the limit', () => {
  const store = new Store(tempFile());
  for (let i = 0; i < 5; i++) store.push('history', { i }, 3);
  const history = store.get('history');
  assert.equal(history.length, 3);
  // Newest first.
  assert.deepEqual(history.map((h) => h.i), [4, 3, 2]);
});

test('persists to disk and reloads', () => {
  const file = tempFile();
  const store = new Store(file);
  store.set('settings.searchEngine', 'brave');
  store.saveNow();

  const reloaded = new Store(file);
  assert.equal(reloaded.get('settings.searchEngine'), 'brave');
});

test('a corrupt file falls back to defaults instead of throwing', () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');

  const store = new Store(file, { settings: { theme: 'dark' } });
  assert.equal(store.get('settings.theme'), 'dark');
});
