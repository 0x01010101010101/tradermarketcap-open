// TraderMarketCap data model. One shape for every asset class, so new tabs need no rebuild.
//
// Asset            { id, class, symbol, name, chains[], tags[], addedAt, supply, links }
// Market (a pair)  { venue, base, quote, price, priceUsd, volBase, volUsd, change24h, api, trade, at }
// Snapshot         { v, at, global, assets[], venues[], hotlist[], ads{}, classes[] }
//
// Every number shown on the site carries where it came from: either an `api` URL on the market it was
// read from, or a `src` URL next to it (supply, chain reads).

export const CLASSES = [
  { id: 'crypto', label: 'Crypto', live: true },
  { id: 'metal', label: 'Metals', live: false, from: 2028, note: '15-minute delayed data' },
  { id: 'currency', label: 'Currencies', live: false, from: 2028, note: '15-minute delayed data' },
  { id: 'stock', label: 'Stocks', live: false, from: 2028, note: '15-minute delayed data' },
  { id: 'index', label: 'Indices', live: false, from: 2028, note: '15-minute delayed data' },
  { id: 'commodity', label: 'Commodities', live: false, from: 2028, note: '15-minute delayed data' },
];
export const CLASS_IDS = new Set(CLASSES.map(c => c.id));

// Chain / ecosystem groups used for the filter tabs on the home page.
export const GROUPS = [
  { id: 'all', label: 'All' },
  { id: 'trac', label: 'Trac' },
  { id: 'cosmos', label: 'Cosmos' },
  { id: 'ethereum', label: 'Ethereum' },
  { id: 'solana', label: 'Solana' },
];

// Stablecoins we use to turn USDT/USDC prices into dollars.
export const USD_QUOTES = new Set(['USD', 'USDT', 'USDC']);

export function makeAsset(a) {
  if (!a.id || !a.symbol || !a.name) throw new Error('asset needs id, symbol, name');
  const cls = a.class || 'crypto';
  if (!CLASS_IDS.has(cls)) throw new Error('unknown asset class ' + cls);
  return {
    id: a.id,
    class: cls,
    symbol: a.symbol.toUpperCase(),
    name: a.name,
    chains: a.chains || [],
    tags: a.tags || [],
    addedAt: a.addedAt || new Date().toISOString(),
    supply: a.supply || null, // read from the chain: { circulating, total, max, src, parts, excluded, checked, at }
    links: a.links || {},
    contracts: a.contracts || [], // [{ chain, address, from }] as the exchanges list them
  };
}

// A number we show, with its source.
export const num = (value, src, at = Date.now()) => (value == null || !isFinite(value) ? null : { v: value, src, at });
