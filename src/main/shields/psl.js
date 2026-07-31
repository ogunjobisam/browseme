'use strict';

/**
 * Minimal public-suffix handling.
 *
 * A full public suffix list is ~15k entries and mostly irrelevant for
 * third-party detection: what matters is that `a.example.co.uk` and
 * `b.example.co.uk` are recognised as the same site. We ship the multi-label
 * suffixes that actually show up in browsing and treat everything else as a
 * single trailing label.
 */

const MULTI_LABEL_SUFFIXES = new Set([
  // country second-level registries
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za', 'web.za',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'edu.ar',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'ad.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 're.kr', 'pe.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in',
  'com.pk', 'com.bd', 'com.np', 'com.lk',
  'com.ng', 'org.ng', 'net.ng', 'gov.ng', 'edu.ng',
  'co.ke', 'or.ke', 'go.ke', 'ac.ke',
  'com.gh', 'com.eg', 'com.sa', 'com.tr', 'gov.tr', 'edu.tr',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua',
  'com.ru', 'net.ru', 'org.ru', 'edu.ru', 'gov.ru',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.es', 'org.es', 'gob.es', 'edu.es',
  'com.pt', 'gov.pt', 'edu.pt',
  'com.it', 'gov.it', 'edu.it',
  'co.id', 'or.id', 'go.id', 'ac.id', 'web.id',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'com.ve', 'com.ec', 'com.uy', 'com.py', 'com.bo',
  'co.th', 'in.th', 'go.th', 'ac.th',
  // widely used hosting suffixes where subdomains are separate sites
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app',
  'herokuapp.com', 'appspot.com', 'cloudfront.net', 's3.amazonaws.com',
  'blogspot.com', 'wordpress.com', 'tumblr.com', 'firebaseapp.com', 'web.app',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Return the registrable domain ("eTLD+1") for a hostname.
 * Falls back to the input for IPs, single-label hosts, and anything unparseable.
 */
function registrableDomain(hostname) {
  if (!hostname) return '';
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (IPV4.test(host) || host.includes(':')) return host;

  const parts = host.split('.');
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** True when `url`'s site differs from the document's site. */
function isThirdParty(requestHostname, documentHostname) {
  if (!documentHostname) return false;
  return registrableDomain(requestHostname) !== registrableDomain(documentHostname);
}

/**
 * Yield a hostname and each of its parent domains, most specific first.
 * `a.b.example.com` -> a.b.example.com, b.example.com, example.com, com
 */
function hostnameVariants(hostname) {
  const out = [];
  if (!hostname) return out;
  const parts = String(hostname).toLowerCase().split('.');
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}

module.exports = { registrableDomain, isThirdParty, hostnameVariants };
