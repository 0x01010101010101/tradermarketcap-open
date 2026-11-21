// Coin names and contract addresses, straight from the exchanges' own public currency lists.
// No listing service involved. Refreshed every few hours.
import { getJSON } from '../../src/util.mjs';

// exchange chain codes -> our chain ids
const CHAIN = {
  eth: 'eth', erc20: 'eth', bsc: 'bsc', bep20: 'bsc', base: 'base', baseevm: 'base', arbitrum: 'arbitrum', arbevm: 'arbitrum',
  avaxc: 'avax', avax_c: 'avax', sol: 'sol', trx: 'tron', trc20: 'tron', ton: 'ton', matic: 'polygon', polygon: 'polygon', optimism: 'optimism', opeth: 'optimism',
};

export async function coinInfo() {
  const info = new Map(); // SYMBOL -> { names: {coinbase, kucoin, gate}, contracts: [{chain, address, from}] }
  const get = s => { let x = info.get(s); if (!x) info.set(s, x = { names: {}, contracts: [] }); return x; };
  const add = (s, chain, address, from) => {
    const c = CHAIN[String(chain || '').toLowerCase()];
    if (!c || !address || address.length < 20) return;
    const x = get(s);
    if (!x.contracts.some(k => k.chain === c && k.address.toLowerCase() === address.toLowerCase())) x.contracts.push({ chain: c, address, from });
  };
  const jobs = [
    getJSON('https://api.exchange.coinbase.com/currencies', { timeout: 30000 }).then(d => {
      for (const c of d) if (c.details?.type === 'crypto' && c.name) get(c.id).names.coinbase = c.name;
    }),
    getJSON('https://api.kucoin.com/api/v3/currencies', { timeout: 30000 }).then(d => {
      for (const c of d.data) {
        if (c.fullName) get(c.currency).names.kucoin = c.fullName;
        for (const ch of c.chains || []) add(c.currency, ch.chainId, ch.contractAddress, 'kucoin');
      }
    }),
    getJSON('https://api.gateio.ws/api/v4/spot/currencies', { timeout: 30000 }).then(d => {
      for (const c of d) {
        if (c.delisted) continue;
        const s = c.currency.split('_')[0];
        if (c.name) get(s).names.gate = c.name;
        for (const ch of c.chains || []) add(s, ch.name, ch.addr, 'gate');
      }
    }),
  ];
  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  return { info, failed };
}

export const bestName = (sym, x) => x?.names.coinbase || x?.names.kucoin || x?.names.gate || sym;

export const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'coin';
