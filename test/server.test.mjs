// Starts the web server on a demo snapshot and checks pages, API, MCP and rate limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDemo } from '../tools/demo-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18790 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let dir, proc;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tmc-'));
  writeDemo(dir);
  proc = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], { env: { ...process.env, PORT: String(PORT), TMC_DATA: dir, TMC_TRUST_PROXY: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

const get = (p, h = {}) => fetch(BASE + p, { headers: { 'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 250), ...h } });

test('pages render with CDN cache headers', async () => {
  for (const p of ['/', '/coin/bitcoin', '/coin/reset', '/exchanges', '/new', '/hotlist', '/list', '/api', '/about', '/llms.txt', '/sitemap.xml', '/rules.json']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('cache-control'), /s-maxage=\d+/, p);
  }
  const home = await (await get('/')).text();
  assert.match(home, /HOT LIST/);
  assert.doesNotMatch(home, /same owner/i);
  assert.doesNotMatch(home, />Paid</);
  assert.match(home, /class="adtag">Ad</);
  assert.equal((await get('/coin/nope')).status, 404);
});

test('API and CoinGecko-shaped routes', async () => {
  const c = await (await get('/v1/coins?limit=2')).json();
  assert.equal(c.coins.length, 2);
  assert.equal(c.coins[0].id, 'bitcoin');
  const one = await (await get('/v1/coins/bitcoin')).json();
  assert.ok(one.markets[0].api.startsWith('https://'));
  const sp = await (await get('/api/v3/simple/price?ids=bitcoin,reset&vs_currencies=usd&include_market_cap=true')).json();
  assert.ok(sp.bitcoin.usd > 0 && sp.reset.usd > 0 && sp.bitcoin.usd_market_cap > 0);
  const cg = await (await get('/api/v3/coins/markets?vs_currency=usd&per_page=1')).json();
  assert.equal(cg[0].market_cap_rank, 1);
});

test('MCP connector answers initialize, tools/list and tools/call', async () => {
  const call = body => fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' }, body: JSON.stringify(body) });
  const init = await (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.serverInfo.name, 'tradermarketcap');
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.ok(list.result.tools.some(t => t.name === 'get_prices'));
  const res = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_prices', arguments: { symbols: ['BTC', 'RESET'] } } })).json();
  assert.equal(res.result.structuredContent.coins.length, 2);
});

test('free tier is rate limited per visitor', async () => {
  let limited = false;
  for (let i = 0; i < 40; i++) if ((await get('/v1/global', { 'x-forwarded-for': '10.9.9.9' })).status === 429) limited = true;
  assert.ok(limited);
});

test('List your coin: request joins the public queue, contact stays private', async () => {
  const body = new URLSearchParams({ name: 'Test Coin', symbol: 'tst', chain: 'eth', contract: '0x' + '1'.repeat(40), trades: 'Uniswap', contact: 'me@example.com', wallets: '0x' + '2'.repeat(40) + ' - team' });
  const r = await fetch(BASE + '/list', { method: 'POST', body, headers: { 'x-forwarded-for': '10.2.2.2' } });
  assert.equal(r.status, 200);
  await new Promise(res => setTimeout(res, 50));
  const page = await (await fetch(BASE + '/list?x=' + Date.now(), { headers: { 'x-forwarded-for': '10.2.2.3' } })).text();
  assert.match(page, /Test Coin/);
  assert.match(page, /TST/);
  assert.doesNotMatch(page, /me@example\.com/);
  assert.equal((await fetch(BASE + '/listings.json')).status, 404);
  const missing = await fetch(BASE + '/list', { method: 'POST', body: new URLSearchParams({ name: 'No Contract', symbol: 'NC', contact: 'x' }), headers: { 'x-forwarded-for': '10.2.2.4' } });
  assert.equal(missing.status, 400);
});
