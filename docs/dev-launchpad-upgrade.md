# Dev note: launchpad upgrade (quote switch, approved pairs, emergency pause)

Status: built and tested on local chains. **Not deployed to Acrux Net.** The live
launchpad (`3qCdE6gN…`) still runs the previous build.

## What's in it

- **`set_quote(params)`** (admin): changes the default quote token and its curve
  parameters for future launches.
- **Approved pairs**: `set_pair(params, enabled)` (admin) approves a quote token a
  creator can pair a coin with, with its own curve parameters, in a `QuotePair`
  account at `["pair", mint]`. `create_launch` takes an optional `quote_pair`:
  given, the coin uses that pair's token and parameters; left out (`null`), it
  uses the default quote. Disabling a pair stops new coins only.
- **Each coin keeps its own quote**: buy, sell, `graduate` and `graduate_raydium`
  check a coin's quote token against its own curve account, not the config, so
  coins created before a quote change keep trading and graduating as before.
- **Emergency pause**: `set_paused(bool)` (admin) stops new launches, buys, sells
  and both graduations. The `Pause` account at `["pause"]` doesn't exist until
  the first `set_paused`, and a missing account means not paused, so the
  upgrade itself can't freeze anything.

No existing account layout changes (`Config`, `Launch` are unchanged); the new
accounts are separate PDAs.

## Clients must update with the program

`create_launch`, `buy`, `sell`, `graduate` and `graduate_raydium` now take a
`pause` account, and `create_launch` takes `quote_pair`. **The site build in
this repo is for the new program**: deploy the program first, then the site.
Anchor clients resolve `pause` automatically but must pass `quotePair: null`
for a default-quote launch.

## Going live, in order

1. Fund the deployer with real ACRUX (the bridge must accept deposits first).
2. Upgrade in place: the new binary is 589,152 bytes vs 540,952 live, so the
   program account is extended by about 48 KB first (rent, kept) and the upgrade
   buffer needs about 4.1 ACRUX while it's written (refunded).
3. Deploy the site from this repo (`scripts/deploy-web.sh`).
4. When Acrux has a wrapped ACRUX mint:
   `node --import tsx scripts/acrux-launchpad-set-quote.ts <wrapped ACRUX mint> --yes`
5. Optionally approve more pairs:
   `node --import tsx scripts/acrux-launchpad-admin.ts pair <mint> [--graduate N] --yes`
6. Reopen launches: set `LAUNCHES_PAUSED = null` in `web/src/net.ts` and deploy the site.

Emergency: `node --import tsx scripts/acrux-launchpad-admin.ts pause --yes`
(and `unpause`). `status` shows the default quote, pause state and pairs.

## Tested

Local chains (`npm run test:e2e`, `npm run test:e2e:raydium`): an old coin keeps
trading and graduating in its original quote after `set_quote`; paired coins take
the pair's parameters and trade in the pair token; unapproved, mismatched and
disabled pairs are refused; only the admin can switch, pair or pause; pause
blocks launch, buy and sell and unpausing restores them; AMM, bridge and Raydium
graduation suites still pass.
