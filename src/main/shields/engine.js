'use strict';

const { parseFilter } = require('./parser');
const { isThirdParty, hostnameVariants } = require('./psl');

/**
 * Token-indexed matching engine.
 *
 * Linear-scanning 100k+ rules per request would stall page loads, so every
 * rule is filed under one token drawn from its pattern. At request time we
 * tokenise the URL and only test rules filed under a token the URL actually
 * contains, plus the small "untokenisable" bucket (bare regexes, `*` rules).
 * That turns a ~100k-rule scan into a few dozen regex tests.
 */

const TOKEN_RE = /[a-z0-9%]{3,}/g;

// Tokens so common they would defeat the index; never used as a rule's key.
const BAD_TOKENS = new Set([
  'http', 'https', 'www', 'com', 'net', 'org', 'html', 'index', 'the', 'and',
  'php', 'jpg', 'png', 'gif', 'css', 'js', 'json', 'img', 'images', 'static',
  'content', 'assets', 'cdn', 'api', 'default',
]);

function tokenize(text) {
  TOKEN_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) out.push(m[0]);
  return out;
}

/**
 * Pick the token a rule should be filed under: the longest token that is not
 * on the common-token blocklist, because rarer tokens mean smaller buckets.
 */
function pickToken(pattern) {
  const tokens = tokenize(pattern.toLowerCase());
  let best = null;
  for (const token of tokens) {
    if (BAD_TOKENS.has(token)) continue;
    if (!best || token.length > best.length) best = token;
  }
  return best;
}

/** Does `hostname` fall under `domain` (exact or a subdomain of it)? */
function domainMatches(set, hostname) {
  if (!set) return false;
  for (const variant of hostnameVariants(hostname)) {
    if (set.has(variant)) return true;
  }
  return false;
}

class FilterEngine {
  constructor() {
    /** @type {Map<string, object[]>} token -> blocking rules */
    this.blockIndex = new Map();
    /** @type {Map<string, object[]>} token -> exception rules */
    this.allowIndex = new Map();
    this.blockGeneric = [];
    this.allowGeneric = [];

    // Generic hiding rules are split so a page only ever receives the ones
    // that can possibly match it. `.foo` is filed under the class token
    // `foo`; anything not reducible to a single class or id token goes in
    // the (much smaller) complex bucket and is always sent.
    /** @type {Map<string, string[]>} class/id token -> selectors */
    this.cosmeticGenericByToken = new Map();
    this.cosmeticGenericComplex = [];
    /** @type {Map<string, string[]>} domain -> selectors */
    this.cosmeticByDomain = new Map();
    /** @type {Map<string, Set<string>>} domain -> unhidden selectors */
    this.cosmeticExceptions = new Map();
    this.cosmeticGenericExceptions = new Set();

    this.stats = { network: 0, cosmetic: 0, unsupported: 0, invalid: 0, comments: 0 };
    this._cosmeticCache = new Map();
  }

  /**
   * Add every rule in a filter list body. Returns per-call stats.
   * @param {string} text raw filter list contents
   */
  addFilters(text) {
    const before = { ...this.stats };
    const lines = String(text).split('\n');

    for (const line of lines) {
      const rule = parseFilter(line);
      switch (rule.kind) {
        case 'network':
          this._addNetworkRule(rule);
          this.stats.network++;
          break;
        case 'cosmetic':
          this._addCosmeticRule(rule);
          this.stats.cosmetic++;
          break;
        case 'unsupported':
          this.stats.unsupported++;
          break;
        case 'invalid':
          this.stats.invalid++;
          break;
        default:
          this.stats.comments++;
      }
    }

    this._cosmeticCache.clear();
    return {
      network: this.stats.network - before.network,
      cosmetic: this.stats.cosmetic - before.cosmetic,
      unsupported: this.stats.unsupported - before.unsupported,
      invalid: this.stats.invalid - before.invalid,
    };
  }

  _addNetworkRule(rule) {
    const index = rule.exception ? this.allowIndex : this.blockIndex;
    const generic = rule.exception ? this.allowGeneric : this.blockGeneric;
    const token = rule.isRegex ? null : pickToken(rule.pattern);

    if (token) {
      const bucket = index.get(token);
      if (bucket) bucket.push(rule);
      else index.set(token, [rule]);
    } else {
      generic.push(rule);
    }
  }

  _addCosmeticRule(rule) {
    if (rule.exception) {
      if (!rule.domains) {
        this.cosmeticGenericExceptions.add(rule.selector);
        return;
      }
      for (const domain of rule.domains) {
        let set = this.cosmeticExceptions.get(domain);
        if (!set) this.cosmeticExceptions.set(domain, (set = new Set()));
        set.add(rule.selector);
      }
      return;
    }

    if (!rule.domains) {
      // Generic hiding rules with exclusions are rare; treat the exclusion as
      // a per-domain unhide so the selector still works everywhere else.
      if (rule.excludedDomains) {
        for (const domain of rule.excludedDomains) {
          let set = this.cosmeticExceptions.get(domain);
          if (!set) this.cosmeticExceptions.set(domain, (set = new Set()));
          set.add(rule.selector);
        }
      }

      const token = classOrIdToken(rule.selector);
      if (token) {
        const list = this.cosmeticGenericByToken.get(token);
        if (list) list.push(rule.selector);
        else this.cosmeticGenericByToken.set(token, [rule.selector]);
      } else {
        this.cosmeticGenericComplex.push(rule.selector);
      }
      return;
    }

    for (const domain of rule.domains) {
      const list = this.cosmeticByDomain.get(domain);
      if (list) list.push(rule.selector);
      else this.cosmeticByDomain.set(domain, [rule.selector]);
    }
  }

  /** Test one rule against an already-normalised request. */
  _ruleApplies(rule, req) {
    if (rule.types && !rule.types.has(req.type)) return false;
    if (rule.excludedTypes && rule.excludedTypes.has(req.type)) return false;
    if (rule.thirdParty !== null && rule.thirdParty !== req.thirdParty) return false;
    if (rule.domains && !domainMatches(rule.domains, req.documentHostname)) return false;
    if (rule.excludedDomains && domainMatches(rule.excludedDomains, req.documentHostname)) return false;
    return rule.regexp.test(rule.matchCase ? req.url : req.lowerUrl);
  }

  _search(index, generic, req) {
    for (const token of req.tokens) {
      const bucket = index.get(token);
      if (!bucket) continue;
      for (const rule of bucket) {
        if (this._ruleApplies(rule, req)) return rule;
      }
    }
    for (const rule of generic) {
      if (this._ruleApplies(rule, req)) return rule;
    }
    return null;
  }

  /**
   * Decide whether a request should be blocked.
   *
   * @param {{url: string, type: string, documentUrl?: string, documentHostname?: string}} request
   * @returns {{blocked: boolean, rule: object|null, reason: string}}
   */
  match(request) {
    const url = request.url || '';
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
      return { blocked: false, rule: null, reason: 'inline' };
    }

    let hostname = request.hostname;
    if (hostname === undefined) {
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = '';
      }
    }

    let documentHostname = request.documentHostname;
    if (documentHostname === undefined && request.documentUrl) {
      try {
        documentHostname = new URL(request.documentUrl).hostname;
      } catch {
        documentHostname = '';
      }
    }
    documentHostname = documentHostname || hostname;

    const lowerUrl = url.toLowerCase();
    const req = {
      url,
      lowerUrl,
      hostname,
      documentHostname,
      type: request.type || 'other',
      thirdParty: isThirdParty(hostname, documentHostname),
      tokens: tokenize(lowerUrl),
    };

    const blockRule = this._search(this.blockIndex, this.blockGeneric, req);
    if (!blockRule) return { blocked: false, rule: null, reason: 'no-match' };

    const allowRule = this._search(this.allowIndex, this.allowGeneric, req);
    if (allowRule && !(blockRule.important && !allowRule.important)) {
      return { blocked: false, rule: allowRule, reason: 'exception' };
    }

    return { blocked: true, rule: blockRule, reason: 'blocked' };
  }

  /**
   * CSS selectors to hide on a page.
   *
   * Pass `tokens` — the class names and ids actually present in the document
   * — to get only the generic rules that can match it. Without tokens every
   * generic rule is returned, which is correct but can be tens of thousands
   * of selectors, so the content script always surveys first.
   *
   * @param {string} hostname
   * @param {{generic?: boolean, tokens?: string[]}} [opts]
   */
  getCosmeticSelectors(hostname, opts = {}) {
    const includeGeneric = opts.generic !== false;
    const tokens = opts.tokens;

    // Only the token-free lookup is worth caching; surveyed lookups differ
    // per page and would just churn the cache.
    const cacheKey = tokens ? null : `${includeGeneric ? 'g' : 's'}:${hostname}`;
    if (cacheKey) {
      const cached = this._cosmeticCache.get(cacheKey);
      if (cached) return cached;
    }

    const variants = hostnameVariants(hostname);
    const excluded = new Set(this.cosmeticGenericExceptions);
    for (const variant of variants) {
      const set = this.cosmeticExceptions.get(variant);
      if (set) for (const sel of set) excluded.add(sel);
    }

    const selectors = new Set();
    const add = (sel) => {
      if (!excluded.has(sel)) selectors.add(sel);
    };

    if (includeGeneric) {
      for (const sel of this.cosmeticGenericComplex) add(sel);
      if (tokens) {
        for (const token of tokens) {
          for (const sel of this.cosmeticGenericByToken.get(token) || []) add(sel);
        }
      } else {
        for (const list of this.cosmeticGenericByToken.values()) {
          for (const sel of list) add(sel);
        }
      }
    }

    for (const variant of variants) {
      for (const sel of this.cosmeticByDomain.get(variant) || []) add(sel);
    }

    const result = [...selectors];
    if (cacheKey) {
      // Bound the cache; hostnames are unbounded but pages repeat a lot.
      if (this._cosmeticCache.size > 500) this._cosmeticCache.clear();
      this._cosmeticCache.set(cacheKey, result);
    }
    return result;
  }

  get ruleCount() {
    return this.stats.network + this.stats.cosmetic;
  }
}

/**
 * The single class or id a selector hinges on, if there is one.
 * `.ad-slot` -> `ad-slot`; `#banner > a` -> `banner`; `div[data-ad]` -> null.
 */
function classOrIdToken(selector) {
  const match = /^([.#])([A-Za-z0-9_-]+)/.exec(selector.trim());
  return match ? match[2] : null;
}

module.exports = { FilterEngine, tokenize, pickToken, classOrIdToken };
