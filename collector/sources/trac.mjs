// Trac ecosystem tokens: RESET, TNK, TAP. Read from their own markets and chains.
//   - Trac DEX (intercom-dex) public market view: RESET/USDC, TNK/USDC
//   - RESET supply: fixed emission, 3.125 RESET per Trac block since block 971558 (read the block from the Mine view)
//   - TAP: Uniswap v2 TAP/USDT pool reserves and Swap logs on Ethereum, supply from the token contract
import { getJSON, n } from '../../src/util.mjs';

export const DEX_VIEW = 'https://reset.much.fun/v1/market/view';
export const MINE_VIEW = 'https://reset.openmayhem.ai/v1/mine/view';
export const ETH_RPC = process.env.TMC_ETH_RPC || 'https://eth.drpc.org';

const TAP_TOKEN = '0x5e7F6e008C6d9D7AD4c7EB75Bd4ce62864cc7454';
const TAP_PAIR = '0x1563E9aF51616E78830de3325da752DE369C1714'; // token0 TAP (18), token1 USDT (6)
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

export const TRAC_VENUES = {
  tracdex: { name: 'Trac DEX', type: 'DEX', site: 'https://tractrader.com/trading-post/dex.html' },
  uniswap: { name: 'Uniswap v2', type: 'DEX', site: 'https://app.uniswap.org' },
};

// The Trac tokens themselves (ids, supply rules, which markets count) live in data-seed/coins.json.

async function rpc(method, params) {
  const r = await getJSON(ETH_RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.error) throw new Error('eth rpc: ' + JSON.stringify(r.error));
  return r.result;
}
const word = (hex, i) => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));

export async function tracDex() {
  const v = await getJSON(DEX_VIEW);
  return (v.pairs || []).filter(p => p.status !== 'closed').map(p => {
    const [base, quote] = p.pair.split('/');
    return {
      venue: 'tracdex', base, quote, price: n(p.last), volBase: null, volQuote: n(p.volume24h) ?? 0,
      change24h: n(p.change24h) != null ? n(p.change24h) * 100 : null,
      api: DEX_VIEW, trade: 'https://tractrader.com/trading-post/dex.html',
    };
  });
}

export async function resetSupply() {
  const v = await getJSON(MINE_VIEW);
  const block = n(v.counted);
  if (!block) return null;
  const circ = (block - 971558) * 3.125;
  return { circulating: circ, total: circ, max: null, src: MINE_VIEW, note: '3.125 RESET per Trac block, no cap' };
}

// 24h volume from the pool's Swap logs. The free RPC allows only ~100 blocks per log query, so we scan
// forward in 100-block steps and keep a rolling 24h list (about 7,200 blocks a day).
const DAY_BLOCKS = 7200, STEP = 100;
const tapVol = { scanned: 0, swaps: [], usd: null, busy: false, at: 0 };
async function scanTapSwaps() {
  if (tapVol.busy || Date.now() - tapVol.at < 60e3) return;
  tapVol.busy = true;
  try {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    let from = Math.max(tapVol.scanned + 1, head - DAY_BLOCKS);
    for (let calls = 0; from <= head && calls < 80; calls++) {
      const to = Math.min(from + STEP - 1, head);
      const logs = await rpc('eth_getLogs', [{ address: TAP_PAIR, topics: [SWAP_TOPIC], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      for (const l of logs) tapVol.swaps.push([parseInt(l.blockNumber, 16), (Number(word(l.data, 1)) + Number(word(l.data, 3))) / 1e6]); // USDT in + out
      tapVol.scanned = to;
      from = to + 1;
    }
    tapVol.swaps = tapVol.swaps.filter(s => s[0] > head - DAY_BLOCKS);
    if (tapVol.scanned >= head - STEP) tapVol.usd = tapVol.swaps.reduce((s, x) => s + x[1], 0); // only once the day is fully scanned
  } catch { /* try again next minute */ } finally {
    tapVol.busy = false;
    tapVol.at = Date.now();
  }
}

export async function tapUniswap() {
  const res = await rpc('eth_call', [{ to: TAP_PAIR, data: '0x0902f1ac' }, 'latest']);
  const tap = Number(word(res, 0)) / 1e18, usdt = Number(word(res, 1)) / 1e6;
  const price = usdt / tap;
  scanTapSwaps(); // runs in the background
  return [{
    venue: 'uniswap', base: 'TAP', quote: 'USDT', price, volBase: null, volQuote: tapVol.usd,
    change24h: null, depthUsd: usdt * 2,
    api: `https://etherscan.io/address/${TAP_PAIR}#readContract`,
    trade: `https://app.uniswap.org/swap?outputCurrency=${TAP_TOKEN}&chain=mainnet`,
  }];
}

export async function tapSupply() {
  const res = await rpc('eth_call', [{ to: TAP_TOKEN, data: '0x18160ddd' }, 'latest']);
  const total = Number(BigInt(res)) / 1e18;
  return { circulating: total, total, max: null, src: `https://etherscan.io/token/${TAP_TOKEN}` };
}
