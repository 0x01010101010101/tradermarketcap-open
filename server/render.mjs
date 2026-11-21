// HTML pages. Plain server-rendered HTML (fast, cache-friendly, readable by search engines and bots).
// Kept simple on purpose: few words, obvious buttons, every number links to where it came from.
import { esc, usd, big, count, pct, host } from './format.mjs';
import { ctTime, ctDateTime, ctDate } from '../src/util.mjs';
import { OUTLIER, THIN_USD } from '../collector/aggregate.mjs';

export const SITE = process.env.TMC_SITE || 'https://tradermarketcap.com';
const PAGE_SIZE = 100;

function layout(S, { title, desc, path, body, nav = '' }) {
  const t = title ? `${title} · TraderMarketCap` : 'TraderMarketCap: crypto prices you can check';
  const g = S.snap?.global || {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t)}</title><meta name="description" content="${esc(desc || 'Crypto prices, market caps and volume. Every number links to its source. Free API for people and bots.')}">
<link rel="canonical" href="${SITE}${esc(path)}"><link rel="stylesheet" href="/static/style.css?v=4"><link rel="icon" href="/static/logo.svg">
<link rel="alternate" type="text/plain" title="llms.txt" href="/llms.txt"></head><body>
<header><a class="logo" href="/">Trader<span>MarketCap</span></a>
<nav>${[['/', 'Coins', 'home'], ['/exchanges', 'Exchanges', 'exchanges'], ['/new', 'New', 'new'], ['/hotlist', 'Hot List', 'hotlist'], ['/list', 'List your coin', 'list'], ['/about', 'About', 'about']]
    .map(([h, l, k]) => `<a href="${h}"${nav === k ? ' class="on"' : ''}>${l}</a>`).join('')}</nav>
<form class="search" action="/search"><input name="q" placeholder="Search coin" aria-label="Search coin" autocomplete="off"></form>
<a class="btn" href="/api">Free API</a></header>
<div class="strip"><span>Market cap, checked coins <a href="/about#formula"><b>${big(g.mcap)}</b></a></span><span>Volume 24h <a href="/exchanges"><b>${big(g.vol)}</b></a></span>
${g.ranked >= 100 && g.btcDominance ? `<span>BTC share <b>${g.btcDominance.toFixed(1)}%</b></span>` : ''}<span>Coins <b>${count(g.coins)}</b></span><span>Supply checked <b>${count(g.ranked)}</b></span>
<span>Updated <b id="clock" data-at="${S.snap?.at || ''}">${S.snap ? ctTime(S.snap.at) : '—'}</b> CT</span></div>
<main>${body}</main>
<footer><a href="/about">About</a><a href="/about#formula">How we rank</a><a href="/api">API</a><a href="/llms.txt">llms.txt</a><a href="/hotlist#advertise">Advertise</a><span>Times in Central Time (CT)</span></footer>
<script src="/static/app.js?v=5" defer></script></body></html>`;
}

function adSlot(S, slot) {
  const ad = S.snap?.ads?.slots?.[slot];
  const live = ad && (!ad.until || Date.parse(ad.until) > Date.now());
  if (live) return `<div class="ad"><span class="adtag">Ad</span><a href="${esc(ad.url)}" rel="sponsored noopener" target="_blank">${ad.img ? `<img src="${esc(ad.img)}" alt="${esc(ad.alt || 'Ad')}">` : esc(ad.alt || ad.url)}</a></div>`;
  return `<div class="ad"><span class="adtag">Ad</span><a href="/hotlist#advertise">Advertise here</a></div>`;
}

function hotList(S) {
  const spots = S.snap?.hotlist || [];
  const cells = [];
  for (const s of spots) {
    const a = S.byId.get(s.asset);
    if (!a) continue;
    cells.push(`<a class="hc" href="/coin/${esc(a.id)}"><b>${esc(a.name)}</b> <span class="sym">${esc(a.symbol)}</span><br>${pct(a.change24h)} · <span data-p="${esc(a.id)}">${usd(a.price)}</span></a>`);
  }
  while (cells.length < 5) cells.push(`<a class="hc open" href="/hotlist">Spot open<br><span class="sym">from $99 / day</span></a>`);
  return `<section class="hot"><div class="hothead"><b>🔥 HOT LIST</b><a class="book" href="/hotlist">Get your coin here →</a></div><div class="hotrow">${cells.join('')}</div></section>`;
}

function coinCell(a) {
  return `<a href="/coin/${esc(a.id)}" class="coin"><b>${esc(a.name)}</b> <span class="sym">${esc(a.symbol)}</span></a>${a.tags.includes('thin') ? ' <span class="tag thin" title="Less than $10k traded in 24h">thin</span>' : ''}`;
}

function coinRows(list) {
  return list.map(a => `<tr><td class="grey">${a.rank ?? '—'}</td><td>${coinCell(a)}</td>
<td><a href="/coin/${esc(a.id)}#markets" data-p="${esc(a.id)}">${usd(a.price)}</a></td><td data-c="${esc(a.id)}">${pct(a.change24h)}</td><td class="hide-s">${pct(a.change7d)}</td>
<td><a href="/coin/${esc(a.id)}#supply">${big(a.mcap)}</a></td><td class="hide-s"><a href="/coin/${esc(a.id)}#markets">${big(a.vol)}</a></td></tr>`).join('');
}

const TABLE_HEAD = '<tr><th>#</th><th>Coin</th><th>Price</th><th>24h</th><th class="hide-s">7d</th><th>Market cap</th><th class="hide-s">Volume 24h</th></tr>';

export function home(S, q) {
  const group = q.get('chain') || 'all';
  const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
  let list = S.snap.assets.filter(a => a.class === 'crypto');
  if (group !== 'all') list = list.filter(a => a.chains.includes(group));
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const shown = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const classTabs = S.snap.classes.map(c => c.live ? `<span class="on">${c.label}</span>` : `<span class="soon" title="${esc(c.note)}">${c.label} · ${c.from}</span>`).join('');
  const groupTabs = S.snap.groups.map(g => `<a href="${g.id === 'all' ? '/' : '/?chain=' + g.id}"${g.id === group ? ' class="on"' : ''}>${g.label}</a>`).join('');
  const link = p => `/?${group !== 'all' ? 'chain=' + group + '&' : ''}page=${p}`;
  const pager = pages > 1 ? `<div class="pager">${page > 1 ? `<a class="btn ghost" href="${link(page - 1)}">← Back</a>` : ''}<span>Page ${page} of ${pages}</span>${page < pages ? `<a class="btn ghost" href="${link(page + 1)}">More →</a>` : ''}</div>` : '';
  const body = `${hotList(S)}
<div class="tabs">${classTabs}</div><div class="tabs">${groupTabs}</div>
<div class="wrap"><table class="list">${TABLE_HEAD}${coinRows(shown)}</table></div>${pager}
${adSlot(S, 'home')}
<p class="small">Ranked by market cap. Nobody pays to rank. <a href="/about#formula">How we rank</a></p>`;
  return layout(S, { path: group === 'all' && page === 1 ? '/' : link(page), body, nav: 'home' });
}

function chart(S, id) {
  const h = S.history(id);
  const pts = (h?.h?.length >= 6 ? h.h : h?.d || []).filter(p => p[1] > 0);
  if (pts.length < 2) return '<div class="chart empty">Chart starts after a few hours of data</div>';
  const t0 = pts[0][0], t1 = pts.at(-1)[0], lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1]));
  const xy = pts.map(p => `${(((p[0] - t0) / (t1 - t0 || 1)) * 400).toFixed(1)},${(95 - ((p[1] - lo) / (hi - lo || 1)) * 90).toFixed(1)}`).join(' ');
  const up = pts.at(-1)[1] >= pts[0][1];
  return `<div class="chart"><svg viewBox="0 0 400 100" preserveAspectRatio="none" role="img" aria-label="Price chart"><polyline fill="none" stroke="${up ? '#7fe0a0' : '#ff8a7a'}" stroke-width="2" vector-effect="non-scaling-stroke" points="${xy}"/></svg>
<div class="chartnote">${ctDate(t0)} – ${ctDate(t1)} · low ${usd(lo)} · high ${usd(hi)}</div></div>`;
}

const EXPLORERS = { eth: 'https://etherscan.io/token/', bsc: 'https://bscscan.com/token/', base: 'https://basescan.org/token/', arbitrum: 'https://arbiscan.io/token/',
  avax: 'https://snowtrace.io/token/', polygon: 'https://polygonscan.com/token/', optimism: 'https://optimistic.etherscan.io/token/',
  sol: 'https://solscan.io/token/', tron: 'https://tronscan.org/#/token20/', ton: 'https://tonviewer.com/' };
const contractLink = c => (EXPLORERS[c.chain] || 'https://blockscan.com/address/') + c.address;

export function coin(S, id) {
  const a = S.byId.get(id);
  if (!a) return null;
  const ms = S.markets[id] || [];
  const sup = a.supply || {};
  const rows = ms.map(m => `<tr${m.ignored ? ' class="ignored" title="Price too far from the others, not counted"' : ''}><td>${m.trade ? `<a href="${esc(m.trade)}" rel="nofollow noopener" target="_blank">${esc(m.venueName)}</a>` : esc(m.venueName)}</td>
<td>${esc(m.pair)}</td><td>${usd(m.price)}</td><td>${big(m.vol)}</td><td class="hide-s">${m.ignored ? 'not counted' : pct(m.change24h)}</td><td><a href="${esc(m.api)}" rel="nofollow noopener" target="_blank">check ↗</a></td></tr>`).join('');
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const src = sup.src ? ` <a class="src" href="${esc(sup.src)}" rel="nofollow noopener" target="_blank">${esc(host(sup.src))} ↗</a>` : '';
  const trade = ms.find(m => !m.ignored && m.trade);
  const body = `<div class="grid"><div>
<h1>${esc(a.name)} <span class="sym">${esc(a.symbol)}</span>${a.rank ? ` <span class="rank">#${a.rank}</span>` : ''}</h1>
<div class="big"><a href="#markets" data-p="${esc(a.id)}">${usd(a.price)}</a> <span class="ch" data-c="${esc(a.id)}">${pct(a.change24h)}</span></div>
${chart(S, id)}
<h2 id="markets">Where to trade</h2>
<p class="small">Price = average of these markets, weighted by volume. Markets more than ${OUTLIER * 100}% off are shown but not counted.</p>
<div class="wrap"><table><tr><th>Exchange</th><th>Pair</th><th>Price</th><th>Volume 24h</th><th class="hide-s">24h</th><th>Source</th></tr>${rows}</table></div>
</div><aside>
<div class="card" id="supply"><h3>Numbers</h3>
${kv('Market cap', big(a.mcap))}
${kv('Volume 24h', `<a href="#markets">${big(a.vol)}</a>`)}
${sup.checked ? `${kv('Circulating', count(sup.circulating) + src)}
${kv('Total supply', count(sup.total))}
${kv('Max supply', sup.max ? count(sup.max) : '—')}
${(sup.parts || []).length > 1 ? sup.parts.map(p => kv(`· on ${esc(p.chain)}`, `${count(p.amount)} <a class="src" href="${esc(p.src)}" rel="nofollow noopener" target="_blank">↗</a>`)).join('') : ''}
${(sup.excluded || []).map(e => kv(`− ${esc(e.reason)}`, `${count(e.amount)} <a class="src" href="${esc(e.src)}" rel="nofollow noopener" target="_blank">↗</a>`)).join('')}
${sup.note ? `<p class="small">${esc(sup.note)}</p>` : ''}
<p class="small">Read from the chain ${sup.at ? 'at ' + esc(ctTime(sup.at)) + ' CT' : ''}.</p>`
    : `<p class="small">Supply not checked yet, so no market cap or rank.</p><a class="btn ghost" href="/list?coin=${esc(a.id)}">Your project? Send supply details</a>`}
</div>
${(a.contracts || []).length && (!sup.checked || sup.method === 'tokens') ? `<div class="card"><h3>Contracts</h3>${a.contracts.slice(0, 6).map(c => kv(esc(c.chain), `<a class="src" href="${esc(contractLink(c))}" rel="nofollow noopener" target="_blank">${esc(c.address.slice(0, 6))}…${esc(c.address.slice(-4))} ↗</a>`)).join('')}<p class="small">As listed by the exchanges.</p></div>` : ''}
${a.tags.includes('thin') ? `<div class="card"><h3>Note</h3><p class="small">Thin market: less than ${big(THIN_USD)} traded in 24h. Prices can jump.</p></div>` : ''}
${trade ? `<a class="btn wide" href="${esc(trade.trade)}" rel="nofollow noopener" target="_blank">Trade ${esc(a.symbol)}</a>` : ''}
${adSlot(S, 'coin')}
</aside></div>`;
  return layout(S, { title: `${a.name} (${a.symbol}) price`, desc: `${a.name} price ${usd(a.price)}, market cap ${big(a.mcap)}. Every number links to its source.`, path: '/coin/' + id, body });
}

export function exchanges(S) {
  const rows = S.snap.venues.map((v, i) => `<tr><td class="grey">${i + 1}</td><td>${v.site ? `<a href="${esc(v.site)}" rel="nofollow noopener" target="_blank">${esc(v.name)}</a>` : esc(v.name)}</td><td>${big(v.volUsd)}</td><td>${v.markets}</td><td class="hide-s">${esc(v.type || '')}</td></tr>`).join('');
  const body = `<h2>Exchanges</h2><p class="small">Volume of the markets we track, in the last 24 hours.</p>
<div class="wrap"><table><tr><th>#</th><th>Exchange</th><th>Volume 24h</th><th>Markets</th><th class="hide-s">Type</th></tr>${rows}</table></div>`;
  return layout(S, { title: 'Exchanges', path: '/exchanges', body, nav: 'exchanges' });
}

export function newCoins(S) {
  const since = S.snap.firstSeenAt || 0;
  const list = S.snap.assets.filter(a => Date.parse(a.addedAt) > since + 3600e3).sort((x, y) => Date.parse(y.addedAt) - Date.parse(x.addedAt)).slice(0, 100);
  const rows = list.map(a => `<tr><td class="grey">${esc(ctDateTime(Date.parse(a.addedAt)))}</td><td>${coinCell(a)}</td><td><a href="/coin/${esc(a.id)}#markets">${usd(a.price)}</a></td><td><a href="/coin/${esc(a.id)}#markets">${big(a.vol)}</a></td></tr>`).join('');
  const body = `<h2>New coins</h2><p class="small">Listing is free. Coins show up here when they join the list. <a href="/list">List your coin →</a></p>
${list.length ? `<div class="wrap"><table><tr><th>Added</th><th>Coin</th><th>Price</th><th>Volume 24h</th></tr>${rows}</table></div>` : '<p class="card">No new coins yet. Check back soon.</p>'}`;
  return layout(S, { title: 'New coins', path: '/new', body, nav: 'new' });
}

const form = (kind, fields) => `<form class="card form" method="post" action="/request">
<input type="hidden" name="kind" value="${kind}"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
${fields}<label>How to reach you<input name="contact" required maxlength="200" placeholder="Email, Telegram or X"></label>
<button class="btn" type="submit">Send</button></form>`;

export const LIST_CHAINS = [['eth', 'Ethereum'], ['bsc', 'BNB Chain'], ['base', 'Base'], ['arbitrum', 'Arbitrum'], ['avax', 'Avalanche'], ['sol', 'Solana'], ['tron', 'Tron'], ['trac', 'Trac / TAP'], ['other', 'Other']];

export function listPage(S, listings, q) {
  const pre = q.get('coin') ? S.byId.get(q.get('coin')) : null;
  const status = { pending: 'Checking', approved: 'Listed', rejected: 'Not listed' };
  const rows = listings.slice().reverse().slice(0, 50).map(l => `<tr><td class="grey">${esc(ctDate(Date.parse(l.at)))}</td><td>${l.status === 'approved' && l.coinId ? `<a href="/coin/${esc(l.coinId)}">${esc(l.name)}</a>` : esc(l.name)} <span class="sym">${esc(l.symbol)}</span></td><td>${status[l.status] || esc(l.status)}</td><td class="hide-s small">${esc(l.reason || '')}</td></tr>`).join('');
  const chains = LIST_CHAINS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  const body = `<h2>List your coin</h2>
<p class="text">Free. We read your supply from the chain and check that the coin trades. Proven scams are not listed.</p>
<form class="card form wideform" method="post" action="/list">
<input class="hp" name="website2" tabindex="-1" autocomplete="off" aria-hidden="true">
<label>Coin name<input name="name" required maxlength="80" value="${esc(pre?.name || '')}"></label>
<label>Symbol<input name="symbol" required maxlength="20" value="${esc(pre?.symbol || '')}"></label>
<label>Chain<select name="chain">${chains}</select></label>
<label>Contract address<input name="contract" required maxlength="120" placeholder="0x… or mint address"></label>
<label>Where it trades<input name="trades" required maxlength="300" placeholder="Exchange names, or a DEX pool address"></label>
<label>Wallets that are not circulating<textarea name="wallets" rows="4" maxlength="3000" placeholder="One per line: address – reason (team, treasury, locked until …)"></textarea></label>
<label>Website<input name="site" maxlength="200" placeholder="https://"></label>
<label>X or Telegram<input name="social" maxlength="200"></label>
<label>How to reach you<input name="contact" required maxlength="200" placeholder="Email, Telegram or X"></label>
<button class="btn" type="submit">Send for listing</button></form>
<h2>Listing queue</h2>
${rows ? `<div class="wrap"><table><tr><th>Sent</th><th>Coin</th><th>Status</th><th class="hide-s">Note</th></tr>${rows}</table></div>` : '<p class="small">No requests yet.</p>'}`;
  return layout(S, { title: 'List your coin', path: '/list', body, nav: 'list' });
}

export function hotlistPage(S) {
  const body = `<h2>🔥 HOT LIST</h2>
<p class="text">5 spots at the top of the home page. Proven scams can't book.</p>
<div class="plans"><div class="card plan">1 day<b>$99</b></div><div class="card plan">1 week<b>$499</b></div><div class="card plan">1 month<b>$1,500</b></div></div>
${form('hotlist', `<label>Coin<input name="coin" required maxlength="100" placeholder="Name or contract address"></label>
<label>How long<select name="length"><option>1 day</option><option>1 week</option><option>1 month</option></select></label>`)}
<h2 id="advertise">Advertise</h2><p class="text">Banner spots on the home page and coin pages. Every ad is marked "Ad".</p>
${form('ad', `<label>Company or project<input name="coin" required maxlength="100"></label>`)}`;
  return layout(S, { title: 'Hot List and ads', path: '/hotlist', body, nav: 'hotlist' });
}

export function apiPage(S) {
  const body = `<h2>API for people and bots</h2>
<div class="plans">
<div class="card plan">Free<b>$0</b><span class="small">30 calls/min · no key needed</span></div>
<div class="card plan">Pro<b>$19/mo</b><span class="small">300 calls/min</span></div>
<div class="card plan">Business<b>$99/mo</b><span class="small">1,500 calls/min · bulk data</span></div></div>
<pre>GET ${SITE}/v1/coins?limit=100
GET ${SITE}/v1/coins/bitcoin
GET ${SITE}/v1/prices
GET ${SITE}/v1/hotlist</pre>
<p class="text">Works like CoinGecko: <code>/api/v3/simple/price</code>, <code>/api/v3/coins/markets</code>. Switch by changing one URL.</p>
<p class="text">AI agents: MCP connector at <code>${SITE}/mcp</code>, or read <a href="/llms.txt">/llms.txt</a>.</p>
${form('api', `<label>Plan<select name="length"><option>Pro</option><option>Business</option></select></label>`)}`;
  return layout(S, { title: 'API', path: '/api', body });
}

export function about(S) {
  const body = `<div class="text"><h2>About</h2>
<p>We are here to make crypto trading better and more honest.</p>
<h2>Our rules</h2><ul>
<li>Ranks come from data only. Nobody pays to rank.</li>
<li>Every coin can list for free. Proven scams cannot.</li>
<li>Every exchange and coin uses the same formula. No exceptions.</li>
<li>The Hot List and ads sit outside the ranking. Ads are marked "Ad".</li>
<li>Every number links to where it came from.</li></ul>
<h2 id="formula">How we rank</h2><ul>
<li><b>Price</b> = average price across the markets we read, weighted by 24h volume. A market more than ${OUTLIER * 100}% off the middle price is shown but not counted.</li>
<li><b>Market cap</b> = price × circulating supply. We read supply from the chain ourselves. Wallets that are not circulating (team, treasury, locked, burned) are shown on each coin page with a link.</li>
<li><b>Rank</b> = market cap, largest first. Coins whose supply we have not checked yet show price and volume, but no rank.</li>
<li><b>Which coins</b>: every coin with at least $100k traded in 24h on more than one of our exchanges (or on Coinbase or Kraken), plus coins listed through <a href="/list">List your coin</a>.</li>
<li><b>Thin</b> = less than ${big(THIN_USD)} traded in 24h.</li>
<li>Prices refresh every ${S.snap?.tickSeconds || 10} seconds.</li></ul>
<p class="small">Machine-readable: <a href="/rules.json">/rules.json</a> · full data: <a href="/dump/latest.json">/dump/latest.json</a></p>
<h2>Sources</h2><p class="small">Exchanges: Coinbase, Kraken, OKX, KuCoin, Gate, MEXC, Binance.US. DEXs: Trac DEX, Uniswap. Supply: the chains themselves (nodes, contracts and chain explorers). Names and contracts: the exchanges' own lists. No other listing site.</p>
${(S.snap?.blocked || []).length ? `<h2>Not listed</h2><p class="small">Proven scams, with proof:</p><ul>${S.snap.blocked.map(b => `<li>${esc(b.name || b.id)} — <a href="${esc(b.proof)}" rel="nofollow noopener" target="_blank">proof</a></li>`).join('')}</ul>` : ''}
</div>`;
  return layout(S, { title: 'About and how we rank', path: '/about', body, nav: 'about' });
}

export function search(S, q) {
  const term = (q.get('q') || '').trim().toLowerCase().slice(0, 60);
  const list = term ? S.snap.assets.filter(a => a.symbol.toLowerCase() === term || a.name.toLowerCase().includes(term) || a.id.includes(term)).slice(0, 50) : [];
  if (list.length === 1) return { redirect: '/coin/' + list[0].id };
  const body = `<h2>Search: ${esc(term)}</h2>${list.length ? `<div class="wrap"><table class="list">${TABLE_HEAD}${coinRows(list)}</table></div>` : '<p class="card">Nothing found.</p>'}`;
  return layout(S, { title: 'Search', path: '/search', body });
}

export function message(S, title, text, status = 200) {
  return { status, html: layout(S, { title, path: '/', body: `<div class="card msg"><h2>${esc(title)}</h2><p>${esc(text)}</p><a class="btn" href="/">Back to coins</a></div>` }) };
}

export function notReady() {
  return `<!doctype html><meta charset="utf-8"><title>TraderMarketCap</title><body style="background:#0b1117;color:#e9f1f8;font-family:system-ui;padding:40px">Loading prices… try again in a few seconds.</body>`;
}
