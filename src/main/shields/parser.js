'use strict';

/**
 * Parser for Adblock Plus / uBlock Origin filter syntax.
 *
 * Supports the subset that does the overwhelming majority of the blocking:
 *
 *   Network rules
 *     ||ads.example.com^            anchored to domain start
 *     |http://example.com/          anchored to URL start
 *     /banner/*.gif|                anchored to URL end
 *     /ads?\d+/                     raw regular expression
 *     @@||example.com/ok            exception (allow)
 *     ...$script,third-party,domain=a.com|~b.com
 *
 *   Cosmetic rules
 *     ##.ad-banner                  hide everywhere
 *     example.com##.promo           hide on a domain
 *     example.com#@#.promo          un-hide on a domain
 *
 * Anything we do not understand is reported as unsupported rather than
 * silently dropped, so list coverage is measurable.
 */

const RESOURCE_TYPES = [
  'script', 'image', 'stylesheet', 'object', 'xmlhttprequest', 'subdocument',
  'document', 'websocket', 'media', 'font', 'ping', 'other', 'popup',
];

// Options we accept but that do not change match behaviour here.
const IGNORED_OPTIONS = new Set([
  'redirect', 'redirect-rule', 'csp', 'removeparam', 'queryprune', 'empty',
  'mp4', 'inline-script', 'inline-font', 'genericblock', 'generichide',
  'elemhide', 'specifichide', 'all', 'badfilter', 'cname', 'strict1p', 'strict3p',
]);

const TYPE_ALIASES = {
  xhr: 'xmlhttprequest',
  frame: 'subdocument',
  doc: 'document',
  css: 'stylesheet',
  ghide: 'generichide',
  ehide: 'elemhide',
  shide: 'specifichide',
  '3p': 'third-party',
  '1p': 'first-party',
  xmlhttprequest: 'xmlhttprequest',
};

const COSMETIC_SEPARATOR = /(#@?\??#)/;

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate an ABP pattern into a regular expression source string.
 *
 *   *        -> .*
 *   ^        -> separator: any char that is not a letter, digit, _, -, . or %
 *   ||       -> start of a domain (scheme and optional subdomains)
 *   leading| -> start of URL
 *   trailing|-> end of URL
 */
function patternToRegExpSource(pattern) {
  let src = pattern;
  let prefix = '';
  let suffix = '';

  if (src.startsWith('||')) {
    prefix = '^[a-z-]+://(?:[^/?#]+\\.)?';
    src = src.slice(2);
  } else if (src.startsWith('|')) {
    prefix = '^';
    src = src.slice(1);
  }

  if (src.endsWith('|') && !src.endsWith('\\|')) {
    suffix = '$';
    src = src.slice(0, -1);
  }

  const body = src
    .split('*')
    .map((chunk) => escapeRegExp(chunk).replace(/\\\^/g, '[^a-zA-Z0-9_\\-.%]'))
    .join('.*');

  return prefix + body + suffix;
}

/** Parse the `$...` option tail of a network rule. */
function parseOptions(optionString) {
  const opts = {
    types: null,          // Set of resource types the rule applies to
    excludedTypes: null,  // Set of resource types explicitly excluded
    thirdParty: null,     // true = 3p only, false = 1p only, null = either
    domains: null,        // Set of document domains the rule is limited to
    excludedDomains: null,
    matchCase: false,
    important: false,
    unsupported: null,
  };

  for (const rawPart of optionString.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;

    const negated = part.startsWith('~');
    const body = negated ? part.slice(1) : part;
    const eq = body.indexOf('=');
    const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? null : body.slice(eq + 1);
    const canonical = TYPE_ALIASES[name] || name;

    if (canonical === 'domain' || canonical === 'from') {
      for (const entry of (value || '').split('|')) {
        const domain = entry.trim().toLowerCase();
        if (!domain) continue;
        if (domain.startsWith('~')) {
          (opts.excludedDomains ||= new Set()).add(domain.slice(1));
        } else {
          (opts.domains ||= new Set()).add(domain);
        }
      }
      continue;
    }

    if (canonical === 'third-party') {
      opts.thirdParty = !negated;
      continue;
    }
    if (canonical === 'first-party') {
      opts.thirdParty = negated;
      continue;
    }
    if (canonical === 'match-case') {
      opts.matchCase = true;
      continue;
    }
    if (canonical === 'important') {
      opts.important = true;
      continue;
    }
    if (RESOURCE_TYPES.includes(canonical)) {
      if (negated) (opts.excludedTypes ||= new Set()).add(canonical);
      else (opts.types ||= new Set()).add(canonical);
      continue;
    }
    if (IGNORED_OPTIONS.has(canonical)) continue;

    opts.unsupported = name;
  }

  return opts;
}

/** Split a network rule at the option separator, respecting regex literals. */
function splitOptions(text) {
  // A leading /.../ regex body may legitimately contain '$'.
  if (text.startsWith('/')) {
    const closing = text.lastIndexOf('/');
    if (closing > 0) {
      const tail = text.slice(closing + 1);
      const dollar = tail.indexOf('$');
      if (dollar === -1) return [text, null];
      return [text.slice(0, closing + 1) + tail.slice(0, dollar), tail.slice(dollar + 1)];
    }
  }
  const idx = text.lastIndexOf('$');
  if (idx === -1) return [text, null];
  return [text.slice(0, idx), text.slice(idx + 1)];
}

function parseCosmetic(line, sepIndex, separator) {
  const domainPart = line.slice(0, sepIndex);
  const selector = line.slice(sepIndex + separator.length).trim();
  if (!selector) return { kind: 'invalid', reason: 'empty selector' };

  // #?# marks procedural selectors (:has-text, :xpath...) which need a
  // JavaScript evaluator; plain CSS ones we can still use.
  if (separator === '#?#' && /:-abp-|:has-text|:xpath|:matches-css|:upward|:watch-attr/.test(selector)) {
    return { kind: 'unsupported', reason: 'procedural selector' };
  }
  if (/:style\(|:remove\(/.test(selector)) {
    return { kind: 'unsupported', reason: 'action selector' };
  }

  const rule = {
    kind: 'cosmetic',
    selector,
    exception: separator === '#@#',
    domains: null,
    excludedDomains: null,
  };

  if (domainPart) {
    for (const entry of domainPart.split(',')) {
      const domain = entry.trim().toLowerCase();
      if (!domain) continue;
      if (domain.startsWith('~')) (rule.excludedDomains ||= new Set()).add(domain.slice(1));
      else (rule.domains ||= new Set()).add(domain);
    }
  }
  return rule;
}

/**
 * Parse a single filter list line.
 * Returns a rule object, or `{ kind: 'comment' | 'invalid' | 'unsupported' }`.
 */
function parseFilter(rawLine) {
  const line = rawLine.trim();
  if (!line) return { kind: 'comment' };
  if (line.startsWith('!') || line.startsWith('[Adblock') || line.startsWith('#')) {
    // A bare '#' line is a comment; '##sel' is cosmetic and handled below.
    if (!line.startsWith('##') && !line.startsWith('#@#') && !line.startsWith('#?#')) {
      return { kind: 'comment' };
    }
  }

  const cosmeticMatch = COSMETIC_SEPARATOR.exec(line);
  if (cosmeticMatch && !line.slice(0, cosmeticMatch.index).includes('$')) {
    return parseCosmetic(line, cosmeticMatch.index, cosmeticMatch[1]);
  }

  let text = line;
  const exception = text.startsWith('@@');
  if (exception) text = text.slice(2);

  const [patternPart, optionPart] = splitOptions(text);
  if (!patternPart) return { kind: 'invalid', reason: 'empty pattern' };

  const options = optionPart ? parseOptions(optionPart) : parseOptions('');
  if (options.unsupported) {
    return { kind: 'unsupported', reason: `option ${options.unsupported}` };
  }

  const isRegex = patternPart.length > 2 && patternPart.startsWith('/') && patternPart.endsWith('/');
  let source;
  if (isRegex) {
    source = patternPart.slice(1, -1);
  } else {
    source = patternToRegExpSource(options.matchCase ? patternPart : patternPart.toLowerCase());
  }

  let regexp;
  try {
    regexp = new RegExp(source, options.matchCase ? '' : 'i');
  } catch {
    return { kind: 'invalid', reason: 'bad regexp' };
  }

  return {
    kind: 'network',
    raw: line,
    pattern: patternPart,
    regexp,
    isRegex,
    exception,
    ...options,
  };
}

module.exports = { parseFilter, patternToRegExpSource, escapeRegExp, RESOURCE_TYPES };
