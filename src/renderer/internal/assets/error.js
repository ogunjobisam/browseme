import { api, h, $ } from './ui.js';

/**
 * Network error page.
 *
 * Chromium's numeric error codes are useless to most people, so each one is
 * translated into a plain description plus the checks that actually help.
 */

const ERRORS = {
  '-2': ['Something went wrong', 'The connection failed for an unspecified reason.'],
  '-6': ['File not found', 'That file does not exist on this computer.'],
  '-7': ['The site took too long', 'The server accepted the connection but never replied.'],
  '-15': ['Too many redirects', 'The site kept redirecting and never landed anywhere.'],
  '-21': ['You appear to be offline', 'No network connection was available.'],
  '-100': ['The connection was closed', 'The server hung up before sending a response.'],
  '-102': ['Connection refused', 'Nothing is listening at that address and port.'],
  '-105': ["That address doesn't exist", 'The domain name could not be resolved.'],
  '-106': ['You appear to be offline', 'No network connection was available.'],
  '-109': ['The site is unreachable', 'The route to that server failed.'],
  '-118': ['The connection timed out', 'The server did not respond in time.'],
  '-137': ["That address doesn't exist", 'The domain name could not be resolved.'],
  '-200': ['The certificate is not valid', "The site's identity could not be verified, so the page was not loaded."],
  '-201': ['The certificate has expired', 'The site is using an out-of-date certificate.'],
  '-202': ['The certificate is not trusted', 'It was issued by an authority this browser does not recognise.'],
};

const SUGGESTIONS = {
  dns: ['Check the address for a typo', 'Try the site without the www prefix', 'Check whether your DNS server is reachable'],
  offline: ['Check your Wi-Fi or cable', 'Check whether other sites load', 'Try again in a moment'],
  cert: ['Do not enter passwords or payment details on this site', 'Check that your system clock is correct', 'Contact the site owner if it is yours'],
  generic: ['Reload the page', 'Check the address for a typo', 'Try again in a moment'],
};

function suggestionsFor(code) {
  if (['-105', '-137'].includes(code)) return SUGGESTIONS.dns;
  if (['-21', '-106'].includes(code)) return SUGGESTIONS.offline;
  if (Number(code) <= -200 && Number(code) > -300) return SUGGESTIONS.cert;
  return SUGGESTIONS.generic;
}

const params = new URL(location.href).searchParams;
const url = params.get('url') || '';
const code = params.get('code') || '';
const description = params.get('description') || '';

const [headline, detail] = ERRORS[code] || ['This page didn\'t load', description || 'The request failed.'];

$('#headline').textContent = headline;
$('#detail').textContent = detail;
$('#target').textContent = url;

for (const suggestion of suggestionsFor(code)) {
  $('#suggestions').append(h('li', { text: suggestion }));
}

$('#retry').addEventListener('click', () => {
  if (url) api.invoke('tabs:navigate', { input: url });
});

$('#back').addEventListener('click', () => history.back());
