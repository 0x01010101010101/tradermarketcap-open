#!/usr/bin/env node
// TraderMarketCap web server: pages, API, MCP, llms.txt. Reads the collector's files, never the exchanges.
// Built to sit behind Cloudflare: every response says how long the CDN may keep it, so a traffic spike
// is served from the CDN and only a trickle reaches this server.
//
//   node server/server.mjs                 port 8790 (env PORT), one process
//   TMC_WORKERS=4 node server/server.mjs   one process per CPU core you give it
import http from 'node:http';
import cluster from 'node:cluster';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readFileSync, statSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeAtomic } from '../src/util.mjs';
import * as R from './render.mjs';
import { api, TIERS } from './api.mjs';
import { mcp } from './mcp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.TMC_DATA || join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const WORKERS = Number(process.env.TMC_WORKERS || 1);
const TRUST_PROXY = process.env.TMC_TRUST_PROXY === '1'; // set when Cloudflare / nginx sit in front
const STALE_MS = 120e3;

if (WORKERS > 1 && cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (w, code) => { console.log(`worker ${w.process.pid} exited (${code}), restarting`); cluster.fork(); });
  console.log(`TraderMarketCap web: ${WORKERS} workers on http://${HOST}:${PORT}`);
} else {
  start();
}

function start() {
  // ---------- data ----------
  const S = { snap: null, markets: {}, byId: new Map(), bySymbol: new Map(), version: 0 };
  const histCache = new Map();
  S.history = id => {
    const c = histCache.get(id);
    if (c && c.v === S.version) return c.h;
    const h = readJSON(join(DATA, 'history', id.replace(/[^a-z0-9.-]/g, '') + '.json'), null);
    histCache.set(id, { v: S.version, h });
    return h;
  };
  let mtime = 0;
  function load() {
    try {
      const st = statSync(join(DATA, 'snapshot.json'));
      if (st.mtimeMs === mtime) return;
      const snap = JSON.parse(readFileSync(join(DATA, 'snapshot.json'), 'utf8'));
      const markets = readJSON(join(DATA, 'markets.json'), { markets: {} }).markets;
      mtime = st.mtimeMs;
      S.snap = snap; S.markets = markets; S.version = snap.at;
      S.byId = new Map(snap.assets.map(a => [a.id, a]));
      S.bySymbol = new Map();
      for (const a of snap.assets) if (!S.bySymbol.has(a.symbol)) S.bySymbol.set(a.symbol, a); // best-ranked wins
      cache.clear();
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('load failed:', e.message);
    }
  }
  const cache = new Map(); // rendered responses for the current data version
  load();
  setInterval(load, 1000).unref();

  // ---------- keys and rate limits ----------
  let keys = {}, keysAt = 0;
  const keyTier = key => {
    if (Date.now() - keysAt > 30e3) { keys = readJSON(join(DATA, 'keys.json'), {}); keysAt = Date.now(); }
    const k = keys[crypto.createHash('sha256').update(key).digest('hex')];
    return k && !k.disabled && TIERS[k.tier] ? k.tier : null;
  };
  const buckets = new Map();
  setInterval(() => { const cut = Date.now() - 120e3; for (const [k, b] of buckets) if (b.t < cut) buckets.delete(k); }, 60e3).unref();
  function allow(who, perMin) {
    const now = Date.now();
    const b = buckets.get(who) || { tokens: perMin, t: now };
    b.tokens = Math.min(perMin, b.tokens + ((now - b.t) / 60e3) * perMin);
    b.t = now;
    buckets.set(who, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  const ipOf = req => (TRUST_PROXY && (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress;

  // ---------- responses ----------
  const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
  function pack(body, type, status = 200, cacheSec = 15, extra = {}) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return { status, type: TYPES[type] || type, raw, gz: raw.length > 1024 ? zlib.gzipSync(raw, { level: 6 }) : null,
      etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"', cacheSec, extra };
  }
  function send(req, res, p, { priv = false } = {}) {
    const h = { 'content-type': p.type, 'x-content-type-options': 'nosniff', vary: 'accept-encoding', ...p.extra };
    if (p.status >= 500) h['cache-control'] = 'no-store';
    else if (priv) h['cache-control'] = 'private, max-age=0';
    else h['cache-control'] = `public, max-age=${Math.min(p.cacheSec, 30)}, s-maxage=${p.cacheSec}, stale-while-revalidate=60, stale-if-error=600`;
    if (p.type === TYPES.html) {
      h['content-security-policy'] = "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'";
      h['referrer-policy'] = 'strict-origin-when-cross-origin';
    }
    if (p.type === TYPES.json) h['access-control-allow-origin'] = '*';
    h.etag = p.etag;
    if (req.headers['if-none-match'] === p.etag && p.status === 200) { res.writeHead(304, h); return res.end(); }
    const gzip = p.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gzip) h['content-encoding'] = 'gzip';
    const buf = gzip ? p.gz : p.raw;
    h['content-length'] = buf.length;
    res.writeHead(p.status, h);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const cached = (key, make) => {
    const k = S.version + '|' + key;
    let p = cache.get(k);
    if (!p) { p = make(); if (cache.size > 5000) cache.clear(); cache.set(k, p); }
    return p;
  };

  // ---------- static ----------
  const STATIC = {};
  for (const f of ['style.css', 'app.js', 'logo.svg']) {
    const p = join(ROOT, 'server', 'static', f);
    if (existsSync(p)) STATIC['/static/' + f] = pack(readFileSync(p), extname(f).slice(1), 200, 86400);
  }

  // ---------- small text files ----------
  const llms = () => `# TraderMarketCap

> Crypto prices, market caps and 24h volume for the top ~500 coins plus the Trac ecosystem (RESET, TNK, TAP). Every number links to its public source. Prices refresh every ${S.snap?.tickSeconds || 10} seconds. Times on the site are US Central Time.

Rank = market cap. Nobody pays to rank. Listing is free; proven scams are not listed.

## API (free tier: 30 calls/minute, no key)
- [All coins, ranked](${R.SITE}/v1/coins?limit=100): price_usd, change_24h_pct, market_cap_usd, volume_24h_usd, supply and supply_source
- [One coin](${R.SITE}/v1/coins/bitcoin): plus its markets, each with a source URL
- [Every price, compact](${R.SITE}/v1/prices)
- [Market overview](${R.SITE}/v1/global)
- [Exchanges](${R.SITE}/v1/exchanges)
- [Search](${R.SITE}/v1/search?q=reset)
- [Ranking rules](${R.SITE}/v1/rules)
- CoinGecko-compatible: ${R.SITE}/api/v3/simple/price?ids=bitcoin&vs_currencies=usd and ${R.SITE}/api/v3/coins/markets?vs_currency=usd

## MCP
- Endpoint: ${R.SITE}/mcp (Streamable HTTP). Tools: get_prices, top_coins, get_coin, search_coins, market_overview, ranking_rules

## Pages
- [Coins](${R.SITE}/)
- [How we rank](${R.SITE}/about#formula)
- [API plans](${R.SITE}/api)
`;
  const sitemap = () => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/exchanges', '/new', '/hotlist', '/list', '/api', '/about', ...S.snap.assets.map(a => '/coin/' + a.id)].map(p => `<url><loc>${R.SITE}${p}</loc></url>`).join('')}</urlset>`;

  // ---------- form posts (Hot List, ads, API plans) ----------
  function readBody(req, limit = 16384) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }
  async function request(req, res) {
    if (!allow('form|' + ipOf(req), 5)) return send(req, res, pack(R.message(S, 'Slow down', 'Too many requests. Try again in a minute.', 429).html, 'html', 429, 0), { priv: true });
    const f = new URLSearchParams(await readBody(req));
    if (f.get('website')) return send(req, res, pack(R.message(S, 'Thanks', 'We got it.').html, 'html', 200, 0), { priv: true }); // bot trap
    const kind = ['hotlist', 'ad', 'api'].includes(f.get('kind')) ? f.get('kind') : 'other';
    const row = { at: new Date().toISOString(), kind, coin: (f.get('coin') || '').slice(0, 100), length: (f.get('length') || '').slice(0, 20), contact: (f.get('contact') || '').slice(0, 200) };
    if (!row.contact) return send(req, res, pack(R.message(S, 'Missing contact', 'Tell us how to reach you.', 400).html, 'html', 400, 0), { priv: true });
    mkdirSync(DATA, { recursive: true });
    appendFileSync(join(DATA, 'requests.jsonl'), JSON.stringify(row) + '\n');
    send(req, res, pack(R.message(S, 'Thanks', 'We got it and will get back to you soon.').html, 'html', 200, 0), { priv: true });
  }

  // ---------- List your coin ----------
  const LISTINGS = join(DATA, 'listings.json');
  async function listing(req, res) {
    const bad = (t, m, st = 400) => send(req, res, pack(R.message(S, t, m, st).html, 'html', st, 0), { priv: true });
    if (!allow('list|' + ipOf(req), 3)) return bad('Slow down', 'Too many requests. Try again in a minute.', 429);
    const f = new URLSearchParams(await readBody(req));
    if (f.get('website2')) return bad('Thanks', 'We got it.', 200); // bot trap
    const v = k => (f.get(k) || '').trim();
    const row = {
      at: new Date().toISOString(), status: 'pending',
      name: v('name').slice(0, 80), symbol: v('symbol').toUpperCase().replace(/[^A-Z0-9.$-]/g, '').slice(0, 20),
      chain: R.LIST_CHAINS.some(([c]) => c === v('chain')) ? v('chain') : 'other',
      contract: v('contract').slice(0, 120), trades: v('trades').slice(0, 300), wallets: v('wallets').slice(0, 3000),
      site: v('site').slice(0, 200), social: v('social').slice(0, 200), contact: v('contact').slice(0, 200),
    };
    if (!row.name || !row.symbol || !row.contract || !row.trades || !row.contact) return bad('Missing details', 'Coin name, symbol, contract address, where it trades and how to reach you are needed.');
    const all = readJSON(LISTINGS, []);
    if (all.filter(l => l.status === 'pending').length > 500) return bad('Queue full', 'Too many requests waiting. Try again tomorrow.', 503);
    row.n = (all.at(-1)?.n || 0) + 1;
    all.push(row);
    writeAtomic(LISTINGS, JSON.stringify(all, null, 1));
    listingsCache = null;
    send(req, res, pack(R.message(S, 'Thanks', `${row.name} is in the listing queue. We check the chain and get back to you.`).html, 'html', 200, 0), { priv: true });
  }
  let listingsCache = null;
  const publicListings = () => listingsCache ??= readJSON(LISTINGS, []).map(({ at, name, symbol, status, reason, coinId }) => ({ at, name, symbol, status, reason, coinId }));
  setInterval(() => { listingsCache = null; }, 30e3).unref();

  // ---------- visit log ----------
  // One line per page, API or MCP call in visits.jsonl, read by tools/visits-report.mjs. No IP or user agent is stored:
  // a visitor is a hash of (IP, browser, a salt that changes every day), so a person cannot be followed across days.
  const VISITS = join(DATA, 'visits.jsonl'), SKIP = new Set(['/healthz', '/robots.txt', '/favicon.ico']);
  const BOT = /bot|crawl|spider|slurp|curl|wget|python|go-http|java\/|httpclient|axios|node-fetch|headless|scrapy|facebookexternalhit|preview/i;
  let vbuf = [], salt = '', saltDay = '';
  function logVisit(req, path) {
    if (SKIP.has(path) || req.method === 'HEAD') return;
    const day = new Date().toISOString().slice(0, 10);
    if (day !== saltDay) { saltDay = day; salt = crypto.createHash('sha256').update(day + (process.env.TMC_VISIT_SALT || ROOT)).digest('hex'); }
    const ua = String(req.headers['user-agent'] || '');
    const k = path === '/mcp' ? 'mcp' : (path.startsWith('/v1') || path.startsWith('/api/v3')) ? 'api' : path === '/llms.txt' ? 'llms' : 'page';
    let r = '', own = false; try { const h = new URL(String(req.headers.referer || '')).hostname.replace(/^www\./, ''); if (h.endsWith('tradermarketcap.com')) own = true; else if (h) r = h; } catch {}
    vbuf.push(JSON.stringify({ t: Math.floor(Date.now() / 1000), v: crypto.createHash('sha256').update(salt + ipOf(req) + ua).digest('hex').slice(0, 12),
      k: own && k === 'api' ? 'self' : k, p: path.slice(0, 80), b: ua ? (BOT.test(ua) ? 1 : 0) : 1, r: r.slice(0, 60) }));
  }
  setInterval(() => { if (!vbuf.length) return; const lines = vbuf.join('\n') + '\n'; vbuf = []; try { mkdirSync(DATA, { recursive: true }); appendFileSync(VISITS, lines); } catch {} }, 5000).unref();

  // ---------- router ----------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
      const q = url.searchParams;
      if (STATIC[path]) return send(req, res, STATIC[path]);
      logVisit(req, path);
      if (path === '/healthz') {
        const age = S.snap ? Date.now() - S.snap.at : null;
        return send(req, res, pack({ ok: age != null && age < STALE_MS, dataAgeMs: age, coins: S.snap?.global.coins ?? 0, pid: process.pid }, 'json', age != null && age < STALE_MS ? 200 : 503, 0), { priv: true });
      }
      if (path === '/robots.txt') return send(req, res, pack(`User-agent: *\nAllow: /\nDisallow: /request\nSitemap: ${R.SITE}/sitemap.xml\n`, 'txt', 200, 3600));
      if (req.method === 'POST' && path === '/request') return await request(req, res);
      if (req.method === 'POST' && path === '/list') return await listing(req, res);

      const isApi = path.startsWith('/v1') || path.startsWith('/api/v3') || path === '/mcp';
      if (isApi) {
        const key = req.headers['x-tmc-key'] || q.get('key') || req.headers['x-cg-pro-api-key'] || req.headers['x-cg-demo-api-key'];
        const tier = key ? keyTier(String(key)) : null;
        if (key && !tier) return send(req, res, pack({ error: 'unknown API key' }, 'json', 401, 0), { priv: true });
        if (!allow((tier ? 'k|' + key : 'ip|' + ipOf(req)), TIERS[tier || 'free'])) {
          return send(req, res, pack({ error: 'rate limit', limit_per_minute: TIERS[tier || 'free'], plans: R.SITE + '/api' }, 'json', 429, 0, { 'retry-after': '10' }), { priv: true });
        }
        if (path === '/mcp') {
          if (req.method === 'GET') return send(req, res, pack({ error: 'use POST (Streamable HTTP, JSON responses)' }, 'json', 405, 0, { allow: 'POST' }), { priv: true });
          if (req.method !== 'POST') return send(req, res, pack({ error: 'method not allowed' }, 'json', 405, 0), { priv: true });
          let body;
          try { body = JSON.parse(await readBody(req, 65536)); } catch { return send(req, res, pack({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 'json', 400, 0), { priv: true }); }
          const r = mcp(S, body);
          if (r.status === 202) { res.writeHead(202); return res.end(); }
          return send(req, res, pack(r.body, 'json', 200, 0), { priv: true });
        }
        if (!S.snap) return send(req, res, pack({ error: 'data loading, try again in a few seconds' }, 'json', 503, 0));
        const p = cached('api' + url.pathname + url.search, () => {
          const r = api(S, path, q);
          return r ? pack(r.body, 'json', r.status, r.cache) : pack({ error: 'not found', docs: R.SITE + '/api' }, 'json', 404, 60);
        });
        return send(req, res, p, { priv: !!tier });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, pack('method not allowed', 'txt', 405, 0));
      if (!S.snap) return send(req, res, pack(R.notReady(), 'html', 503, 0));
      if (path === '/llms.txt') return send(req, res, cached('llms', () => pack(llms(), 'txt', 200, 3600)));
      if (path === '/sitemap.xml') return send(req, res, cached('sitemap', () => pack(sitemap(), 'xml', 200, 3600)));
      if (path === '/rules.json') return send(req, res, cached('rules', () => pack(api(S, '/v1/rules', q).body, 'json', 200, 300)));
      if (path === '/dump/latest.json') return send(req, res, cached('dump', () => pack({ at: S.snap.at, global: S.snap.global, coins: S.snap.assets, exchanges: S.snap.venues }, 'json', 200, 60)));

      const page = cached('page' + url.pathname + url.search, () => {
        let html = null;
        if (path === '/') html = R.home(S, q);
        else if (path === '/exchanges') html = R.exchanges(S);
        else if (path === '/new') html = R.newCoins(S);
        else if (path === '/hotlist') html = R.hotlistPage(S);
        else if (path === '/api') html = R.apiPage(S);
        else if (path === '/about') html = R.about(S);
        else if (path === '/list') html = R.listPage(S, publicListings(), q);
        else if (path === '/search') {
          const r = R.search(S, q);
          if (r.redirect) return { redirect: r.redirect };
          html = r;
        } else if (path.startsWith('/coin/')) html = R.coin(S, decodeURIComponent(path.slice(6)).toLowerCase());
        if (html == null) { const m = R.message(S, 'Not found', 'That page does not exist.', 404); return pack(m.html, 'html', 404, 60); }
        return pack(html, 'html', 200, path === '/' ? 10 : 30);
      });
      if (page.redirect) { res.writeHead(302, { location: page.redirect, 'cache-control': 'public, max-age=60' }); return res.end(); }
      return send(req, res, page);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('error'); }
    }
  });
  server.keepAliveTimeout = 65e3;
  server.headersTimeout = 70e3;
  server.requestTimeout = 30e3;
  server.listen(PORT, HOST, () => { if (WORKERS === 1) console.log(`TraderMarketCap web on http://${HOST}:${PORT} (data ${DATA})`); });
}
