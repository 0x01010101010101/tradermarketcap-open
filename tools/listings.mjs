#!/usr/bin/env node
// Review "List your coin" requests. Approving reads the chain first and adds the coin to data/coins.json;
// the collector picks it up within the hour (restart it to list right away).
//
//   node tools/listings.mjs list                 waiting requests
//   node tools/listings.mjs show 12              one request, with a live chain check
//   node tools/listings.mjs approve 12           list it (free); wallets from the form are subtracted from supply
//   node tools/listings.mjs reject 12 "reason"   the reason shows in the public queue (e.g. "proven scam: <link>")
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeAtomic } from '../src/util.mjs';
import { slug } from '../collector/sources/coininfo.mjs';
import { readSupply } from '../collector/sources/chainsupply.mjs';
import { v2PoolPrice, v3PoolPrice, EVM_RPC } from '../collector/chains.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.TMC_DATA || join(ROOT, 'data');
const LISTINGS = join(DATA, 'listings.json');
const COINS = join(DATA, 'coins.json');
const listings = readJSON(LISTINGS, []);
const [cmd, nArg, ...rest] = process.argv.slice(2);
const find = n => listings.find(l => l.n === Number(n)) || (console.error('no request', n), process.exit(1));
const save = () => writeAtomic(LISTINGS, JSON.stringify(listings, null, 1));

// Stablecoins and wrapped native coins, to price a pool in dollars.
const QUOTES = {
  eth: { '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USD', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USD', '0x6b175474e89094c44da98b954eedeac495271d0f': 'USD', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ETH' },
  bsc: { '0x55d398326f99059ff775485246999027b3197955': 'USD', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USD', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'BNB' },
  base: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USD', '0x4200000000000000000000000000000000000006': 'ETH' },
  arbitrum: { '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USD', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USD', '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ETH' },
  avax: { '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USD', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': 'USD' },
};

function parseWallets(text, chain) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|T[1-9A-HJ-NP-Za-km-z]{33})/);
    return m ? { chain, holder: m[1], reason: (l.replace(m[1], '').replace(/^[\s–—:-]+/, '').trim() || 'Not circulating').slice(0, 60) } : null;
  }).filter(Boolean);
}

async function detectPool(chain, address, token) {
  if (!EVM_RPC[chain]) return null;
  let type = 'v2', r;
  try { r = await v2PoolPrice(chain, address, token); } catch { type = 'v3'; r = await v3PoolPrice(chain, address, token); }
  const quote = QUOTES[chain]?.[r.quoteToken.toLowerCase()];
  return quote ? { chain, type, address, token, quote, dex: 'DEX' } : { unknownQuote: r.quoteToken };
}

async function draft(l) {
  const evmChain = !!EVM_RPC[l.chain];
  const entry = { symbol: l.symbol, name: l.name, chains: l.chain === 'trac' ? ['trac'] : [], always: true, listedFrom: l.n,
    links: { ...(l.site ? { site: l.site } : {}), ...(l.social ? { social: l.social } : {}) } };
  const notes = [];
  if (l.contract && (evmChain || l.chain === 'sol' || l.chain === 'tron')) {
    entry.supply = { method: 'tokens', parts: [{ chain: l.chain, address: l.contract }], exclude: parseWallets(l.wallets, l.chain) };
    if (!evmChain && entry.supply.exclude.length) notes.push('wallet balances are only subtracted on EVM chains for now; these are listed but not read');
  } else notes.push('no supply rule: chain not supported yet or no contract; coin will show unranked');
  const pool = (l.trades.match(/0x[0-9a-fA-F]{40}/) || [])[0];
  if (pool && evmChain && l.contract) {
    const p = await detectPool(l.chain, pool, l.contract).catch(e => ({ error: e.message }));
    if (p?.address) { entry.pools = [p]; entry.venues = {}; }
    else notes.push('pool not usable: ' + JSON.stringify(p));
  }
  let supply = null;
  if (entry.supply) supply = await readSupply(entry.supply).catch(e => (notes.push('supply read failed: ' + e.message), null));
  return { entry, supply, notes };
}

if (cmd === 'list' || !cmd) {
  const w = listings.filter(l => l.status === 'pending');
  if (!w.length) console.log('No requests waiting.');
  for (const l of w) console.log(`#${l.n}  ${l.at.slice(0, 10)}  ${l.name} (${l.symbol})  ${l.chain}  ${l.contract || '-'}  contact: ${l.contact}`);
} else if (cmd === 'show') {
  const l = find(nArg);
  console.log(l);
  const d = await draft(l);
  console.log('\nWould add to coins.json:', JSON.stringify(d.entry, null, 1));
  if (d.supply) console.log('Supply read now:', { circulating: d.supply.circulating, total: d.supply.total, excluded: d.supply.excluded });
  for (const n of d.notes) console.log('Note:', n);
} else if (cmd === 'approve') {
  const l = find(nArg);
  const d = await draft(l);
  const coins = readJSON(COINS, {});
  let id = slug(l.name);
  if (coins[id] || readJSON(join(ROOT, 'data-seed', 'coins.json'), {})[id]) id = slug(l.name + '-' + l.symbol);
  coins[id] = { ...d.entry, approved: new Date().toISOString() };
  writeAtomic(COINS, JSON.stringify(coins, null, 1));
  Object.assign(l, { status: 'approved', coinId: id, reason: '', decided: new Date().toISOString() });
  save();
  console.log(`Approved #${l.n} as /coin/${id}.`, d.notes.length ? '\nNotes: ' + d.notes.join('; ') : '');
  console.log('It appears after the collector next rebuilds its list (within an hour), or restart the collector now.');
} else if (cmd === 'reject') {
  const l = find(nArg);
  Object.assign(l, { status: 'rejected', reason: rest.join(' ').slice(0, 200) || 'Did not pass the check', decided: new Date().toISOString() });
  save();
  console.log(`Rejected #${l.n}: ${l.reason}`);
} else {
  console.log('usage: list | show <n> | approve <n> | reject <n> "reason"');
}
