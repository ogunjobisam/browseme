'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInput, SEARCH_ENGINES } = require('../src/main/tabs');

/**
 * Omnibox input handling: the difference between "go to this address" and
 * "search for this" is one of the few things a browser must never get wrong.
 */

test('keeps URLs that already carry a scheme', () => {
  assert.equal(normalizeInput('https://example.com/a?b=c'), 'https://example.com/a?b=c');
  assert.equal(normalizeInput('http://example.com'), 'http://example.com');
  assert.equal(normalizeInput('browseme://settings'), 'browseme://settings');
  assert.equal(normalizeInput('file:///tmp/x.html'), 'file:///tmp/x.html');
  assert.equal(normalizeInput('view-source:https://example.com'), 'view-source:https://example.com');
});

test('promotes bare hostnames to https', () => {
  assert.equal(normalizeInput('example.com'), 'https://example.com');
  assert.equal(normalizeInput('www.example.co.uk/path'), 'https://www.example.co.uk/path');
  assert.equal(normalizeInput('//example.com'), 'https://example.com');
});

test('handles localhost and IP addresses with ports', () => {
  assert.equal(normalizeInput('localhost:3000'), 'https://localhost:3000');
  assert.equal(normalizeInput('127.0.0.1:8080/admin'), 'https://127.0.0.1:8080/admin');
});

test('searches anything that is not a URL', () => {
  assert.equal(normalizeInput('hello world'), 'https://duckduckgo.com/?q=hello%20world');
  // A single word with no dot is a search, not a hostname guess.
  assert.equal(normalizeInput('electron'), 'https://duckduckgo.com/?q=electron');
  // Text containing a dot but also spaces is still a search.
  assert.ok(normalizeInput('what is node.js').startsWith('https://duckduckgo.com/?q='));
});

test('respects the selected search engine', () => {
  assert.equal(normalizeInput('privacy', 'brave'), 'https://search.brave.com/search?q=privacy');
  assert.equal(normalizeInput('privacy', 'google'), 'https://www.google.com/search?q=privacy');
  // Unknown engines fall back rather than producing a broken URL.
  assert.equal(normalizeInput('privacy', 'nonexistent'), 'https://duckduckgo.com/?q=privacy');
});

test('empty input opens the new tab page', () => {
  assert.equal(normalizeInput(''), 'browseme://newtab');
  assert.equal(normalizeInput('   '), 'browseme://newtab');
  assert.equal(normalizeInput(null), 'browseme://newtab');
});

test('every search engine template has a substitution slot', () => {
  for (const [name, template] of Object.entries(SEARCH_ENGINES)) {
    assert.ok(template.includes('%s'), `${name} template is missing %s`);
    assert.ok(template.startsWith('https://'), `${name} template is not https`);
  }
});
