'use strict';
// Live end-to-end check of the MangaDex client: search -> feed -> at-home ->
// HEAD a real page URL. Needs network. Run with: node test.js
const md = require('./mangadex');

async function head(url) {
  // some image hosts 405 on HEAD — fall back to a ranged GET
  let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
  if (res.status === 405) {
    res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) });
  }
  return res.status;
}

(async () => {
  let ok = 0, failed = 0, fatal = false;
  // avoid process.exit() while sockets are pending — it trips a libuv
  // assertion on Windows; setting exitCode lets the loop drain naturally
  const fail = () => { failed++; fatal = true; process.exitCode = 1; };
  const step = (name, err) => { if (err) { fail(); console.log(`FAIL  ${name}: ${err.message || err}`); } else { ok++; console.log(`OK    ${name}`); } };

  // 1. search
  let results;
  try {
    results = await md.searchManga('berserk', { limit: 5 });
    if (!results.length) throw new Error('no results');
    console.log(`      search hits: ${results.map((m) => m.title).slice(0, 3).join(' | ')}`);
    step('search "berserk"');
  } catch (e) { step('search "berserk"', e); console.log('      (search is the foundation — stopping)'); return; }

  const first = results[0];
  console.log(`      cover: ${first.cover}`);
  const coverStatus = await head(first.cover.replace(/^http$/, 'https'));
  step('cover URL reachable (HEAD/GET 200|206)', ![200, 206].includes(coverStatus) ? new Error(`HTTP ${coverStatus}`) : null);

  // 2. popular + latest tabs
  try {
    const popular = await md.listManga('followedCount', { limit: 5 });
    const latest = await md.listManga('latestUploadedChapter', { limit: 5 });
    if (!popular.length || !latest.length) throw new Error('empty tab');
    console.log(`      popular: ${popular[0].title}`);
    console.log(`      latest : ${latest[0].title}`);
    step('popular/latest tabs');
  } catch (e) { step('popular/latest tabs', e); }

  // 3. details + feed for the top search hit
  let feed;
  try {
    const detail = await md.manga(first.id);
    if (detail.id !== first.id) throw new Error('id mismatch');
    console.log(`      tags: ${detail.tags.map((t) => t.name).join(', ') || '(none)'}`);
    feed = await md.mangaFeed(first.id, { lang: 'en', limit: 100 });
    if (!feed.length) throw new Error('no chapters');
    console.log(`      chapters: ${feed.length} (newest: v${feed[0].chapter || '?'} "${feed[0].title || '—'}" pages=${feed[0].pages})`);
    step('manga detail + feed');
  } catch (e) { step('manga detail + feed', e); return; }

  // 4. global latest-updates feed
  try {
    const g = await md.latestChapters({ limit: 10 });
    if (!g.length) throw new Error('empty');
    console.log(`      global latest: "${g[0].mangaTitle}" ch${g[0].chapter || '?'}`);
    step('global latest chapters');
  } catch (e) { step('global latest chapters', e); }

  // 5. at-home page resolution + a real page fetch
  let readable = feed.find((c) => !c.isUnavailable && !c.externalUrl && c.pages > 0);
  if (!readable) {
    console.log('FAIL  no readable chapter in feed to test at-home');
    process.exitCode = 1;
    return;
  }
  try {
    const home = await md.atHome(readable.id);
    if (!home.pages.length) throw new Error('no page URLs');
    console.log(`      at-home: ${home.pages.length} pages, quality=${home.quality}`);
    console.log(`      page[0]: ${home.pages[0]}`);
    const st = await head(home.pages[0]);
    if (![200, 206].includes(st)) throw new Error(`page HTTP ${st}`);
    step('at-home + page URL (200|206)');
  } catch (e) { step('at-home + page URL', e); }

  console.log(`\n${ok} passed, ${failed} failed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });