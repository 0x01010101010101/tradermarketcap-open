#!/usr/bin/env node
// Writes a small fake snapshot for tests and offline work.  node tools/demo-data.mjs <folder>
import { join } from 'node:path';
import { writeAtomic } from '../src/util.mjs';
import { CLASSES, GROUPS } from '../src/model.mjs';

export function writeDemo(dir) {
  const at = Date.now();
  const asset = (rank, id, symbol, name, price, circ, vol, chains = []) => ({
    id, class: 'crypto', symbol, name, chains, tags: vol < 1e4 ? ['thin'] : [], addedAt: new Date(at - 86400e3).toISOString(),
    price, change24h: 1.2, change7d: null, vol, mcap: price * circ, rank,
    supply: { circulating: circ, total: circ, max: null, src: 'https://example.com/supply/' + id, checked: true }, links: {}, marketCount: 1, countedMarkets: 1,
  });
  const assets = [
    asset(1, 'bitcoin', 'BTC', 'Bitcoin', 65000, 19.9e6, 4e9),
    asset(2, 'ethereum', 'ETH', 'Ethereum', 1840, 122e6, 1.5e9),
    asset(3, 'reset', 'RESET', 'RESET', 3, 14600, 4, ['trac']),
  ];
  const snap = {
    v: 1, at, tickSeconds: 10, firstSeenAt: at - 2 * 86400e3,
    global: { mcap: assets.reduce((s, a) => s + a.mcap, 0), vol: 5.5e9, coins: 3, ranked: 3, btcDominance: 80, stable: { USD: 1, USDT: 1, USDC: 1 } },
    classes: CLASSES, groups: GROUPS.filter(g => ['all', 'trac'].includes(g.id)), assets,
    venues: [{ id: 'coinbase', name: 'Coinbase', type: 'Exchange', site: 'https://www.coinbase.com', volUsd: 5e9, markets: 2 }],
    hotlist: [], ads: { slots: {} }, blocked: [], sources: { coinbase: { ok: true, markets: 2 } },
  };
  const m = (venue, pair, price, vol) => ({ venue, venueName: venue, pair, price, vol, change24h: 1, ignored: false, api: `https://api.example.com/${venue}/${pair}`, trade: 'https://example.com', at, tags: [] });
  writeAtomic(join(dir, 'snapshot.json'), snap);
  writeAtomic(join(dir, 'markets.json'), { at, markets: { bitcoin: [m('coinbase', 'BTC/USD', 65000, 4e9)], ethereum: [m('coinbase', 'ETH/USD', 1840, 1.5e9)], reset: [m('tracdex', 'RESET/USDC', 3, 4)] } });
}

if (process.argv[1] && process.argv[1].endsWith('demo-data.mjs')) {
  const dir = process.argv[2] || 'data-demo';
  writeDemo(dir);
  console.log('demo data written to', dir);
}
