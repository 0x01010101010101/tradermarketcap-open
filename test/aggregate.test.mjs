import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stablePrices, priceMarkets, assignMarkets, priceAsset, buildRows } from '../collector/aggregate.mjs';
import { makeAsset } from '../src/model.mjs';

const mk = (venue, base, quote, price, volQuote, extra = {}) => ({ venue, base, quote, price, volBase: null, volQuote, change24h: 1, api: 'x', ...extra });

test('stablecoins priced from USD markets', () => {
  const s = stablePrices([mk('kraken', 'USDT', 'USD', 0.999, 1e6), mk('coinbase', 'USDT', 'USD', 1.001, 1e6)]);
  assert.equal(s.USDT, 1);
  assert.equal(s.USD, 1);
});

test('outlier market is shown but not counted', () => {
  const ms = priceMarkets([mk('a', 'X', 'USD', 100, 1e6), mk('b', 'X', 'USD', 101, 1e6), mk('c', 'X', 'USDT', 150, 1e6)], { USD: 1, USDT: 1 });
  const p = priceAsset(ms);
  assert.equal(p.markets, 2);
  assert.ok(ms[2].ignored);
  assert.ok(Math.abs(p.price - 100.5) < 1e-9);
  assert.equal(p.vol, 2e6);
});

test('a small coin cannot take a big coin\'s ticker; explicit venues win', () => {
  const big = makeAsset({ id: 'tap-big', symbol: 'TAP', name: 'Other TAP' });
  const trac = { ...makeAsset({ id: 'tap', symbol: 'TAP', name: 'TAP' }), venues: {} };
  const tnk = { ...makeAsset({ id: 'trac-network', symbol: 'TNK', name: 'Trac Network' }), venues: { gate: 'TNK' } };
  const markets = [mk('mexc', 'TAP', 'USDT', 1, 10), mk('uniswap', 'TAP', 'USDT', 0.05, 10, { asset: 'tap' }), mk('gate', 'TNK', 'USDT', 0.08, 10), mk('mexc', 'TNK', 'USDT', 0.08, 10)];
  const by = assignMarkets([big, trac, tnk], markets);
  assert.deepEqual(by.get('tap').map(m => m.venue), ['uniswap']);
  assert.deepEqual(by.get('tap-big').map(m => m.venue), ['mexc']);
  assert.deepEqual(by.get('trac-network').map(m => m.venue), ['gate']);
});

test('rank by market cap; blocked coins are left out; no supply = unranked', () => {
  const A = makeAsset({ id: 'a', symbol: 'A', name: 'A', supply: { circulating: 10, checked: true } });
  const B = makeAsset({ id: 'b', symbol: 'B', name: 'B', supply: { circulating: 1000, checked: true } });
  const C = makeAsset({ id: 'c', symbol: 'C', name: 'C' });
  const D = makeAsset({ id: 'd', symbol: 'D', name: 'D', supply: { circulating: 5, checked: true } });
  const ms = priceMarkets([mk('x', 'A', 'USD', 10, 5e4), mk('x', 'B', 'USD', 1, 5e3), mk('x', 'C', 'USD', 1, 5e4), mk('x', 'D', 'USD', 1, 5e4)], { USD: 1 });
  const rows = buildRows([A, B, C, D], assignMarkets([A, B, C, D], ms), { blocked: new Set(['d']) });
  assert.deepEqual(rows.map(r => [r.id, r.rank]), [['b', 1], ['a', 2], ['c', null]]);
  assert.ok(rows.find(r => r.id === 'b').tags.includes('thin'));
});

test('A new venue gets no special treatment: same formula as any venue', () => {
  const S = makeAsset({ id: 'newcoin', symbol: 'NEWC', name: 'New Coin', supply: { circulating: 100, checked: true } });
  const X = makeAsset({ id: 'x', symbol: 'X', name: 'X', supply: { circulating: 100, checked: true } });
  const ms = priceMarkets([mk('newdex', 'NEWC', 'USDC', 2, 1e5), mk('kraken', 'X', 'USD', 2, 1e5)], { USD: 1, USDC: 1 });
  const rows = buildRows([S, X], assignMarkets([S, X], ms));
  assert.equal(rows[0].mcap, rows[1].mcap);
  assert.deepEqual(rows.find(r => r.id === 'newcoin').tags, []);
});
