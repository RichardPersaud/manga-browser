'use strict';
// Local HTTP server: serves the UI, the MangaDex JSON API routes, an image
// proxy for covers/pages, and the durable backup endpoint. Mirrors the
// AniNinja desktop architecture (no IPC — the sandboxed renderer talks only
// to this same-origin server, which keeps the UI portable).

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');
const md = require('./mangadex');
const VERSION = require('./package.json').version;

// lazy: updater.js imports electron, so a plain `node server` (tests/probes)
// must not load it until an /api/update call actually needs it
let updater = null;
function updaterMod() {
  if (!updater) updater = require('./updater');
  return updater;
}

const UI_DIR = path.join(__dirname, 'ui');
let dataDir = null; // set by start(); null in plain-node tests
const BACKUP_FILE = 'manganinja-data.json';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function b64enc(s) {
  return Buffer.from(s).toString('base64url');
}
function b64dec(s) {
  return Buffer.from(s, 'base64url').toString();
}

// Wrap an absolute image URL so it loads through our /img proxy (UA control,
// and a retry path when the browser itself is blocked).
function proxied(absUrl) {
  return '/img?u=' + b64enc(absUrl);
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

/* ---- durable backup (library / progress / prefs) ----
   Written to <Documents>/MangaNinja/manganinja-data.json so updates and
   reinstalls can't wipe what localStorage in the app's own data dir holds.
   Documents can sit behind OneDrive, whose sync filter can stall file ops
   for a long time — so the dir is resolved once at startup (with a timeout
   and a fallback to the user profile) and every write is async + queued,
   never blocking the request or the main process. */

let backupDir = null; // resolved async at startup
let writeQueue = Promise.resolve(); // serialize writes

async function resolveBackupDir(requested) {
  if (requested) {
    try {
      await Promise.race([
        fsp.mkdir(requested, { recursive: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out (cloud sync stall?)')), 10000)),
      ]);
      // prove it is actually writable before trusting it
      const probe = path.join(requested, '.write-test');
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
      return requested;
    } catch (e) {
      console.warn('[backup] cannot use', requested, '-', e.message);
      console.warn('[backup] falling back to', os.homedir());
    }
  }
  const fallback = path.join(os.homedir(), 'MangaNinja');
  try {
    await fsp.mkdir(fallback, { recursive: true });
    return fallback;
  } catch (e) {
    console.error('[backup] fallback dir also failed:', e.message);
    return null;
  }
}

function initBackup(requestedDir) {
  return resolveBackupDir(requestedDir).then((d) => {
    backupDir = d;
    if (d) console.log('[backup] data dir:', d);
    return d;
  });
}

function backupPath() {
  return backupDir ? path.join(backupDir, BACKUP_FILE) : null;
}

async function readBackup() {
  if (!backupDir) return null;
  try {
    return JSON.parse(await fsp.readFile(backupPath(), 'utf8'));
  } catch {
    return null; // missing or unreadable = no backup yet
  }
}

async function writeBackup(data) {
  const file = backupPath();
  if (!file) return;
  // write-then-rename so a crash mid-write can't leave a truncated file
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

function queueBackupWrite(data) {
  writeQueue = writeQueue
    .then(async () => {
      await backupReadyRef; // dir resolution (bounded by its own timeout)
      await writeBackup(data);
      console.log(`[backup] saved ${backupPath()}`);
    })
    .catch((e) => console.error('[backup] write failed:', e.message));
}

// start() hands the ready promise back so route handlers can await it too
let backupReadyRef = Promise.resolve(null);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('Body too large')); // small blobs, way under
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data: blob:; " +
        "style-src 'self' 'unsafe-inline'",
    });
    res.end(data);
  });
}

// Page/cover images go out over plain http/https with keep-alive off —
// MangaDex's at-home hosts are short-lived CDN sessions; a fresh socket per
// page never stalls (same lesson AniNinja measured for HLS segments).
const freshAgents = {
  'http:': new http.Agent({ keepAlive: false }),
  'https:': new https.Agent({ keepAlive: false }),
};

function openImage(target, headers, ctrl, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('too many redirects'));
    let u;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error('Bad target'));
    }
    const agent = freshAgents[u.protocol];
    if (!agent) return reject(new Error('Bad protocol: ' + u.protocol));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { agent, method: 'GET', headers });
    req.setTimeout(30000, () => req.destroy(new Error('upstream timeout')));
    ctrl.signal.addEventListener('abort', () => {
      const err = new Error('client went away');
      err.name = 'AbortError';
      req.destroy(err);
    }, { once: true });
    req.on('response', (r) => {
      const loc = r.headers.location;
      if (loc && [301, 302, 303, 307, 308].includes(r.statusCode)) {
        r.resume(); // discard the redirect body
        resolve(openImage(new URL(loc, u).href, headers, ctrl, depth + 1));
        return;
      }
      resolve({ status: r.statusCode || 502, headers: r.headers, res: r, url: u.href });
    });
    req.on('error', reject);
    req.end();
  });
}

async function handleImg(req, res, q) {
  const target = b64dec(q.get('u'));
  if (!/^https?:\/\//.test(target) ||
      !/(\.|^\/\/)(uploads\.mangadex\.org|mangadex\.network|mangadex\.org)/.test(target)) {
    res.writeHead(400);
    return res.end('Bad target');
  }
  const headers = { 'User-Agent': 'MangaNinja/0.1.0 (https://github.com/RichardPersaud/MangaNinja)' };
  if (req.headers.range) headers.Range = req.headers.range;

  // abort the upstream request when the client goes away early
  const ctrl = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return; // normal completion — nothing to cancel
    try {
      ctrl.abort();
    } catch {
      // abort() can throw while the request is being torn down; never crash
    }
  });

  let up;
  try {
    up = await openImage(target, headers, ctrl);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return; // client vanished mid-request
    throw e;
  }
  const h = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers[k];
    if (v) h[k] = v;
  }
  h['Access-Control-Allow-Origin'] = '*';
  h['Cache-Control'] = up.status === 200 ? 'max-age=3600' : 'no-store';
  res.writeHead(up.status, h);
  if (up.res) {
    // pipeline cleans up both sides on error/destroy; errors here are routine
    // (reader scrolled past / navigated away) and must never surface as uncaught exceptions
    pipeline(up.res, res, () => {});
  } else {
    res.end();
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const q = url.searchParams;
  const p = url.pathname;

  if (p === '/api/search') {
    const results = await md.searchManga(q.get('q') || '', {
      limit: Math.min(parseInt(q.get('limit') || '24', 10) || 24, 100),
      offset: Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0),
    });
    return sendJson(res, 200, { results });
  }

  if (p === '/api/browse') {
    // alphabetical Browse all with optional first-letter block
    try {
      return sendJson(res, 200, await md.browseAll({
        letter: (q.get('letter') || '').toLowerCase(),
        limit: Math.min(parseInt(q.get('limit') || '36', 10) || 36, 100),
        offset: Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0),
      }));
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/discover') {
    const order = q.get('order') === 'latestUploadedChapter' ? 'latestUploadedChapter' : 'followedCount';
    const results = await md.listManga(order, {
      limit: Math.min(parseInt(q.get('limit') || '24', 10) || 24, 100),
      offset: Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0),
      tag: q.get('tag'),
    });
    return sendJson(res, 200, { results, order });
  }

  let m;
  if ((m = p.match(/^\/api\/manga\/([0-9a-f-]{36})$/i))) {
    try {
      return sendJson(res, 200, { manga: await md.manga(m[1]) });
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if ((m = p.match(/^\/api\/manga\/([0-9a-f-]{36})\/feed$/i))) {
    try {
      const feed = await md.mangaFeed(m[1], {
        lang: q.get('lang') || 'en',
        limit: Math.min(parseInt(q.get('limit') || '500', 10) || 500, 500),
      });
      return sendJson(res, 200, { chapters: feed });
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if ((m = p.match(/^\/api\/manga\/([0-9a-f-]{36})\/chapters-count$/i))) {
    try {
      return sendJson(res, 200, { count: await md.chapterCount(m[1]) });
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/api/latest') {
    try {
      const chapters = await md.latestChapters({ limit: Math.min(parseInt(q.get('limit') || '30', 10) || 30, 60) });
      return sendJson(res, 200, { chapters });
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if ((m = p.match(/^\/api\/athome\/([0-9a-f-]{36})$/i))) {
    try {
      const home = await md.atHome(m[1]);
      return sendJson(res, 200, home);
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }

  if (p === '/img') {
    return handleImg(req, res, q);
  }

  if (p === '/api/backup') {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        // respond immediately; the actual write is queued and async
        queueBackupWrite({
          prefs: body.prefs && typeof body.prefs === 'object' ? body.prefs : {},
          library: body.library && typeof body.library === 'object' ? body.library : {},
          progress: body.progress && typeof body.progress === 'object' ? body.progress : {},
          read: body.read && typeof body.read === 'object' ? body.read : {},
          history: body.history && typeof body.history === 'object' ? body.history : {},
          savedAt: new Date().toISOString(),
        });
        return sendJson(res, 200, { ok: true });
      }
      await backupReadyRef; // bounded by resolveBackupDir's timeout
      return sendJson(res, 200, { data: await readBackup(), dir: backupDir });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/version') {
    await backupReadyRef;
    return sendJson(res, 200, { version: VERSION, backupDir });
  }

  if (p === '/api/update') {
    const { updaterStatus, updaterAction } = updaterMod();
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let action = '';
      try { action = JSON.parse(body).action || ''; } catch { /* invalid body */ }
      try {
        return sendJson(res, 200, await updaterAction(action));
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e), status: updaterStatus() });
      }
    }
    return sendJson(res, 200, updaterStatus());
  }

  if (p === '/api/proxied') {
    // helper for the UI: turn any remote image URL into a /img proxy URL
    return sendJson(res, 200, { url: proxied(q.get('u') || '') });
  }

  return serveStatic(req, res, p);
}

function start({ dataDir: dir } = {}) {
  dataDir = dir || null;
  if (dataDir) backupReadyRef = initBackup(dataDir);
  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error('[server] route error:', e.message || e);
      if (!res.headersSent) sendJson(res, 502, { error: String(e.message || e) });
      else try { res.end(); } catch { /* already gone */ }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log('[server] listening on 127.0.0.1:' + port);
      resolve({ port, server });
    });
  });
}

module.exports = { start, route, proxied };

// allow `node server.js` for manual probing (no backup dir in plain-node mode)
if (require.main === module) {
  start({ dataDir: path.join(os.homedir(), 'MangaNinja') }).then(({ server }) => {
    process.on('SIGINT', () => server.close(() => process.exit(0)));
  });
}