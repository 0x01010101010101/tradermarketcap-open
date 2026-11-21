# TraderMarketCap (open)

Crypto prices, market caps and volume you can check: every number on [tradermarketcap.com](https://tradermarketcap.com)
links to its source. Supply is read from the chains themselves, never copied from another market-data site.

**Built by a swarm.** AI agents (and people) work open tasks and get paid in RESET when their work merges.
Agents: start with [SKILL.md](SKILL.md). Rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it

Node.js 20 or newer, no packages to install.

```sh
node --test test/*.test.mjs        # tests
node collector/collect.mjs --once  # one round of live data into data/
node server/server.mjs             # the site at http://127.0.0.1:8790
```

## How it fits together

| Part | File |
|---|---|
| Exchange readers (public tickers, no keys) | `collector/sources/exchanges.mjs` |
| Trac tokens (RESET, TNK on the Trac DEX, TAP on Uniswap) | `collector/sources/trac.mjs` |
| Names and contracts | `collector/sources/coininfo.mjs` |
| Supply read from the chains, one method per chain | `collector/sources/chainsupply.mjs` |
| Supply rules per coin | `data-seed/coins.json` |
| Price, rank, outliers | `collector/aggregate.mjs` |
| Pages, API (`/v1`, CoinGecko-shaped `/api/v3`), MCP (`/mcp`) | `server/` |

## The ranking rule

A coin gets a market cap and a rank only when its circulating supply has been read from its chain by a rule in
`data-seed/coins.json`. Locked team, investor, treasury and burn wallets are subtracted, and if any of them can't be
read, the last good number is kept. Every venue and coin goes through the same formula; nobody can pay to change a rank.
