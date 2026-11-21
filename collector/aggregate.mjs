// Turns raw markets + the asset registry into ranked rows. Pure functions, so they are easy to test.
import { median } from '../src/util.mjs';

export const OUTLIER = 0.2;     // a market more than 20% off the median price is shown but not counted
export const THIN_USD = 10_000; // less than $10k of 24h volume = "thin" tag
const MIN_WEIGHT_USD = 100;     // markets below this volume only count when nothing bigger exists

export function stablePrices(markets) {
  const out = { USD: 1, USDT: 1, USDC: 1 };
  for (const s of ['USDT', 'USDC']) {
    const ps = markets.filter(m => m.base === s && m.quote === 'USD' && m.price > 0.8 && m.price < 1.2).map(m => m.price);
    if (ps.length) out[s] = median(ps);
  }
  return out;
}

export function priceMarkets(markets, stable) {
  for (const m of markets) {
    const q = stable[m.quote] ?? null;
    m.priceUsd = q && m.price ? m.price * q : null;
    m.volUsd = m.volQuote != null && q ? m.volQuote * q : m.volBase != null && m.priceUsd ? m.volBase * m.priceUsd : 0;
  }
  return markets;
}

// Which asset each market belongs to.
//  - a market may name its asset (Trac DEX, Uniswap pool)
//  - an asset with a `venues` map only takes those venues (e.g. TNK only from Gate and MEXC); `venues: {}` = none
//  - otherwise the best-ranked asset with that symbol takes it, so a small coin can't borrow a big coin's ticker
export function assignMarkets(assets, markets) {
  const bySymbol = new Map();
  for (const a of assets) {
    if (a.venues) continue;
    if (!bySymbol.has(a.symbol)) bySymbol.set(a.symbol, a.id); // assets arrive best-ranked first
  }
  const explicit = new Map();
  for (const a of assets) if (a.venues) for (const [venue, s] of Object.entries(a.venues)) explicit.set(venue + '|' + s, a.id);

  const out = new Map(assets.map(a => [a.id, []]));
  for (const m of markets) {
    const id = m.asset || explicit.get(m.venue + '|' + m.base) || bySymbol.get(m.base);
    if (id && out.has(id)) out.get(id).push(m);
  }
  return out;
}

export function priceAsset(markets) {
  const usable = markets.filter(m => m.priceUsd > 0);
  if (!usable.length) return null;
  const big = usable.filter(m => m.volUsd >= MIN_WEIGHT_USD);
  const pool = big.length ? big : usable;
  const mid = median(pool.map(m => m.priceUsd));
  for (const m of usable) m.ignored = Math.abs(m.priceUsd / mid - 1) > OUTLIER || (big.length > 0 && m.volUsd < MIN_WEIGHT_USD);
  const kept = usable.filter(m => !m.ignored);
  const vol = kept.reduce((s, m) => s + m.volUsd, 0);
  const price = vol > 0 ? kept.reduce((s, m) => s + m.priceUsd * m.volUsd, 0) / vol : median(kept.map(m => m.priceUsd));
  const ch = kept.filter(m => m.change24h != null && isFinite(m.change24h));
  const chVol = ch.reduce((s, m) => s + m.volUsd, 0);
  const change24h = ch.length ? (chVol > 0 ? ch.reduce((s, m) => s + m.change24h * m.volUsd, 0) / chVol : median(ch.map(m => m.change24h))) : null;
  return { price, vol, change24h, markets: kept.length };
}

export function buildRows(assets, byAsset, { blocked = new Set(), flags = {} } = {}) {
  const rows = [];
  for (const a of assets) {
    if (blocked.has(a.id)) continue;
    const ms = byAsset.get(a.id) || [];
    const p = priceAsset(ms);
    if (!p) continue;
    const circ = a.supply?.checked ? a.supply.circulating ?? null : null; // rank only on supply we read ourselves
    const mcap = circ != null ? p.price * circ : null;
    const tags = [...(a.tags || []), ...(flags[a.id] || [])];
    if (p.vol < THIN_USD) tags.push('thin');
    rows.push({
      id: a.id, class: a.class, symbol: a.symbol, name: a.name, chains: a.chains, tags, addedAt: a.addedAt,
      price: p.price, change24h: p.change24h, change7d: null, vol: p.vol, mcap,
      supply: a.supply, links: a.links, contracts: (a.contracts || []).slice(0, 6), marketCount: ms.length, countedMarkets: p.markets,
    });
  }
  rows.sort((x, y) => (y.mcap ?? -1) - (x.mcap ?? -1) || y.vol - x.vol);
  let r = 0;
  for (const row of rows) row.rank = row.mcap != null ? ++r : null;
  return rows;
}

export function venueStats(byAsset, venueInfo) {
  const v = {};
  for (const ms of byAsset.values()) for (const m of ms) {
    const s = (v[m.venue] ??= { id: m.venue, ...(venueInfo[m.venue] || { name: m.venue }), volUsd: 0, markets: 0 });
    s.markets++;
    if (!m.ignored) s.volUsd += m.volUsd || 0;
  }
  return Object.values(v).sort((a, b) => b.volUsd - a.volUsd);
}
