import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const UA = 'TraderMarketCap/0.1 (+https://tradermarketcap.com/about)';

export async function getJSON(url, { timeout = 15000, method = 'GET', body, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method, body, signal: ctl.signal,
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp' + process.pid;
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  renameSync(tmp, path);
}

export function readJSON(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

export const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const n = x => {
  const v = typeof x === 'number' ? x : parseFloat(x);
  return isFinite(v) ? v : null;
};

// Central Time for everything the owner and visitors read.
const CT = 'America/Chicago';
export function ctTime(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' });
}
export function ctDateTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: CT, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}
export function ctDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { timeZone: CT, month: 'short', day: 'numeric', year: 'numeric' });
}
