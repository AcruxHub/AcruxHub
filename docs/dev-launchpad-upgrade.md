# Dev note: launchpad upgrade (quote switch, approved pairs, pair keeper, emergency pause)

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
- **Pair approver role**: `set_pair_approver(key)` (admin) names one key that
  may call `set_pair` and nothing else. For that key the program forces the fee,
  fee recipient and supplies to the default config's; it only chooses the quote
  amounts. `Pubkey::default()` revokes it. This is the key the pair keeper uses,
  so the admin key never has to live on a server.
- **Pair keeper** (`scripts/pair-keeper.ts`, rules in `scripts/pair-rules.ts`):
  approves a token once its AcruxHub and Raydium pools against the default quote
  have held at least PAIR_MIN_LIQUIDITY (default 2,000 whole quote tokens, counted
  as 2 x the quote side) for PAIR_SUSTAIN_HOURS (default 24), if its supply is
  fixed, it has no freeze authority and it's a classic SPL token. Its curve is set
  to be worth the same as the default one at the pool price. It disables pairs it
  approved after liquidity stays under PAIR_DELIST_LIQUIDITY (default 1,000) for
  the same time, never touches pairs the admin set by hand, and caps itself at
  PAIR_MAX_PAIRS (default 20). Hosted by `.github/workflows/pair-keeper.yml`
  (off until `PAIR_KEEPER_ENABLED`), with state and a public log on the
  `keeper-log` branch.
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
2. **Deploy the site first** (`scripts/deploy-web.sh`). It picks the IDL by program
   size (`UPGRADED_BYTES` = 633,168 in web/src/launchpad.ts), so until the upgrade
   lands it keeps using the live v1. An older site build would mistake the new
   program for the 608,560-byte one and send too few accounts, so it must not be
   live when the program upgrades.
3. Upgrade in place: the new binary is 633,168 bytes vs 540,952 live, so the
   program account is extended by about 92 KB first (rent, kept) and the upgrade
   buffer needs about 4.4 ACRUX while it's written (refunded). The site switches
   to the upgraded IDL by itself; hard-refresh to check.
4. When Acrux has a wrapped ACRUX mint:
   `node --import tsx scripts/acrux-launchpad-set-quote.ts <wrapped ACRUX mint> --yes`
5. Optionally approve more pairs:
   `node --import tsx scripts/acrux-launchpad-admin.ts pair <mint> [--graduate N] --yes`
6. Turn on the pair keeper: make `keys/acrux-pair-approver.json`, fund it with a
   little ACRUX, name it with
   `node --import tsx scripts/acrux-launchpad-admin.ts approver <its address> --yes`,
   then set the GitHub secret `PAIR_APPROVER_KEY` and variable `PAIR_KEEPER_ENABLED=true`.
   Tune the liquidity lines once real prices are known (they're in whole quote tokens).
7. Reopen launches: set `LAUNCHES_PAUSED = null` in `web/src/net.ts` and deploy the site.
8. Relaunch $HUB first, with the prepared metadata (AcruxHub pfp, tiers in the
   description):
   `https://xbj4dqltluuvxcew.public.blob.vercel-storage.com/metadata/0d4e01cf3e0d0e7834529086d5694d673ef244588b7edfc7cd77dac8f1e90631.json`
9. Holder tiers, once $HUB exists (defaults 1M / 5M / 10M HUB for 25 / 50 / 75% off):
   `node --import tsx scripts/acrux-launchpad-admin.ts tiers <HUB mint> --yes`
   Curve trades get the discount on chain; the site applies the same tiers to
   its 0.1% swap fee.
10. Fees to holders: from this machine (treasury key, never GitHub), after HUB has
    a Raydium pool:
    `node --import tsx scripts/hub-buyback.ts <HUB mint> <quote mint> [--reserve N] [--buyback 50]`
    dry-runs; add `--yes` to buy back and burn HUB and to add liquidity and burn the LP.

## Holder tiers

`set_holder_tiers` (admin only) stores up to 4 ascending tiers in the
`holder_tiers` PDA. `buy` and `sell` take two more accounts: the tiers PDA
(auto-resolved) and `holder_tokens`, the trader's platform-token account
(optional: pass `null` for none). The biggest tier the balance reaches cuts the
trade fee by its percentage; someone else's account, the wrong mint, or no tiers
set means no discount. All-zero tiers turn it off. A balance is read at trade
time, so someone could buy HUB just to trade cheaper, but that costs them the
HUB round trip.

Emergency: `node --import tsx scripts/acrux-launchpad-admin.ts pause --yes`
(and `unpause`). `status` shows the default quote, pause state and pairs.

## Tested

Local chains (`npm run test:e2e`, `npm run test:e2e:raydium`): an old coin keeps
trading and graduating in its original quote after `set_quote`; paired coins take
the pair's parameters and trade in the pair token; unapproved, mismatched and
disabled pairs are refused; only the admin can switch, pair or pause; pause
blocks launch, buy and sell and unpausing restores them; the approver can't change
fees, fee recipient or supply, strangers and a revoked approver are refused, and
a real keeper run approves a liquid fixed-supply token at value-equivalent
parameters while skipping an equally liquid freezable one (rules also unit-tested
in tests/pair-rules.test.ts); AMM, bridge and Raydium
graduation suites still pass.
