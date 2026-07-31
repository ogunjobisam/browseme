'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FilterEngine, classOrIdToken } = require('../src/main/shields/engine');
const { parseFilter } = require('../src/main/shields/parser');
const { registrableDomain, isThirdParty } = require('../src/main/shields/psl');

/** Build an engine preloaded with a filter list body. */
function engineWith(filters) {
  const engine = new FilterEngine();
  engine.addFilters(filters);
  return engine;
}

test('registrableDomain handles plain, multi-label and IP hosts', () => {
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.example.com'), 'example.com');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('192.168.1.1'), '192.168.1.1');
  assert.equal(registrableDomain('localhost'), 'localhost');
  // Hosting suffixes: two GitHub Pages sites are not the same site.
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
});

test('isThirdParty compares sites, not hostnames', () => {
  assert.equal(isThirdParty('cdn.example.com', 'www.example.com'), false);
  assert.equal(isThirdParty('tracker.net', 'www.example.com'), true);
  assert.equal(isThirdParty('a.github.io', 'b.github.io'), true);
});

test('parses a domain-anchored rule', () => {
  const rule = parseFilter('||ads.example.com^');
  assert.equal(rule.kind, 'network');
  assert.equal(rule.exception, false);
  assert.ok(rule.regexp.test('https://ads.example.com/banner.js'));
  assert.ok(rule.regexp.test('https://sub.ads.example.com/x'));
  assert.ok(!rule.regexp.test('https://notads.example.com/x'));
});

test('parses options into a matchable shape', () => {
  const rule = parseFilter('/track.js$script,third-party,domain=example.com|~safe.example.com');
  assert.equal(rule.kind, 'network');
  assert.ok(rule.types.has('script'));
  assert.equal(rule.thirdParty, true);
  assert.ok(rule.domains.has('example.com'));
  assert.ok(rule.excludedDomains.has('safe.example.com'));
});

test('recognises comments, cosmetic rules and exceptions', () => {
  assert.equal(parseFilter('! a comment').kind, 'comment');
  assert.equal(parseFilter('[Adblock Plus 2.0]').kind, 'comment');
  assert.equal(parseFilter('').kind, 'comment');

  const cosmetic = parseFilter('example.com##.promo');
  assert.equal(cosmetic.kind, 'cosmetic');
  assert.equal(cosmetic.selector, '.promo');
  assert.ok(cosmetic.domains.has('example.com'));

  const unhide = parseFilter('example.com#@#.promo');
  assert.equal(unhide.exception, true);

  const exception = parseFilter('@@||example.com/ok.js');
  assert.equal(exception.exception, true);
});

test('blocks a matching third-party request', () => {
  const engine = engineWith('||ads.example.com^');
  const verdict = engine.match({
    url: 'https://ads.example.com/banner.js',
    type: 'script',
    documentUrl: 'https://news.example.org/article',
  });
  assert.equal(verdict.blocked, true);
});

test('leaves unmatched requests alone', () => {
  const engine = engineWith('||ads.example.com^');
  const verdict = engine.match({
    url: 'https://cdn.example.org/app.js',
    type: 'script',
    documentUrl: 'https://news.example.org/article',
  });
  assert.equal(verdict.blocked, false);
});

test('honours resource type options', () => {
  const engine = engineWith('||example.net/pixel$image');

  assert.equal(engine.match({
    url: 'https://example.net/pixel',
    type: 'image',
    documentUrl: 'https://site.test/',
  }).blocked, true);

  assert.equal(engine.match({
    url: 'https://example.net/pixel',
    type: 'script',
    documentUrl: 'https://site.test/',
  }).blocked, false);
});

test('honours the third-party option', () => {
  const engine = engineWith('||tracker.test/beacon$third-party');

  assert.equal(engine.match({
    url: 'https://tracker.test/beacon',
    type: 'xmlhttprequest',
    documentUrl: 'https://other.test/',
  }).blocked, true);

  // Same site: the rule does not apply.
  assert.equal(engine.match({
    url: 'https://tracker.test/beacon',
    type: 'xmlhttprequest',
    documentUrl: 'https://www.tracker.test/page',
  }).blocked, false);
});

test('honours domain= restrictions', () => {
  const engine = engineWith('/widget.js$domain=only.test');

  assert.equal(engine.match({
    url: 'https://cdn.test/widget.js',
    type: 'script',
    documentUrl: 'https://only.test/',
  }).blocked, true);

  assert.equal(engine.match({
    url: 'https://cdn.test/widget.js',
    type: 'script',
    documentUrl: 'https://elsewhere.test/',
  }).blocked, false);
});

test('exception rules override blocking rules', () => {
  const engine = engineWith(['||example.net^', '@@||example.net/needed.js'].join('\n'));

  assert.equal(engine.match({
    url: 'https://example.net/ad.js',
    type: 'script',
    documentUrl: 'https://site.test/',
  }).blocked, true);

  const allowed = engine.match({
    url: 'https://example.net/needed.js',
    type: 'script',
    documentUrl: 'https://site.test/',
  });
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.reason, 'exception');
});

test('$important beats a plain exception', () => {
  const engine = engineWith(['||example.net^$important', '@@||example.net^'].join('\n'));
  assert.equal(engine.match({
    url: 'https://example.net/ad.js',
    type: 'script',
    documentUrl: 'https://site.test/',
  }).blocked, true);
});

test('wildcards and separators behave', () => {
  const engine = engineWith('||cdn.test/*/ads/*.gif');
  assert.equal(engine.match({
    url: 'https://cdn.test/a/ads/banner.gif',
    type: 'image',
    documentUrl: 'https://site.test/',
  }).blocked, true);
  assert.equal(engine.match({
    url: 'https://cdn.test/a/content/banner.gif',
    type: 'image',
    documentUrl: 'https://site.test/',
  }).blocked, false);
});

test('regex rules are supported', () => {
  const engine = engineWith('/\\/adserver\\d+\\//');
  assert.equal(engine.match({
    url: 'https://x.test/adserver42/tag.js',
    type: 'script',
    documentUrl: 'https://site.test/',
  }).blocked, true);
});

test('data: and blob: URLs are never blocked', () => {
  const engine = engineWith('||test^');
  assert.equal(engine.match({ url: 'data:image/png;base64,AAA', type: 'image' }).blocked, false);
  assert.equal(engine.match({ url: 'blob:https://test/abc', type: 'media' }).blocked, false);
});

test('cosmetic selectors are scoped to their domain', () => {
  const engine = engineWith([
    'example.com##.promo',
    'other.com##.advert',
    '##.global-ad',
  ].join('\n'));

  const onExample = engine.getCosmeticSelectors('www.example.com');
  assert.ok(onExample.includes('.promo'));
  assert.ok(onExample.includes('.global-ad'));
  assert.ok(!onExample.includes('.advert'));
});

test('cosmetic exceptions unhide a selector on their domain', () => {
  const engine = engineWith(['##.global-ad', 'example.com#@#.global-ad'].join('\n'));
  assert.ok(!engine.getCosmeticSelectors('example.com').includes('.global-ad'));
  assert.ok(engine.getCosmeticSelectors('other.com').includes('.global-ad'));
});

test('generic hiding is filtered by the tokens a page actually uses', () => {
  const engine = engineWith(['##.banner-ad', '##.sidebar-promo', '##div[data-ad]'].join('\n'));

  const surveyed = engine.getCosmeticSelectors('site.test', { tokens: ['banner-ad'] });
  assert.ok(surveyed.includes('.banner-ad'));
  assert.ok(!surveyed.includes('.sidebar-promo'));
  // Selectors that are not a single class or id cannot be surveyed, so they
  // are always sent.
  assert.ok(surveyed.includes('div[data-ad]'));

  // No tokens at all means "give me everything".
  assert.equal(engine.getCosmeticSelectors('site.test').length, 3);
});

test('classOrIdToken extracts the indexable part of a selector', () => {
  assert.equal(classOrIdToken('.ad-slot'), 'ad-slot');
  assert.equal(classOrIdToken('#banner > a'), 'banner');
  assert.equal(classOrIdToken('div[data-ad]'), null);
});

test('the bundled base list loads and blocks a known ad host', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const body = await fs.readFile(
    path.join(__dirname, '..', 'src', 'main', 'shields', 'lists', 'base.txt'),
    'utf8',
  );

  const engine = new FilterEngine();
  const stats = engine.addFilters(body);
  assert.ok(stats.network > 100, `expected a substantial list, got ${stats.network} rules`);
  assert.ok(stats.invalid === 0, `bundled list has ${stats.invalid} invalid rules`);

  assert.equal(engine.match({
    url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    type: 'script',
    documentUrl: 'https://news.test/story',
  }).blocked, true);

  // Payment and captcha providers must survive: blocking these breaks sites
  // in ways users blame on the browser.
  assert.equal(engine.match({
    url: 'https://js.stripe.com/v3/',
    type: 'script',
    documentUrl: 'https://shop.test/checkout',
  }).blocked, false);
  assert.equal(engine.match({
    url: 'https://www.google.com/recaptcha/api.js',
    type: 'script',
    documentUrl: 'https://forum.test/login',
  }).blocked, false);
});
