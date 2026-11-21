// Public JSON API. /v1/* is ours; /api/v3/* answers in CoinGecko's shapes so bots can switch by changing one URL.
import { OUTLIER, THIN_USD } from '../collector/aggregate.mjs';
import { SITE } from './render.mjs';

export const TIERS = { free: 30, pro: 300, business: 1500 }; // calls per minute

export function coinOut(a, rank = true) {
  return {
    id: a.id, symbol: a.symbol, name: a.name, class: a.class, ...(rank ? { rank: a.rank } : {}),
    price_usd: a.price, change_24h_pct: a.change24h, change_7d_pct: a.change7d,
    market_cap_usd: a.mcap, volume_24h_usd: a.vol,
    circulating_supply: a.supply?.circulating ?? null, total_supply: a.supply?.total ?? null, max_supply: a.supply?.max ?? null,
    supply_source: a.supply?.src ?? null, chains: a.chains, tags: a.tags,
    url: `${SITE}/coin/${a.id}`,
  };
}

const clampInt = (v, lo, hi, d) => Math.min(hi, Math.max(lo, parseInt(v ?? d, 10) || d));
const pickIds = (S, q) => {
  const ids = (q.get('ids') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const syms = (q.get('symbols') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const out = [];
  for (const id of ids) { const a = S.byId.get(id); if (a) out.push(a); }
  for (const s of syms) { const a = S.bySymbol.get(s); if (a) out.push(a); }
  return out;
};

export function rules(S) {
  return {
    ranking: 'market cap, largest first; coins without a known supply are listed unranked',
    price: `volume-weighted average across markets; markets more than ${OUTLIER * 100}% from the median price are shown but not counted; markets under $100 of 24h volume count only when nothing bigger exists`,
    market_cap: 'price x circulating supply; supply source linked on every coin',
    thin_market_usd: THIN_USD,
    refresh_seconds: S.snap?.tickSeconds || 10,
    paid: { ranking: 'never for sale', hot_list: 'shown above the ranking, never changes rank', ads: 'marked "Ad", never inside a list' },
    listing: 'free for every coin; proven scams are not listed (see blocked)',
    blocked: S.snap?.blocked || [],
    sources: S.snap?.sources || {},
  };
}

// Returns { status, body, cache } or null when no route matches.
export function api(S, path, q) {
  const snap = S.snap;
  const ok = (body, cache = 5) => ({ status: 200, body, cache });
  const nf = msg => ({ status: 404, body: { error: msg }, cache: 30 });

  if (path === '/v1' || path === '/v1/') return ok({ endpoints: ['/v1/global', '/v1/coins', '/v1/coins/{id}', '/v1/coins/{id}/markets', '/v1/coins/{id}/history', '/v1/prices', '/v1/search?q=', '/v1/exchanges', '/v1/hotlist', '/v1/rules'], docs: SITE + '/api' }, 300);
  if (path === '/v1/global') return ok({ at: snap.at, ...snap.global, classes: snap.classes });
  if (path === '/v1/coins') {
    const limit = clampInt(q.get('limit'), 1, 500, 100), offset = clampInt(q.get('offset'), 0, 100000, 0);
    let list = snap.assets;
    const chain = q.get('chain'), cls = q.get('class');
    if (chain) list = list.filter(a => a.chains.includes(chain));
    if (cls) list = list.filter(a => a.class === cls);
    if (q.get('ids') || q.get('symbols')) list = pickIds(S, q);
    return ok({ at: snap.at, total: list.length, coins: list.slice(offset, offset + limit).map(a => coinOut(a)) });
  }
  if (path === '/v1/prices') {
    // Compact: { id: [price, change24h] } for every coin. Used by the site to refresh numbers.
    const p = {};
    for (const a of snap.assets) p[a.id] = [a.price, a.change24h];
    return ok({ at: snap.at, prices: p });
  }
  if (path === '/v1/exchanges') return ok({ at: snap.at, exchanges: snap.venues });
  if (path === '/v1/hotlist') return ok({ at: snap.at, spots: snap.hotlist.map(s => ({ ...s, coin: S.byId.get(s.asset) ? coinOut(S.byId.get(s.asset)) : null })) }, 30);
  if (path === '/v1/rules') return ok(rules(S), 300);
  if (path === '/v1/search') {
    const t = (q.get('q') || '').trim().toLowerCase();
    const list = t ? snap.assets.filter(a => a.symbol.toLowerCase() === t || a.name.toLowerCase().includes(t) || a.id.includes(t)).slice(0, 25) : [];
    return ok({ coins: list.map(a => coinOut(a)) }, 30);
  }
  let m = path.match(/^\/v1\/coins\/([a-z0-9.-]+)(\/markets|\/history)?$/);
  if (m) {
    const a = S.byId.get(m[1]);
    if (!a) return nf('coin not found');
    if (m[2] === '/markets') return ok({ at: snap.at, id: a.id, markets: S.markets[a.id] || [] });
    if (m[2] === '/history') {
      const h = S.history(a.id) || { h: [], d: [] };
      return ok({ id: a.id, columns: ['time_ms', 'price_usd', 'market_cap_usd', 'volume_24h_usd'], hourly: h.h, daily: h.d }, 300);
    }
    return ok({ at: snap.at, ...coinOut(a), markets: (S.markets[a.id] || []).slice(0, 10), links: a.links });
  }

  // ---- CoinGecko-shaped ----
  if (path === '/api/v3/ping') return ok({ gecko_says: '(V3) To the Moon!', tradermarketcap: 'ok' }, 60);
  if (path === '/api/v3/coins/list') return ok(snap.assets.map(a => ({ id: a.id, symbol: a.symbol.toLowerCase(), name: a.name })), 300);
  if (path === '/api/v3/global') return ok({ data: {
    active_cryptocurrencies: snap.global.coins, total_market_cap: { usd: snap.global.mcap }, total_volume: { usd: snap.global.vol },
    market_cap_percentage: { btc: snap.global.btcDominance }, updated_at: Math.floor(snap.at / 1000) } });
  if (path === '/api/v3/simple/price') {
    const vs = (q.get('vs_currencies') || 'usd').toLowerCase();
    if (!vs.split(',').includes('usd')) return { status: 400, body: { error: 'only usd is supported for now' }, cache: 60 };
    const out = {};
    for (const a of pickIds(S, q)) {
      const r = { usd: a.price };
      if (q.get('include_market_cap') === 'true') r.usd_market_cap = a.mcap;
      if (q.get('include_24hr_vol') === 'true') r.usd_24h_vol = a.vol;
      if (q.get('include_24hr_change') === 'true') r.usd_24h_change = a.change24h;
      if (q.get('include_last_updated_at') === 'true') r.last_updated_at = Math.floor(snap.at / 1000);
      out[a.id] = r;
    }
    return ok(out);
  }
  if (path === '/api/v3/coins/markets') {
    if ((q.get('vs_currency') || 'usd').toLowerCase() !== 'usd') return { status: 400, body: { error: 'only usd is supported for now' }, cache: 60 };
    const per = clampInt(q.get('per_page'), 1, 250, 100), page = clampInt(q.get('page'), 1, 1000, 1);
    let list = q.get('ids') ? pickIds(S, q) : snap.assets;
    list = list.slice((page - 1) * per, page * per);
    return ok(list.map(a => ({
      id: a.id, symbol: a.symbol.toLowerCase(), name: a.name, current_price: a.price, market_cap: a.mcap, market_cap_rank: a.rank,
      total_volume: a.vol, price_change_percentage_24h: a.change24h, circulating_supply: a.supply?.circulating ?? null,
      total_supply: a.supply?.total ?? null, max_supply: a.supply?.max ?? null, last_updated: new Date(snap.at).toISOString(),
    })));
  }
  return null;
}
