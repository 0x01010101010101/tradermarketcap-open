// Optional extra market feeds (any venue that publishes CoinGecko-style /tickers and /supply).
// Off unless TMC_EXTRA_FEEDS is set. Extra venues get exactly the same treatment as every other venue.
import { getJSON, n } from '../../src/util.mjs';

export const EXTRA_FEEDS = process.env.TMC_EXTRA_FEEDS || '';
export const EXTRA_VENUE = {};
export const EXTRA_ASSET = null;
export async function extraMarkets() { return []; }
export async function extraSupply() { return null; }
