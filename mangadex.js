'use strict';
// MangaDex API client (https://api.mangadex.org). Read-only, no auth.
//
// Verified against the official docs:
// - ~5 req/s per IP on the API; /at-home/server/{id} is capped at 40 req/min
// - a real (non-spoofed) User-Agent is mandatory; 429 = back off, 403 = banned
// - at-home baseUrl embeds a ~15-min access token: cache resolved page URLs
//   briefly (10 min here) and never send auth headers at *.mangadex.network /
//   uploads.mangadex.org
// - page filenames are opaque server-side digests: use the data[]/dataSaver[]
//   entries verbatim, page order = array order (never sort by filename)
// - covers are permanent/static: uploads.mangadex.org/covers/{mangaId}/{file}

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const UA = 'MangaNinja/0.1.0 (https://github.com/RichardPersaud/MangaNinja)';
const TIMEOUT = 20000;

// ---------- tiny TTL cache ----------
const caches = new Map(); // name -> Map(key -> {t, v})
function cacheGet(name, key, ttl) {
  const m = caches.get(name);
  if (!m) return undefined;
  const hit = m.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t > ttl) { m.delete(key); return undefined; }
  return hit.v;
}
function cachePut(name, key, v) {
  let m = caches.get(name);
  if (!m) { m = new Map(); caches.set(name, m); }
  m.set(key, { t: Date.now(), v });
  // keep caches bounded
  if (m.size > 300) {
    const oldest = [...m.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 100);
    for (const [k] of oldest) m.delete(k);
  }
}

// ---------- rate-limit friendly fetch ----------
let lastCall = 0;          // min 250ms between API calls (~4 req/s)
let lastAtHome = 0;        // min 1.7s between at-home calls (well under 40/min)
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function gate(kind) {
  const now = Date.now();
  const minGap = kind === 'athome' ? 1700 : 250;
  const prev = kind === 'athome' ? lastAtHome : lastCall;
  const wait = prev + minGap - now;
  if (wait > 0) await sleep(wait);
  if (kind === 'athome') lastAtHome = Date.now(); else lastCall = Date.now();
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// query string builder: array values become repeated keys
// (includes[]=cover_art&includes[]=author — URLSearchParams would comma-join them)
function queryOf(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) { for (const item of v) sp.append(k, item); }
    else sp.append(k, String(v));
  }
  return sp.toString();
}

// single request with 429/5xx retry (2 attempts, capped backoff)
async function req(pathname, params, opts = {}) {
  const qs = params ? '?' + queryOf(params) : '';
  const url = `${API}${pathname}${qs}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    await gate(opts.athome ? 'athome' : 'api');
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (e) {
      lastErr = new ApiError(`MangaDex unreachable: ${e.message || e}`, 0);
      continue; // network blip -> retry
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ApiError(`MangaDex HTTP ${res.status}`, res.status);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      // 4xx other than 429: give up, surface the body's error detail if present
      let detail = `MangaDex HTTP ${res.status}`;
      try {
        const body = await res.json();
        const d = body && body.errors && body.errors[0] && body.errors[0].detail;
        if (d) detail = d;
      } catch { /* not JSON */ }
      throw new ApiError(detail, res.status);
    }
    return res.json();
  }
  throw lastErr || new ApiError('MangaDex request failed', 0);
}

// ---------- entity helpers ----------
function relsOf(entity) {
  return (entity && entity.relationships) || [];
}
function firstRel(entity, type) {
  return relsOf(entity).find((r) => r.type === type) || null;
}

// localized title: en, then first available, then altTitles' en
function titleOf(manga) {
  const a = (manga && manga.attributes) || {};
  const t = a.title || {};
  if (t.en) return t.en;
  const any = Object.values(t).find(Boolean);
  if (any) return any;
  const alt = (a.altTitles || []).map((o) => o.en || Object.values(o).find(Boolean)).find(Boolean);
  return alt || 'Untitled';
}

// cover art: prefer the cover_art relationship, fall back to attributes.mainCover
function coverFileOf(manga) {
  const rel = firstRel(manga, 'cover_art');
  if (rel && rel.attributes && rel.attributes.fileName) return rel.attributes.fileName;
  const a = (manga && manga.attributes) || {};
  return a.mainCover || null;
}

function coverUrl(mangaId, coverFile, size) {
  if (!mangaId || !coverFile) return null;
  if (size === '512' || size === '256') {
    // thumbnails KEEP the original extension and append the size:
    // {uuid}.{orig-ext}.{size}.jpg  (verified live; stripping the ext 404s)
    return `${UPLOADS}/covers/${mangaId}/${coverFile}.${size}.jpg`;
  }
  return `${UPLOADS}/covers/${mangaId}/${coverFile}`;
}

// normalize a manga entity into what the UI needs
function slimManga(manga) {
  const a = (manga && manga.attributes) || {};
  const coverFile = coverFileOf(manga);
  const author = firstRel(manga, 'author');
  const artist = firstRel(manga, 'artist');
  return {
    id: manga.id,
    title: titleOf(manga),
    cover: coverUrl(manga.id, coverFile, '256'),
    coverFull: coverUrl(manga.id, coverFile),
    description: (a.description && (a.description.en || Object.values(a.description).find(Boolean))) || '',
    status: a.status || '',
    year: a.year || null,
    tags: (a.tags || []).map((t) => t.attributes && t.attributes.name && (t.attributes.name.en || Object.values(t.attributes.name)[0])).filter(Boolean).slice(0, 8),
    author: (author && author.attributes && author.attributes.name) || null,
    artist: (artist && artist.attributes && artist.attributes.name) || null,
    lastChapter: a.lastChapter || null,
    latestUploadedAt: a.latestUploadedAt || null,
  };
}

// normalize a chapter entity into what the UI needs
function slimChapter(ch) {
  const a = (ch && ch.attributes) || {};
  const group = firstRel(ch, 'scanlation_group');
  return {
    id: ch.id,
    chapter: a.chapter == null ? null : String(a.chapter),
    title: a.title || '',
    pages: a.pages || 0,
    externalUrl: a.externalUrl || null,
    publishAt: a.publishAt,
    readableAt: a.readableAt,
    isUnavailable: !!a.isUnavailable,
    lang: a.translatedLanguage,
    group: (group && group.attributes && group.attributes.name) || null,
  };
}

function pick(obj, lang) {
  if (!obj) return null;
  return obj[lang] || obj.en || null;
}

// ---------- public API ----------
async function searchManga(q, { limit = 24, offset = 0 } = {}) {
  const key = `s:${q}:${limit}:${offset}`;
  const cached = cacheGet('search', key, 10 * 60 * 1000);
  if (cached) return cached;
  const j = await req('/manga', {
    title: q,
    limit: String(limit),
    offset: String(offset),
    'includes[]': ['cover_art', 'author', 'artist'],
    'contentRating[]': ['safe', 'suggestive'],
    hasAvailableChapters: 'true',
    'availableTranslatedLanguage[]': ['en'],
  });
  const out = (j.data || []).map(slimManga);
  cachePut('search', key, out);
  return out;
}

async function listManga(order, { limit = 24, offset = 0 } = {}) {
  const key = `l:${order}:${limit}:${offset}`;
  const cached = cacheGet('list', key, 8 * 60 * 1000);
  if (cached) return cached;
  const j = await req('/manga', {
    limit: String(limit),
    offset: String(offset),
    'includes[]': ['cover_art', 'author', 'artist'],
    'contentRating[]': ['safe', 'suggestive'],
    hasAvailableChapters: 'true',
    'availableTranslatedLanguage[]': ['en'],
    [`order[${order}]`]: 'desc',
  });
  const out = (j.data || []).map(slimManga);
  cachePut('list', key, out);
  return out;
}

async function manga(id) {
  const cached = cacheGet('manga', id, 15 * 60 * 1000);
  if (cached) return cached;
  const j = await req(`/manga/${id}`, {
    'includes[]': ['cover_art', 'author', 'artist'],
  });
  const out = slimManga(j.data);
  cachePut('manga', id, out);
  return out;
}

// chapter list for one manga; newest first
async function mangaFeed(id, { lang = 'en', limit = 500, offset = 0 } = {}) {
  const key = `f:${id}:${lang}:${limit}:${offset}`;
  const cached = cacheGet('feed', key, 4 * 60 * 1000);
  if (cached) return cached;
  const j = await req(`/manga/${id}/feed`, {
    'translatedLanguage[]': [lang],
    limit: String(limit),
    offset: String(offset),
    'includes[]': ['scanlation_group'],
    'order[publishAt]': 'desc',
    'contentRating[]': ['safe', 'suggestive', 'erotica'],
  });
  const out = (j.data || []).map(slimChapter);
  cachePut('feed', key, out);
  return out;
}

// global latest-updates feed: chapters across all manga, newest first.
// The tip of the feed is flooded with official-publisher chapters (externalUrl,
// pages=0 — sometimes hundreds, some scheduled with far-future publishAt), so
// walk pages of 100 until `limit` readable chapters are gathered.
async function latestChapters({ limit = 30, maxPages = 6 } = {}) {
  const key = `g:${limit}`;
  const cached = cacheGet('global', key, 2 * 60 * 1000);
  if (cached) return cached;
  const out = [];
  for (let page = 0; page < maxPages && out.length < limit; page++) {
    const j = await req('/chapter', {
      limit: '100',
      offset: String(page * 100),
      'translatedLanguage[]': ['en'],
      'includes[]': ['manga', 'scanlation_group'],
      'order[publishAt]': 'desc',
      'contentRating[]': ['safe', 'suggestive', 'erotica'],
    });
    const batch = j.data || [];
    if (!batch.length) break;
    for (const ch of batch) {
      const a = ch.attributes || {};
      if (a.isUnavailable || !a.pages || a.externalUrl) continue;
      const m = firstRel(ch, 'manga');
      if (!m) continue;
      const c = slimChapter(ch);
      c.mangaId = m.id;
      c.mangaTitle = titleOf(m);
      c.cover = coverUrl(m.id, coverFileOf(m), '256');
      out.push(c);
      if (out.length >= limit) break;
    }
    if (batch.length < 100) break;
  }
  cachePut('global', key, out);
  return out;
}

// at-home server info for a chapter (the only way to get page URLs)
async function atHome(chapterId) {
  const cached = cacheGet('athome', chapterId, 10 * 60 * 1000);
  if (cached) return cached;
  const j = await req(`/at-home/server/${chapterId}`, null, { athome: true });
  if (!j || !j.baseUrl || !j.chapter) {
    throw new ApiError('At-home returned no server for this chapter', 404);
  }
  const { baseUrl, chapter } = j;
  const quality = chapter.dataSaver && chapter.dataSaver.length ? 'data-saver' : 'data';
  const out = {
    hash: chapter.hash,
    quality,
    dataSaver: !!(chapter.dataSaver && chapter.dataSaver.length),
    pages: (chapter.data || []).map((f) => `${baseUrl}/data/${chapter.hash}/${f}`),
    pagesSaver: (chapter.dataSaver || []).map((f) => `${baseUrl}/data-saver/${chapter.hash}/${f}`),
  };
  cachePut('athome', chapterId, out);
  return out;
}

module.exports = {
  ApiError,
  searchManga,
  listManga,
  manga,
  mangaFeed,
  latestChapters,
  atHome,
  titleOf,
  coverUrl,
  coverFileOf,
  pick,
};