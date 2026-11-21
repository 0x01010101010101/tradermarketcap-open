#!/usr/bin/env node
// Local MCP bridge for AI apps that only speak stdio (e.g. Claude Desktop config):
//   { "command": "node", "args": ["mcp/stdio.mjs"], "env": { "TMC_URL": "https://tradermarketcap.com", "TMC_KEY": "" } }
// Every JSON-RPC line from stdin is sent to <TMC_URL>/mcp and the answer is written to stdout.
import { createInterface } from 'node:readline';

const BASE = (process.env.TMC_URL || 'https://tradermarketcap.com').replace(/\/$/, '');
const KEY = process.env.TMC_KEY || '';

const rl = createInterface({ input: process.stdin });
rl.on('line', async line => {
  if (!line.trim()) return;
  let id = null;
  try { id = JSON.parse(line).id ?? null; } catch { /* the server reports the parse error */ }
  try {
    const r = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(KEY ? { 'x-tmc-key': KEY } : {}) },
      body: line,
    });
    if (r.status === 202) return;
    process.stdout.write((await r.text()).trim() + '\n');
  } catch (e) {
    if (id !== null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'TraderMarketCap unreachable: ' + e.message } }) + '\n');
  }
});
