'use strict';
/* MangaNinja UI — vanilla JS SPA over the local server. Same-origin /api/*
   calls only; images go straight to MangaDex with an onerror retry through
   the /img proxy (some environments block direct hotlinking). */

// ---------- storage ----------
const KEYS = ['mr_library', 'mr_progress', 'mr_read', 'mr_prefs', 'mr_history'];
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; }
  catch { return {}; }
}
function save(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* quota */ }
  scheduleBackup();
}
let library = load('mr_library');   // {id: {title, cover, ts, seenAt}}
let progress = load('mr_progress'); // {mangaId: {chapterId, chapter, page, ts}}
let readMap = load('mr_read');      // {mangaId: {chapterId: ts}}
let prefs = Object.assign({ quality: 'data-saver' }, load('mr_prefs'));
let viewedHistory = load('mr_history'); // {id: {title, cover, seenAt}} — incl. non-library titles

// ---------- durable backup (mirrors AniNinja's debounced design) ----------
let backupTimer = null;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(sendBackup, 1500);
}
function backupPayload() {
  return {
    prefs, library, progress, read: readMap, history: viewedHistory,
  };
}
function sendBackup() {
  fetch('/api/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backupPayload()),
  }).catch(() => {});
}
window.addEventListener('beforeunload', () => {
  // last-chance sync: keepAlive beacon survives navigation
  const blob = new Blob([JSON.stringify(backupPayload())], { type: 'application/json' });
  navigator.sendBeacon('/api/backup', blob);
});

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) return 'just now';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 7 * 86400 * 1000) return Math.floor(diff / 86400000) + 'd ago';
  return d.toISOString().slice(0, 10);
}
// MangaDex hosts replace hotlinked images with a placeholder (a valid 200, so
// onerror never fires) — route every MangaDex image through our /img proxy;
// the server sends the proper User-Agent
function proxiedUrl(src) {
  if (!/mangadex\.(org|network)/.test(src)) return src;
  // base64url-safe encoding (plain base64's + and / would corrupt the query)
  const b64 = btoa(unescape(encodeURIComponent(src))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return '/img?u=' + b64;
}
function img(src, alt, lazy = true, className = '') {
  if (!src) return '';
  const el = new Image();
  if (lazy) el.loading = 'lazy';
  el.alt = alt || '';
  if (className) el.className = className;
  el.src = proxiedUrl(src);
  return el;
}

async function api(path) {
  const res = await fetch(path, { signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ---------- breadcrumbs ----------
// trail of where the user is; refreshed by every list view so a detail page
// can show how you got there (Discover › Action › Some Manga)
let lastCrumbs = [{ label: 'Discover', hash: '#/discover' }];
function renderCrumbs(trail) {
  if (!trail || trail.length < 2) return;
  const bar = document.createElement('nav');
  bar.className = 'crumbs';
  trail.forEach((c, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      bar.appendChild(sep);
    }
    if (i < trail.length - 1 && c.hash) {
      const a = document.createElement('a');
      a.href = c.hash;
      a.textContent = c.label;
      bar.appendChild(a);
    } else {
      const s = document.createElement('span');
      s.className = 'here';
      s.textContent = c.label;
      bar.appendChild(s);
    }
  });
  view.prepend(bar);
}

// ---------- routing ----------
const routes = {
  library: renderLibrary,
  discover: renderDiscover,
  latest: renderLatest,
  manga: renderManga,
  tag: renderTag,
  search: renderSearch,
};

// browse everything in one category (tag)
async function renderTag(tagId, encodedName) {
  const name = decodeURIComponent(encodedName || 'Category').replace(/</g, '&lt;');
  view.innerHTML = `<h1>${name}</h1><div class="spin"></div>`;
  const { results } = await api(`/api/discover?order=followedCount&tag=${encodeURIComponent(tagId)}&limit=36`);
  view.querySelectorAll('.spin').forEach((el) => el.remove());
  if (!results.length) { view.innerHTML += '<div class="empty">Nothing found in this category.</div>'; renderCrumbs(lastCrumbs); return; }
  view.appendChild(grid(results));
  renderCrumbs(lastCrumbs);
}
function nav(to) { location.hash = to; }
window.addEventListener('hashchange', render);
function parseHash() {
  const h = location.hash.replace(/^#\//, '');
  const [name, a, b] = h.split('/');
  return { name: name || 'discover', a, b };
}

async function render() {
  if (!$('#reader').hidden) return; // reader overlay owns the screen
  const { name, a, b } = parseHash();
  for (const btn of document.querySelectorAll('#nav button')) {
    btn.classList.toggle('active', btn.dataset.nav === name);
  }
  $('#searchform').style.display = name === 'library' ? 'none' : '';
  // remember the trail so detail pages can breadcrumb back to their source
  if (name === 'latest') lastCrumbs = [{ label: 'Latest', hash: '#/latest' }];
  else if (name === 'library') lastCrumbs = [{ label: 'Library', hash: '#/library' }];
  else if (name === 'tag' && a) {
    const tn = decodeURIComponent(b || 'Category');
    lastCrumbs = [{ label: 'Discover', hash: '#/discover' }, { label: tn, hash: `#/tag/${a}/${b}` }];
  } else if (name === 'search' && a) {
    lastCrumbs = [{ label: 'Discover', hash: '#/discover' }, { label: `Search: “${decodeURIComponent(a)}”`, hash: `#/search/${a}` }];
  } else if (name === 'discover') lastCrumbs = [{ label: 'Discover', hash: '#/discover' }];
  try {
    if (name === 'manga' && a) await routes.manga(a);
    else if (name === 'tag' && a) await routes.tag(a, b);
    else if (name === 'search' && a) await routes.search(decodeURIComponent(a));
    else if (routes[name]) await routes[name]();
    else await routes.discover();
  } catch (e) {
    view.innerHTML = `<div class="error">Failed to load: ${e.message || e}</div>`;
  }
}

// ---------- shared renderers ----------
function mangaCard(m, extra) {
  const card = document.createElement('div');
  card.className = 'card';
  card.onclick = () => nav(`/manga/${m.id}`);
  card.appendChild(img(m.cover, m.title, true, 'cover'));
  // quick +/✓ in the top corner: add to library without opening the detail page
  const quick = document.createElement('button');
  quick.type = 'button';
  quick.className = 'quick-add' + (library[m.id] && library[m.id].inLib ? ' inlib' : '');
  quick.textContent = library[m.id] && library[m.id].inLib ? '✓' : '+';
  quick.title = quick.textContent === '✓' ? 'In library — click to remove' : 'Add to library';
  quick.onclick = (e) => {
    e.stopPropagation(); // don't open the detail page
    const wasIn = library[m.id] && library[m.id].inLib;
    if (wasIn) {
      delete library[m.id].inLib;
      toast('Removed from library');
    } else {
      library[m.id] = library[m.id] || { title: m.title, cover: m.cover };
      library[m.id].inLib = true;
      library[m.id].ts = Date.now();
      toast('Added to library');
    }
    const isIn = library[m.id] && library[m.id].inLib;
    quick.textContent = isIn ? '✓' : '+';
    quick.classList.toggle('inlib', !!isIn);
    quick.title = isIn ? 'In library — click to remove' : 'Add to library';
    save('mr_library', library);
  };
  card.appendChild(quick);
  const meta = document.createElement('div');
  meta.className = 'meta';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = m.title;
  meta.appendChild(t);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = extra || m.status || '';
  meta.appendChild(sub);
  card.appendChild(meta);
  return card;
}
function grid(items, mkExtra) {
  const g = document.createElement('div');
  g.className = 'grid';
  for (const it of items) g.appendChild(mangaCard(it, mkExtra && mkExtra(it)));
  return g;
}

// ---------- Library ----------
async function renderLibrary() {
  document.title = 'MangaNinja — Library';
  const ids = Object.entries(library).sort((x, y) => (y[1].ts || 0) - (x[1].ts || 0));
  const recents = Object.entries(viewedHistory)
    .sort((x, y) => (y[1].seenAt || 0) - (x[1].seenAt || 0))
    .slice(0, 20);
  if (!ids.length && !recents.length) {
    view.innerHTML = `<h1>Library</h1><div class="empty">Nothing saved yet — find something in Discover and hit “+ Library”.</div>`;
    return;
  }
  view.innerHTML = ids.length
    ? `<h1>Library <span class="sub" style="font-size:13px;color:var(--dim)">${ids.length} titles</span></h1>`
    : `<h1>Library</h1><div class="empty">Nothing saved yet — find something in Discover and hit “+ Library”.</div>`;

  // recently viewed: side-scrolling strip above the saved grid
  if (recents.length) {
    const sec = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = 'Recently viewed';
    sec.appendChild(h);
    const row = document.createElement('div');
    row.className = 'hrow';
    for (const [id, e] of recents) {
      const hc = document.createElement('div');
      hc.className = 'hcard';
      hc.onclick = () => nav(`/manga/${id}`);
      hc.appendChild(img(e.cover, e.title, true, 'cover'));
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'remove';
      rm.textContent = '✕';
      rm.title = 'Remove from recently viewed';
      rm.onclick = (ev) => {
        ev.stopPropagation();
        delete viewedHistory[id];
        save('mr_history', viewedHistory);
        render();
      };
      hc.appendChild(rm);
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = e.title;
      t.title = e.title;
      hc.appendChild(t);
      row.appendChild(hc);
    }
    sec.appendChild(row);
    view.prepend(sec);
  }
  const g = document.createElement('div');
  g.className = 'grid';
  for (const [id, entry] of ids) {
    if (!entry.inLib) continue; // entries only exist for explicitly-added manga
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => nav(`/manga/${id}`);
    card.appendChild(img(entry.cover, entry.title, true, 'cover'));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = entry.title;
    meta.appendChild(t);
    // new-chapter badge: the catalog told us when the latest upload landed
    if (entry.latestAt && entry.seenAt && entry.latestAt > entry.seenAt) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'NEW';
      t.appendChild(b);
    }
    const sub = document.createElement('div');
    sub.className = 'sub';
    const pr = progress[id];
    sub.textContent = pr ? `Resume ch ${pr.chapter || '?'}` : (entry.status || '');
    meta.appendChild(sub);
    card.appendChild(meta);
    g.appendChild(card);
  }
  view.appendChild(g);
}

// ---------- Discover ----------
let discoverTab = 'popular';
async function renderDiscover() {
  const q = new URLSearchParams((location.hash.split('?')[1] || ''));
  discoverTab = q.get('tab') === 'latest' ? 'latest' : discoverTab;
  const order = discoverTab === 'latest' ? 'latestUploadedChapter' : 'followedCount';
  view.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">
      <h1 style="margin:0">Discover</h1>
      <button id="tab-popular">Popular</button>
      <button id="tab-latest">Latest updates</button>
    </div>
    <div class="spin"></div>`;
  const pop = $('#tab-popular'), lat = $('#tab-latest');
  pop.classList.toggle('active', discoverTab === 'popular');
  lat.classList.toggle('active', discoverTab === 'latest');
  pop.onclick = () => { discoverTab = 'popular'; nav('/discover?tab=popular'); render(); };
  lat.onclick = () => { discoverTab = 'latest'; nav('/discover?tab=latest'); render(); };
  const { results } = await api(`/api/discover?order=${order}&limit=36`);
  view.querySelectorAll('.spin').forEach((el) => el.remove());
  const g = grid(results, (m) => discoverTab === 'latest' && m.latestUploadedAt ? fmtWhen(m.latestUploadedAt) : '');
  view.appendChild(g);
}

// search (a real hash route, so Back works and the breadcrumb is clickable)
async function renderSearch(qv) {
  document.title = `MangaNinja — Search: ${qv}`;
  view.innerHTML = `<h1>Search: “${qv.replace(/</g, '&lt;')}”</h1><div class="spin"></div>`;
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(qv)}&limit=36`);
    view.querySelectorAll('.spin').forEach((el) => el.remove());
    if (!results.length) { view.innerHTML += '<div class="empty">No results.</div>'; renderCrumbs(lastCrumbs); return; }
    const g = document.createElement('div');
    g.className = 'grid';
    for (const m of results) g.appendChild(mangaCard(m));
    view.appendChild(g);
  } catch (err) {
    view.querySelectorAll('.spin').forEach((el) => el.remove());
    view.innerHTML += `<div class="error">${err.message || err}</div>`;
  }
  renderCrumbs(lastCrumbs);
}
$('#searchform').onsubmit = (e) => {
  e.preventDefault();
  const qv = $('#searchbox').value.trim();
  if (!qv) return;
  nav(`/search/${encodeURIComponent(qv)}`);
};

// ---------- Latest ----------
async function renderLatest() {
  view.innerHTML = `<h1>Latest chapters</h1><div class="spin"></div>`;
  const { chapters } = await api('/api/latest?limit=40');
  view.querySelectorAll('.spin').forEach((el) => el.remove());
  if (!chapters.length) { view.innerHTML += '<div class="empty">Nothing readable right now.</div>'; return; }
  const list = document.createElement('div');
  list.className = 'chapters';
  const lastSeen = Number(localStorage.getItem('mr_lastseen')) || 0;
  for (const c of chapters) {
    const row = document.createElement('div');
    row.className = 'chrow';
    row.onclick = () => openReader(c.mangaId, c.id);
    const no = document.createElement('div');
    no.className = 'no';
    no.textContent = c.chapter ? `Ch ${c.chapter}` : 'Oneshot';
    row.appendChild(no);
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = c.mangaTitle + (c.title ? ` — ${c.title}` : '');
    if (c.publishAt && new Date(c.publishAt).getTime() > lastSeen) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'NEW';
      t.appendChild(b);
    }
    row.appendChild(t);
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.textContent = c.group || '';
    row.appendChild(grp);
    const when = document.createElement('div');
    when.className = 'date';
    when.textContent = fmtWhen(c.readableAt);
    row.appendChild(when);
    list.appendChild(row);
  }
  view.appendChild(list);
  // remember "now" as seen for next visit
  localStorage.setItem('mr_lastseen', String(Date.now()));
}

// ---------- Manga detail ----------
const STATUS_LABELS = { on_hiatus: 'Hiatus', cancelled: 'Cancelled', ongoing: 'Ongoing', completed: 'Completed', hiatus: 'Hiatus' };
async function renderManga(id) {
  view.innerHTML = `<div class="spin"></div>`;
  const [{ manga: m }, { chapters }] = await Promise.all([
    api(`/api/manga/${id}`),
    api(`/api/manga/${id}/feed`),
  ]);
  // library bookkeeping: only entries the user explicitly added live here;
  // opening a detail page just refreshes an existing entry (seenAt = now)
  if (library[id]) {
    const entry = library[id];
    entry.title = m.title;
    entry.cover = m.cover;
    entry.latestAt = m.latestUploadedAt ? new Date(m.latestUploadedAt).getTime() : entry.latestAt;
    entry.seenAt = Date.now();
    save('mr_library', library);
  }
  // recently-viewed trail (kept even for titles not saved to the library)
  viewedHistory[id] = { title: m.title, cover: m.cover, seenAt: Date.now() };
  const bySeen = Object.entries(viewedHistory).sort((x, y) => (y[1].seenAt || 0) - (x[1].seenAt || 0));
  if (bySeen.length > 30) for (const [k] of bySeen.slice(30)) delete viewedHistory[k];
  save('mr_history', viewedHistory);

  const status = m.status || '';
  const subBits = [m.year, m.lastChapter ? `${m.lastChapter} chapters` : '', m.author].filter(Boolean).join(' · ');
  const desc = (m.description || '').replace(/</g, '&lt;');
  const descId = 'desc-' + id.slice(0, 8);
  view.innerHTML = `
    <div id="detailwrap">
      <div class="backdrop"></div>
      <div id="detail">
        <div id="coverbox"></div>
        <div class="info">
          <h1>${m.title.replace(/</g, '&lt;')}${status ? `<span class="status-badge ${status}">${STATUS_LABELS[status] || status}</span>` : ''}</h1>
          ${subBits ? `<div class="sub">${subBits.replace(/</g, '&lt;')}</div>` : ''}
          <div class="tags">${m.tags.map((t) =>
            `<button data-tag="${t.id}" data-name="${encodeURIComponent(t.name)}">${t.name.replace(/</g, '&lt;')}</button>`).join('')}</div>
          <div class="desc clamped" id="${descId}">${desc}</div>
          ${desc ? `<button class="desc-toggle" data-desc="${descId}">Show more</button>` : ''}
          <div class="actions">
            <button id="librarybtn">+ Library</button>
            <button id="resumeBtn" hidden>Resume reading</button>
          </div>
        </div>
      </div>
    </div>
    <h2>Chapters (${chapters.length})</h2>
    <div class="chapters" id="chlist"></div>`;

  // background-image can't retry onerror — must go through the proxy too
  $('#detailwrap .backdrop').style.backgroundImage = `url("${proxiedUrl(m.coverFull || m.cover)}")`;

  // cover flips on hover to reveal the community rating
  const flip = document.createElement('div');
  flip.className = 'flip';
  flip.title = 'Community rating';
  const inner = document.createElement('div');
  inner.className = 'flip-inner';
  const front = document.createElement('div');
  front.className = 'flip-front';
  front.appendChild(img(m.coverFull || m.cover, m.title, false, 'cover'));
  const back = document.createElement('div');
  back.className = 'flip-back';
  const rt = m.rating || {};
  const score = document.createElement('div');
  score.className = 'score';
  score.textContent = rt.average != null ? `☆ ${rt.average.toFixed(2)}` : '☆ —';
  const follows = document.createElement('div');
  follows.className = 'follows';
  follows.textContent = rt.follows ? `${rt.follows.toLocaleString()} followers` : 'No rating yet';
  back.appendChild(score);
  back.appendChild(follows);
  inner.appendChild(front);
  inner.appendChild(back);
  flip.appendChild(inner);
  $('#coverbox').appendChild(flip);

  // clickable tags -> browse that category
  for (const btn of document.querySelectorAll('#detail .tags button')) {
    btn.onclick = () => nav(`/tag/${btn.dataset.tag}/${btn.dataset.name}`);
  }
  // synopsis 3-line clamp with show more/less
  const toggle = document.querySelector('.desc-toggle');
  if (toggle) {
    toggle.onclick = () => {
      const d = document.getElementById(toggle.dataset.desc);
      const clamped = d.classList.toggle('clamped');
      toggle.textContent = clamped ? 'Show more' : 'Show less';
    };
  }

  const libBtn = $('#librarybtn');
  const isInNow = () => !!library[id] && !!library[id].inLib;
  libBtn.textContent = isInNow() ? '✓ In library' : '+ Library';
  libBtn.classList.toggle('inlibrary', isInNow());
  libBtn.onclick = () => {
    if (isInNow()) {
      delete library[id].inLib;
      toast('Removed from library');
    } else {
      library[id] = library[id] || { title: m.title, cover: m.cover };
      library[id].inLib = true;
      library[id].ts = Date.now();
      library[id].latestAt = m.latestUploadedAt ? new Date(m.latestUploadedAt).getTime() : library[id].latestAt;
      library[id].seenAt = Date.now();
      toast('Added to library');
    }
    libBtn.textContent = isInNow() ? '✓ In library' : '+ Library';
    libBtn.classList.toggle('inlibrary', isInNow());
    save('mr_library', library);
  };

  const pr = progress[id];
  if (pr && pr.chapterId) {
    const btn = $('#resumeBtn');
    btn.hidden = false;
    btn.textContent = `Resume ch ${pr.chapter || '?'}`;
    btn.onclick = () => openReader(id, pr.chapterId);
  }

  const list = $('#chlist');
  const readSet = readMap[id] || {};
  for (const c of chapters) {
    const row = document.createElement('div');
    row.className = 'chrow' + (readSet[c.id] ? ' read' : '');
    if (c.isUnavailable) {
      row.style.opacity = '0.4';
      row.style.cursor = 'default';
      row.title = 'Chapter unavailable';
    } else if (c.externalUrl) {
      // hosted off MangaDex (official/licensed) — two deliberate clicks, never
      // one, so a stray click can't fling you at an external site
      const t2 = document.createElement('span');
      t2.className = 'grp';
      t2.style.color = 'var(--accent2)';
      t2.textContent = '↗ external';
      row.appendChild(t2);
      row.title = 'Hosted off MangaDex — click twice to open the publisher page';
      let armed = 0;
      row.onclick = () => {
        const now = Date.now();
        if (now - armed < 5000) {
          window.open(c.externalUrl, '_blank');
        } else {
          armed = now;
          toast('Opens the publisher site — click again within 5s to confirm');
        }
      };
    } else if (!c.pages) {
      row.style.opacity = '0.4';
      row.style.cursor = 'default';
      row.title = 'No pages';
    } else {
      row.onclick = () => openReader(id, c.id);
    }
    if (pr && pr.chapterId === c.id) {
      const cur = document.createElement('span');
      cur.className = 'current';
      cur.textContent = '○';
      cur.title = 'Last read';
      row.prepend(cur);
    }
    const no = document.createElement('div');
    no.className = 'no';
    no.textContent = c.chapter ? `Ch ${c.chapter}` : (c.title ? 'Oneshot' : '—');
    row.appendChild(no);
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = c.title || '';
    row.appendChild(t);
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.textContent = c.group || '';
    row.appendChild(grp);
    const when = document.createElement('div');
    when.className = 'date';
    when.textContent = fmtWhen(c.readableAt);
    row.appendChild(when);
    list.appendChild(row);
  }
  renderCrumbs(lastCrumbs.concat([{ label: m.title }]));
}

// ---------- Reader ----------
let readerState = null; // {mangaId, feed, idx, home}
const readerEl = $('#reader');

async function openReader(mangaId, chapterId) {
  // remember the hash we were on so Back restores it
  if (!readerState) readerState = { prevHash: location.hash };
  history.replaceState(null, '', `#/read/${mangaId}/${chapterId}`);
  readerEl.hidden = false;
  $('#readerpages').innerHTML = '<div class="spin"></div>';
  $('#readerstatus').hidden = false;
  $('#readerstatus').textContent = 'Loading pages…';
  $('#readertitle').textContent = '…';
  readerState.mangaId = mangaId;
  readerState.currentId = chapterId;

  try {
    const [{ manga: m }, { chapters }] = await Promise.all([
      api(`/api/manga/${mangaId}`),
      api(`/api/manga/${mangaId}/feed`),
    ]);
    readerState.title = m.title;
    readerState.feed = chapters; // newest first
    const idx = chapters.findIndex((c) => c.id === chapterId);
    readerState.idx = idx;
    const ch = chapters[idx] || {};
    $('#readertitle').textContent = `${m.title} — ${ch.chapter ? 'Ch ' + ch.chapter : ch.title || ''}`;
    $('#reader-prev').disabled = idx >= chapters.length - 1; // older chapter
    $('#reader-next').disabled = idx <= 0; // newer
    if (ch.externalUrl) {
      $('#readerpages').innerHTML = '<div class="empty">This chapter is hosted off MangaDex.<br><a href="#" id="extlink">Open publisher page</a></div>';
      $('#extlink').onclick = (e) => { e.preventDefault(); window.open(ch.externalUrl, '_blank'); };
      return;
    }
    await loadPages(ch);
  } catch (e) {
    $('#readerpages').innerHTML = `<div class="error">Failed to load chapter: ${e.message || e}</div>`;
    $('#readerstatus').hidden = true;
  }
}

async function loadPages(ch) {
  const box = $('#readerpages');
  box.innerHTML = '<div class="spin"></div>';
  const home = await api(`/api/athome/${readerState.currentId}`);
  readerState.home = home;
  const urls = prefs.quality === 'data' ? home.pages : (home.pagesSaver.length ? home.pagesSaver : home.pages);
  box.innerHTML = '';
  box.className = prefs.fit === 'height' ? 'fit-height' : '';
  readerEl.classList.toggle('fit-height', prefs.fit === 'height');
  urls.forEach((u, i) => {
    const el = img(u, `page ${i + 1}`, i < 3);
    el.className = 'page';
    box.appendChild(el);
  });
  // never leave the reader silently blank: if every page failed (expired CDN
  // session, blocked host, dead chapter), say so
  setTimeout(() => {
    const imgs2 = [...box.querySelectorAll('img.page')];
    if (imgs2.length && imgs2.every((x) => x.complete && x.naturalWidth === 0)) {
      box.innerHTML = '<div class="error">Pages failed to load — the chapter\'s CDN link may have expired. Reopen the chapter to fetch a fresh one.</div>';
      $('#readerstatus').hidden = true;
    }
  }, 20000);
  // restore saved scroll position for this chapter, else start at top
  const pr = progress[readerState.mangaId];
  if (pr && pr.chapterId === readerState.currentId && pr.scroll) {
    box.scrollTop = pr.scroll;
  }
  // progress + read tracking while scrolling (replace, never stack, handlers)
  if (box._scrollHandler) box.removeEventListener('scroll', box._scrollHandler);
  box._scrollHandler = debounce(() => {
    const st = readerState;
    if (!st) return;
    const pct = box.scrollTop / Math.max(1, box.scrollHeight - box.clientHeight);
    const page = Math.min(Math.round(pct * (box.children.length - 1)), box.children.length - 1);
    $('#reader-progress').textContent = `p${page + 1}/${box.children.length}`;
    const readMapEntry = readMap[st.mangaId] || (readMap[st.mangaId] = {});
    const wasNew = !readMapEntry[st.currentId];
    readMapEntry[st.currentId] = Date.now();
    progress[st.mangaId] = { chapterId: st.currentId, chapter: currentChapterNo(), page: page + 1, scroll: box.scrollTop, ts: Date.now() };
    save('mr_read', readMap);
    save('mr_progress', progress);
    if (wasNew && box.scrollHeight - box.clientHeight - box.scrollTop < 80) {
      // hit the bottom: whole chapter read
      toast('Chapter finished — Next ›');
    }
  }, 250);
  box.addEventListener('scroll', box._scrollHandler);
  $('#readerstatus').hidden = true;
}

function currentChapterNo() {
  const st = readerState;
  const ch = st.feed && st.feed[st.idx];
  return ch ? (ch.chapter || '') : '';
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

$('#reader-back').onclick = closeReader;
function closeReader() {
  const box = $('#readerpages');
  if (box._scrollHandler) { box.removeEventListener('scroll', box._scrollHandler); box._scrollHandler = null; }
  readerEl.hidden = true;
  $('#readerpages').innerHTML = '';
  $('#readerstatus').hidden = true;
  const prev = (readerState && readerState.prevHash) || '#/discover';
  readerState = null;
  location.hash = prev.replace(/^#/, '');
  render();
}
$('#reader-prev').onclick = () => stepReader(1);  // older chapter = higher idx (newest-first feed)
$('#reader-next').onclick = () => stepReader(-1); // newer chapter = lower idx
function stepReader(dir) {
  const st = readerState;
  if (!st || !st.feed) return;
  const next = st.idx + dir;
  if (next < 0 || next >= st.feed.length) return;
  const ch = st.feed[next];
  if (ch.externalUrl || ch.isUnavailable || !ch.pages) {
    toast('That chapter has no readable pages');
    return;
  }
  openReader(st.mangaId, ch.id);
}
$('#reader-quality').value = prefs.quality;
$('#reader-quality').onchange = (e) => {
  prefs.quality = e.target.value;
  save('mr_prefs', prefs);
  const st = readerState;
  if (st && st.feed) {
    const ch = st.feed[st.idx];
    if (ch && !ch.externalUrl) loadPages(ch);
  }
};

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !readerEl.hidden) closeReader();
  if (readerEl.hidden) return;
  if (e.key === 'ArrowLeft') stepReader(1);
  if (e.key === 'ArrowRight') stepReader(-1);
});

// ---------- nav wiring ----------
for (const btn of document.querySelectorAll('#nav button')) {
  btn.onclick = () => nav(`/${btn.dataset.nav}`);
}
$('#brand').onclick = () => nav('/discover');

render();