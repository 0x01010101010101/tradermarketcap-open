#!/usr/bin/env node
// TraderMarketCap feed service: the ONE process that reads outside sources. No listing service is used.
//   - prices and volume: exchange tickers, the Trac DEX, Uniswap and other DEX pools, extra feeds
//   - which coins: every coin with real volume on our exchanges (plus Trac tokens and approved listings)
//   - names and contracts: the exchanges' own currency lists
//   - supply: read by us from the chains, per coin rule in coins.json; only those coins get a rank
// Every TICK seconds it writes data/snapshot.json + data/markets.json. Web servers only read those files.
//
//   node collector/collect.mjs            run forever (default tick 10 s, env TMC_TICK)
//   node collector/collect.mjs --once     one round, then exit
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeAtomic, median } from '../src/util.mjs';
import { makeAsset, CLASSES, GROUPS } from '../src/model.mjs';
import { READERS, VENUES } from './sources/exchanges.mjs';
import { TRAC_VENUES, tracDex, tapUniswap } from './sources/trac.mjs';
import { EXTRA_FEEDS, EXTRA_VENUE, EXTRA_ASSET, extraMarkets } from './sources/extra.mjs';
import { coinInfo, bestName, slug } from './sources/coininfo.mjs';
import { readSupply } from './sources/chainsupply.mjs';
import { v2PoolPrice, v3PoolPrice, EXPLORER } from './chains.mjs';
import { stablePrices, priceMarkets, assignMarkets, buildRows, venueStats, OUTLIER } from './aggregate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.TMC_DATA || join(ROOT, 'data');
const SEED = join(ROOT, 'data-seed');
const TICK = Number(process.env.TMC_TICK || 10) * 1000;
const UNIVERSE = Number(process.env.TMC_UNIVERSE || 600);  // most coins we list from exchange data
const MIN_VOL = Number(process.env.TMC_MIN_VOL || 100_000); // $ of 24h volume to be listed automatically
const ONCE = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toISOString(), ...a);

const DEX_VENUES = {};
const allVenues = () => ({ ...VENUES, ...TRAC_VENUES, ...EXTRA_VENUE, ...DEX_VENUES });
const conf = name => readJSON(join(DATA, name), null) ?? readJSON(join(SEED, name), null);

// Not coins: fiat currencies and leveraged tokens that exchanges list as pairs.
const FIAT = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'TRY', 'BRL', 'MXN', 'ARS', 'ZAR', 'PLN', 'NZD', 'SGD', 'HKD', 'KRW', 'INR', 'IDR', 'UAH', 'NGN', 'AED']);
const notCoin = s => FIAT.has(s) || /^[A-Z0-9]{2,}[2-5][LS]$/.test(s) || /^[A-Z0-9]{2,}(BULL|BEAR|HEDGE)$/.test(s);

// ---------- checked coins (coins.json) ----------
function checkedCoins() {
  const seed = readJSON(join(SEED, 'coins.json'), {});
  const local = readJSON(join(DATA, 'coins.json'), {});
  const all = { ...seed, ...local };
  delete all._help;
  // (extra feeds add their own assets here when configured)
  return all;
}

// ---------- registry ----------
let registry = readJSON(join(DATA, 'registry.json'), null);
if (!registry || registry.v !== 2) registry = { v: 2, ids: {}, assets: {}, members: [], createdAt: Date.now(), infoAt: 0, supplyAt: 0, universeAt: 0 };
let info = new Map();

function idFor(symbol, name, taken) {
  if (registry.ids[symbol]) return registry.ids[symbol];
  let id = slug(name);
  if (taken.has(id)) id = slug(name + '-' + symbol);
  registry.ids[symbol] = id;
  return id;
}

// Pick the coins to list from the markets themselves: real volume, more than one exchange (or a big US one).
function pickUniverse(markets, checked) {
  const bySym = new Map();
  for (const m of markets) {
    if (m.asset || !m.priceUsd || notCoin(m.base) || !VENUES[m.venue]) continue;
    (bySym.get(m.base) || bySym.set(m.base, []).get(m.base)).push(m);
  }
  const explicitSyms = new Set(Object.values(checked).filter(c => c.venues).map(c => c.symbol));
  const cand = [];
  for (const [sym, ms] of bySym) {
    const mid = median(ms.filter(m => m.volUsd >= 100).map(m => m.priceUsd)) ?? median(ms.map(m => m.priceUsd));
    const kept = ms.filter(m => Math.abs(m.priceUsd / mid - 1) <= OUTLIER);
    const vol = kept.reduce((s, m) => s + m.volUsd, 0);
    const venues = new Set(kept.map(m => m.venue));
    if (vol >= MIN_VOL && (venues.size >= 2 || venues.has('coinbase') || venues.has('kraken'))) cand.push({ sym, vol });
  }
  cand.sort((a, b) => b.vol - a.vol);
  // a symbol held by a checked coin with its own venue list (e.g. TAP) can still be listed as a different coin
  return cand.slice(0, UNIVERSE).map(c => ({ ...c, lookalike: explicitSyms.has(c.sym) }));
}

function rebuildRegistry(markets) {
  const checked = checkedCoins();
  const now = new Date().toISOString();
  const taken = new Set(Object.keys(checked));
  const members = [];
  const put = (id, a) => {
    registry.assets[id] = makeAsset({ ...a, id, addedAt: registry.assets[id]?.addedAt || now, supply: registry.assets[id]?.supply ?? null });
    if (a.venues) registry.assets[id].venues = a.venues;
    if (a.pools) registry.assets[id].pools = a.pools;
    members.push(id);
  };
  // checked coins listed by symbol
  const bySymbolChecked = new Map(Object.entries(checked).filter(([, c]) => !c.venues).map(([id, c]) => [c.symbol, id]));
  for (const { sym, lookalike } of pickUniverse(markets, checked)) {
    const x = info.get(sym);
    if (!lookalike && bySymbolChecked.has(sym)) continue; // added below with its rule
    const name = bestName(sym, x);
    const id = lookalike ? idFor(sym + ':other', name + ' ' + sym, taken) : idFor(sym, name, taken);
    taken.add(id);
    put(id, { symbol: sym, name, contracts: x?.contracts || [], venues: lookalike ? { kucoin: sym, gate: sym, mexc: sym, okx: sym } : undefined });
  }
  for (const [id, c] of Object.entries(checked)) {
    const listed = c.always || c.venues || markets.some(m => m.base === c.symbol);
    if (!listed) continue;
    registry.ids[c.symbol] ??= id;
    put(id, { ...c, contracts: info.get(c.symbol)?.contracts || [] });
  }
  registry.members = [...new Set(members)];
  registry.universeAt = Date.now();
}

async function refreshSupply() {
  const checked = checkedCoins();
  const ids = Object.keys(checked).filter(id => checked[id].supply && registry.assets[id]);
  let ok = 0;
  for (let i = 0; i < ids.length; i += 3) {
    await Promise.all(ids.slice(i, i + 3).map(async id => {
      try {
        const s = await readSupply(checked[id].supply);
        if (s) { registry.assets[id].supply = s; ok++; }
      } catch (e) { log(id, 'supply failed:', e.message); }
    }));
  }
  registry.supplyAt = Date.now();
  log(`supply read from chain for ${ok}/${ids.length} checked coins`);
}

// ---------- markets ----------
const lastGood = {};
let prevPrices = new Map();
async function poolMarkets(assets) {
  const out = [];
  for (const a of assets) for (const p of a.pools || []) {
    try {
      const r = p.type === 'v3' ? await v3PoolPrice(p.chain, p.address, p.token) : await v2PoolPrice(p.chain, p.address, p.token);
      const quoteUsd = p.quote === 'USD' ? 1 : prevPrices.get(p.quote === 'ETH' ? 'ethereum' : p.quote === 'BNB' ? 'bnb' : p.quote) ?? null;
      if (!quoteUsd) continue;
      const venue = `dex-${p.chain}-${p.type || 'v2'}`;
      DEX_VENUES[venue] ??= { name: `${p.dex || 'DEX'} ${p.type || 'v2'} (${p.chain})`, type: 'DEX' };
      out.push({ venue, asset: a.id, base: a.symbol, quote: 'USD', price: r.price * quoteUsd, volBase: null, volQuote: null, change24h: null,
        depthUsd: r.quoteReserve != null ? r.quoteReserve * quoteUsd * 2 : null,
        api: `${EXPLORER[p.chain]}/address/${p.address}#readContract`, trade: p.trade || null });
    } catch (e) { log(a.id, 'pool failed:', e.message); }
  }
  return out;
}

async function readAll(assets) {
  const jobs = {
    ...READERS,
    tracdex: tracDex,
    uniswap: tapUniswap,
    pools: () => poolMarkets(assets),
    ...(EXTRA_FEEDS ? { extra: extraMarkets } : {}),
  };
  const status = {};
  await Promise.all(Object.entries(jobs).map(async ([k, f]) => {
    try {
      const ms = await f();
      if (k === 'tracdex') for (const m of ms) m.asset = m.base === 'RESET' ? 'reset' : m.base === 'TNK' ? 'trac-network' : null;
      if (k === 'uniswap') for (const m of ms) m.asset = 'tap';
      lastGood[k] = { at: Date.now(), markets: ms };
      status[k] = { ok: true, markets: ms.length };
    } catch (e) {
      status[k] = { ok: false, error: e.message.slice(0, 120) };
    }
  }));
  const at = Date.now();
  const markets = [];
  for (const [k, v] of Object.entries(lastGood)) {
    if (at - v.at > 120e3) { status[k] = { ...status[k], stale: true }; continue; }
    for (const m of v.markets) markets.push({ ...m, at: v.at });
  }
  return { markets, status };
}

// ---------- history (hourly points for charts and 7-day change) ----------
const HIST = join(DATA, 'history');
let lastHour = 0;
function saveHistory(rows) {
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
  if (hour === lastHour) return;
  lastHour = hour;
  for (const r of rows) {
    const p = join(HIST, r.id + '.json');
    const h = readJSON(p, { h: [], d: [] });
    if (!h.h.length || h.h.at(-1)[0] !== hour) h.h.push([hour, r.price, r.mcap, r.vol]);
    h.h = h.h.filter(x => x[0] > hour - 8 * 86400e3);
    const day = Math.floor(hour / 86400e3) * 86400e3;
    if (!h.d.length || h.d.at(-1)[0] !== day) h.d.push([day, r.price, r.mcap, r.vol]);
    else h.d[h.d.length - 1] = [day, r.price, r.mcap, r.vol];
    writeAtomic(p, h);
  }
}
let prevRows = [];
function addChange7d(rows) {
  const target = Date.now() - 7 * 86400e3;
  for (const r of rows) {
    const h = readJSON(join(HIST, r.id + '.json'), null);
    const old = h?.h.find(x => Math.abs(x[0] - target) < 2 * 3600e3);
    r.change7d = old && old[1] ? (r.price / old[1] - 1) * 100 : null;
  }
}
function carry7d(rows) {
  const old = new Map(prevRows.map(r => [r.id, r]));
  for (const r of rows) {
    const p = old.get(r.id);
    if (p?.change7d != null && p.price) r.change7d = ((1 + p.change7d / 100) * r.price / p.price - 1) * 100;
  }
}

// ---------- one round ----------
let round = 0;
async function tick() {
  const t0 = Date.now();
  if (!info.size || Date.now() - registry.infoAt > 6 * 3600e3) {
    const r = await coinInfo();
    if (r.info.size) { info = r.info; registry.infoAt = Date.now(); registry.universeAt = 0; } // fresh names: rebuild the list
    if (r.failed.length) log('coin info:', r.failed.join('; '));
  }
  let assets = registry.members.map(id => registry.assets[id]).filter(Boolean);
  const { markets, status } = await readAll(assets);
  const stable = stablePrices(markets);
  priceMarkets(markets, stable);

  if (!registry.members.length || Date.now() - registry.universeAt > 3600e3) {
    rebuildRegistry(markets);
    assets = registry.members.map(id => registry.assets[id]);
    writeAtomic(join(DATA, 'registry.json'), registry);
  }
  if (Date.now() - registry.supplyAt > 3600e3) {
    await refreshSupply();
    writeAtomic(join(DATA, 'registry.json'), registry);
  }

  const byAsset = assignMarkets(assets, markets);
  const blockedList = conf('blocked.json') || [];
  const rows = buildRows(assets, byAsset, { blocked: new Set(blockedList.map(b => b.id)), flags: conf('flags.json') || {} });
  if (round % 30 === 0) addChange7d(rows); else carry7d(rows);
  prevRows = rows;
  prevPrices = new Map(rows.map(r => [r.id, r.price]));

  const ranked = rows.filter(r => r.mcap != null);
  const totalMcap = ranked.reduce((s, r) => s + r.mcap, 0);
  const btc = rows.find(r => r.id === 'bitcoin');
  const hot = (conf('hotlist.json') || { spots: [] }).spots.filter(s => Date.parse(s.until) > Date.now() && (!s.from || Date.parse(s.from) <= Date.now()));
  const groups = GROUPS.filter(g => g.id === 'all' || rows.some(r => r.chains.includes(g.id)));
  const venues = allVenues();

  const snapshot = {
    v: 1, at: Date.now(), tickSeconds: TICK / 1000, firstSeenAt: registry.createdAt,
    global: {
      mcap: totalMcap, vol: rows.reduce((s, r) => s + r.vol, 0), coins: rows.length, ranked: ranked.length,
      btcDominance: btc?.mcap && totalMcap ? (btc.mcap / totalMcap) * 100 : null,
      stable,
    },
    classes: CLASSES, groups,
    assets: rows,
    venues: venueStats(byAsset, venues),
    hotlist: hot.slice(0, 5),
    ads: conf('ads.json') || { slots: {} },
    blocked: blockedList,
    sources: status,
  };
  const marketsOut = {};
  for (const r of rows) {
    marketsOut[r.id] = byAsset.get(r.id)
      .sort((a, b) => (a.ignored - b.ignored) || b.volUsd - a.volUsd).slice(0, 40)
      .map(m => ({ venue: m.venue, venueName: venues[m.venue]?.name || m.venue, pair: `${m.base}/${m.quote}`,
        price: m.priceUsd, vol: m.volUsd, change24h: m.change24h, ignored: !!m.ignored, api: m.api, trade: m.trade,
        depthUsd: m.depthUsd ?? null, at: m.at }));
  }
  writeAtomic(join(DATA, 'markets.json'), { at: snapshot.at, markets: marketsOut });
  writeAtomic(join(DATA, 'snapshot.json'), snapshot);
  saveHistory(rows);
  round++;
  const bad = Object.entries(status).filter(([, s]) => !s.ok).map(([k]) => k);
  if (round === 1 || round % 30 === 0 || bad.length) log(`round ${round}: ${rows.length} coins (${ranked.length} ranked), ${markets.length} markets, ${Date.now() - t0} ms${bad.length ? ', failed: ' + bad.join(' ') : ''}`);
}

async function main() {
  log(`TraderMarketCap collector, tick ${TICK / 1000}s, data in ${DATA}${EXTRA_FEEDS ? ', extra feeds ' + EXTRA_FEEDS : ''}`);
  for (;;) {
    const t = Date.now();
    try { await tick(); } catch (e) { log('round failed:', e.stack || e.message); }
    if (ONCE) break;
    await new Promise(r => setTimeout(r, Math.max(1000, TICK - (Date.now() - t))));
  }
}
main();
