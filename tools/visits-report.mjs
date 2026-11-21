#!/usr/bin/env node
// Visitor numbers for TraderMarketCap from data/visits.jsonl (written by the web server).
//   node tools/visits-report.mjs            last hour, today (since midnight Central) and last 24 h
//   TMC_DATA=/var/lib/tradermarketcap node tools/visits-report.mjs
// People = page views from a browser (not a known bot, not part of a crawler burst); "confirmed" = their browser then ran
// the page's price refresh, which crawlers usually don't. Agents = API or MCP callers. Old links = /token/... and other
// pages from the old site that now show "Not found" (search engines still crawl them).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.TMC_DATA || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const F = join(DATA, 'visits.jsonl');
const rows = existsSync(F) ? readFileSync(F, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const now = Date.now() / 1000;
const ctMidnight = (() => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = k => +p.find(x => x.type === k).value; return now - (g('hour') * 3600 + g('minute') * 60); })();
const OLD = /^\/(token|vault|bot|bots|rank|ranking|leaderboard|wallet|tx|address)\b/;
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

// Crawlers that pretend to be browsers: many "different visitors" (rotating addresses) that each open one page,
// seconds apart. A run of 4+ such one-page visitors with gaps of 15 s or less is one crawler, not people.
const pageViews = rows.filter(x => x.k === 'page' && !x.b && !OLD.test(x.p));
const viewsBy = new Map(); for (const x of pageViews) viewsBy.set(x.v, (viewsBy.get(x.v) || 0) + 1);
const burst = new Set();
{ let run = [];
  const flush = () => { if (run.length >= 4) run.forEach(x => burst.add(x.v)); run = []; };
  for (const x of pageViews) {
    if (viewsBy.get(x.v) !== 1) { flush(); continue; }
    if (run.length && x.t - run[run.length - 1].t > 15) flush();
    run.push(x);
  }
  flush(); }
// A real browser on a page with prices asks /v1/prices every 15 s (logged as k=self). Visitors who did are "confirmed".
const selfBy = new Map(); for (const x of rows) if (x.k === 'self') (selfBy.get(x.v) || selfBy.set(x.v, []).get(x.v)).push(x.t);
const confirmedView = x => (selfBy.get(x.v) || []).some(t => t >= x.t - 5 && t <= x.t + 120);

function sum(from) {
  const r = rows.filter(x => x.t >= from), people = new Set(), confirmed = new Set(), crawl = new Set(), agents = new Set(), bots = new Set(), refs = new Map(), pages = new Map();
  let views = 0, calls = 0, old = 0;
  for (const x of r) {
    if (x.k === 'page' && OLD.test(x.p)) { old++; continue; }
    if (x.k === 'page' && !x.b && burst.has(x.v)) { crawl.add(x.v); continue; }
    if (x.k === 'page' && !x.b) { views++; people.add(x.v); if (confirmedView(x)) confirmed.add(x.v); if (x.r) refs.set(x.r, (refs.get(x.r) || 0) + 1);
      const pg = x.p.startsWith('/coin/') ? '/coin/*' : x.p; pages.set(pg, (pages.get(pg) || 0) + 1); }
    else if (x.k === 'api' || x.k === 'mcp' || x.k === 'llms') { calls++; agents.add(x.v); }
    else if (x.b) bots.add(x.v);
  }
  return `${people.size} people (${confirmed.size} confirmed by their browser, ${views} page views), ${agents.size} agents/apps (${calls} API/MCP calls), ${bots.size} bots + ${crawl.size} crawler-burst hits, ${old} old-link hits | from ${top(refs, 4)} | pages ${top(pages, 4)}`;
}
const first = rows.length ? new Date(rows[0].t * 1000).toISOString() : 'none';
console.log(`TMC hour: ${sum(now - 3600)}`);
console.log(`TMC today: ${sum(ctMidnight)}`);
console.log(`TMC 24h: ${sum(now - 86400)}`);
console.log(`TMC log since ${first}, ${rows.length} lines`);
