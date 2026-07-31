'use strict';

/**
 * Video search.
 *
 * Deliberately key-free: the browser should not ship an API key, and the
 * user should not have to get one. Results come from public JSON front-ends
 * (Piped and Invidious) with a plain YouTube-results scrape as the last
 * resort. Instances go down constantly, so every provider is tried in turn
 * and the first usable answer wins.
 */

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.leptons.xyz',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.f5.si',
];

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

class VideoSearch {
  /** @param {(url: string, init?: object) => Promise<Response>} [fetchImpl] */
  constructor(fetchImpl) {
    this.fetch = fetchImpl || globalThis.fetch;
    /** @type {Map<string, {at: number, results: object[]}>} */
    this.cache = new Map();
  }

  async _get(url, { json = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: controller.signal,
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Search across providers.
   * @param {string} query
   * @param {{limit?: number, refresh?: boolean}} [opts]
   * @returns {Promise<{results: object[], provider: string, errors: string[]}>}
   */
  async search(query, { limit = 40, refresh = false } = {}) {
    const term = String(query || '').trim();
    if (!term) return { results: [], provider: 'none', errors: [] };

    const key = `${term}:${limit}`;
    const cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { results: cached.results, provider: cached.provider, errors: [], cached: true };
    }

    const errors = [];
    const providers = [
      ...PIPED_INSTANCES.map((base) => ({ name: `piped:${host(base)}`, run: () => this._piped(base, term) })),
      ...INVIDIOUS_INSTANCES.map((base) => ({ name: `invidious:${host(base)}`, run: () => this._invidious(base, term) })),
      { name: 'youtube', run: () => this._youtube(term) },
    ];

    for (const provider of providers) {
      try {
        const results = await provider.run();
        if (results && results.length) {
          const trimmed = results.slice(0, limit);
          this.cache.set(key, { at: Date.now(), results: trimmed, provider: provider.name });
          if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
          return { results: trimmed, provider: provider.name, errors };
        }
        errors.push(`${provider.name}: empty`);
      } catch (err) {
        errors.push(`${provider.name}: ${err.message || err}`);
      }
    }

    return { results: [], provider: 'none', errors };
  }

  async _piped(base, query) {
    const data = await this._get(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`);
    const items = data.items || [];
    return items
      .filter((item) => item.type === 'stream' || item.url?.includes('/watch'))
      .map((item) => normalize({
        id: idFromUrl(item.url),
        title: item.title,
        author: item.uploaderName,
        authorUrl: item.uploaderUrl ? `https://www.youtube.com${item.uploaderUrl}` : null,
        duration: item.duration,
        views: item.views,
        published: item.uploadedDate || item.uploaded,
        thumbnail: item.thumbnail,
        description: item.shortDescription,
        live: Boolean(item.isShort === false && item.duration < 0),
      }));
  }

  async _invidious(base, query) {
    const data = await this._get(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`);
    if (!Array.isArray(data)) throw new Error('unexpected response shape');
    return data.map((item) => normalize({
      id: item.videoId,
      title: item.title,
      author: item.author,
      authorUrl: item.authorUrl ? `https://www.youtube.com${item.authorUrl}` : null,
      duration: item.lengthSeconds,
      views: item.viewCount,
      published: item.publishedText,
      thumbnail: bestThumbnail(item.videoThumbnails) || thumbFor(item.videoId),
      description: item.description,
      live: Boolean(item.liveNow),
    }));
  }

  /**
   * Last resort: pull the JSON blob YouTube embeds in its results page.
   * Fragile by nature, which is exactly why it runs last.
   */
  async _youtube(query) {
    const html = await this._get(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      { json: false },
    );

    const marker = 'var ytInitialData = ';
    const start = html.indexOf(marker);
    if (start === -1) throw new Error('no ytInitialData');
    const end = html.indexOf('};', start);
    if (end === -1) throw new Error('truncated ytInitialData');

    const data = JSON.parse(html.slice(start + marker.length, end + 1));
    const sections = data?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents || [];

    const out = [];
    for (const section of sections) {
      for (const item of section?.itemSectionRenderer?.contents || []) {
        const video = item.videoRenderer;
        if (!video) continue;
        out.push(normalize({
          id: video.videoId,
          title: text(video.title),
          author: text(video.ownerText),
          duration: parseDuration(text(video.lengthText)),
          views: parseViews(text(video.viewCountText)),
          published: text(video.publishedTimeText),
          thumbnail: video.thumbnail?.thumbnails?.slice(-1)[0]?.url || thumbFor(video.videoId),
          description: text(video.detailedMetadataSnippets?.[0]?.snippetText),
          live: Boolean(video.badges?.some((b) => /LIVE/i.test(JSON.stringify(b)))),
        }));
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ helpers

function host(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function idFromUrl(url) {
  if (!url) return null;
  const match = /[?&]v=([\w-]{6,})/.exec(url);
  return match ? match[1] : null;
}

function thumbFor(id) {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function bestThumbnail(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}

function text(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join('');
  return '';
}

function parseDuration(label) {
  if (!label) return 0;
  const parts = label.split(':').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseViews(label) {
  if (!label) return 0;
  const digits = label.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : 0;
}

/** Shape every provider's item into one record the UI can render. */
function normalize(item) {
  const id = item.id;
  return {
    id,
    title: item.title || 'Untitled',
    author: item.author || '',
    authorUrl: item.authorUrl || null,
    duration: Number(item.duration) > 0 ? Number(item.duration) : 0,
    durationLabel: formatDuration(Number(item.duration) || 0),
    views: Number(item.views) || 0,
    viewsLabel: formatCount(Number(item.views) || 0),
    published: item.published || '',
    thumbnail: item.thumbnail || thumbFor(id),
    description: (item.description || '').slice(0, 300),
    live: Boolean(item.live),
    url: id ? `https://www.youtube.com/watch?v=${id}` : null,
    // nocookie + no related videos keeps the theater view from turning into
    // another recommendation feed.
    embedUrl: id
      ? `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1`
      : null,
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return 'LIVE';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatCount(n) {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K views`;
  return `${n} views`;
}

module.exports = { VideoSearch, formatDuration, formatCount, normalize };
