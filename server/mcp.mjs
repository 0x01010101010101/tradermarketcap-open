// MCP connector (Model Context Protocol), Streamable HTTP transport, stateless JSON responses.
// AI agents add https://tradermarketcap.com/mcp and get these tools. Same data and rate limits as the API.
import { coinOut, rules } from './api.mjs';

const PROTOCOL = '2025-06-18';
const SUPPORTED = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const TOOLS = [
  { name: 'get_prices', description: 'Current USD price, 24h change, market cap and volume for coins, by id (e.g. "bitcoin") or symbol (e.g. "BTC").',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, symbols: { type: 'array', items: { type: 'string' } } } } },
  { name: 'top_coins', description: 'Coins ranked by market cap. Optional chain filter (e.g. "trac").',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, offset: { type: 'integer', minimum: 0, default: 0 }, chain: { type: 'string' } } } },
  { name: 'get_coin', description: 'One coin with its markets. Every market has a public source URL to check the number.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'search_coins', description: 'Find coins by name, symbol or id.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'market_overview', description: 'Total crypto market cap, 24h volume, BTC share, number of coins, top exchanges.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'ranking_rules', description: 'How TraderMarketCap computes price, market cap and rank, and which coins are not listed and why.',
    inputSchema: { type: 'object', properties: {} } },
];

function callTool(S, name, args = {}) {
  const snap = S.snap;
  switch (name) {
    case 'get_prices': {
      const out = [];
      for (const id of args.ids || []) { const a = S.byId.get(String(id).toLowerCase()); if (a) out.push(coinOut(a)); }
      for (const s of args.symbols || []) { const a = S.bySymbol.get(String(s).toUpperCase()); if (a) out.push(coinOut(a)); }
      return { at: snap.at, coins: out };
    }
    case 'top_coins': {
      let list = snap.assets;
      if (args.chain) list = list.filter(a => a.chains.includes(args.chain));
      const off = Math.max(0, args.offset | 0), lim = Math.min(100, Math.max(1, args.limit | 0 || 20));
      return { at: snap.at, total: list.length, coins: list.slice(off, off + lim).map(a => coinOut(a)) };
    }
    case 'get_coin': {
      const a = S.byId.get(String(args.id || '').toLowerCase());
      if (!a) throw new Error('coin not found: ' + args.id);
      return { at: snap.at, ...coinOut(a), markets: (S.markets[a.id] || []).slice(0, 15) };
    }
    case 'search_coins': {
      const t = String(args.query || '').toLowerCase().trim();
      return { coins: snap.assets.filter(a => a.symbol.toLowerCase() === t || a.name.toLowerCase().includes(t) || a.id.includes(t)).slice(0, 20).map(a => coinOut(a)) };
    }
    case 'market_overview':
      return { at: snap.at, ...snap.global, top_exchanges: snap.venues.slice(0, 10).map(v => ({ name: v.name, volume_24h_usd: v.volUsd, markets: v.markets })) };
    case 'ranking_rules':
      return rules(S);
    default:
      throw Object.assign(new Error('unknown tool ' + name), { code: -32602 });
  }
}

function handle(S, msg) {
  const { id, method, params } = msg || {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'invalid request');
  if (id === undefined) return null; // notification (e.g. notifications/initialized): no reply
  switch (method) {
    case 'initialize': {
      const v = SUPPORTED.has(params?.protocolVersion) ? params.protocolVersion : PROTOCOL;
      return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tradermarketcap', title: 'TraderMarketCap', version: '0.1.0' },
        instructions: 'Crypto prices, market caps and volume. Every market includes a public source URL. Prices refresh every ~10 seconds.' });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      if (!S.snap) return reply({ isError: true, content: [{ type: 'text', text: 'data is loading, try again in a few seconds' }] });
      try {
        const data = callTool(S, params?.name, params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        if (e.code === -32602) return fail(-32602, e.message);
        return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
      }
    }
    default: return fail(-32601, 'method not found: ' + method);
  }
}

// body = parsed JSON (one message or a batch). Returns { status, body } where body may be null (202).
export function mcp(S, body) {
  if (Array.isArray(body)) {
    const out = body.map(m => handle(S, m)).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const r = handle(S, body);
  return r ? { status: 200, body: r } : { status: 202, body: null };
}
