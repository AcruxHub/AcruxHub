# Dev note: graduating into a Raydium CPMM pool

Status: LIVE on Acrux Net since 2026-11-19 (in-place upgrade of `3qCdE6gN…`, slot 2,058,374; it cost 0.508 test ACRUX). Checked live with `scripts/acrux-graduate-raydium-check.ts`: a test coin (GRADT) graduated into Raydium pool `8CSthJ87Dg7vVFDBMcPbWbMJ7xmdCX3YTMdzScjYCqNr` at the curve's final price, all LP burned, graduator left empty, caller charged exactly the 0.15 fee + 0.04011744 rent + tx fee. On Acrux it used 251,747 compute units, so send it with a 300k+ limit.

## What changes

The launchpad gets a second graduation instruction, `graduate_raydium`. The old
`graduate` (AcruxHub AMM) stays as it is. Once a curve is complete, either one
may be called, permissionlessly; the first one to land graduates the launch and
the other then fails with `NotComplete`.

`graduate_raydium` uses the same amounts as `graduate`: all of `real_quote`, and
`tokens_for_pool(real_quote)` tokens (the curve's final price). It burns the
leftover tokens and, like `graduate`, burns every LP token, so the liquidity is
locked forever.

## Why a new instruction, not a flag

- No account layout changes. `Launch` and `Config` stay byte-for-byte the same,
  so an upgrade needs no migration and every existing launch (open, complete or
  graduated) keeps working.
- `graduate`'s accounts and arguments stay the same, so the site, the SDK and
  old clients keep working unchanged.
- `Launch.pool` holds the pool address either way. Which venue it is can be
  read from the pool account's owner (the AcruxHub AMM or Raydium CPMM). The new
  instruction emits a separate `GraduatedRaydium` event so the old `Graduated`
  event decodes as before.

## Who pays what

Raydium's `initialize` needs one `creator` account that does three things:

1. signs as the owner of the two token accounts it pulls the deposit from,
2. pays rent for the pool, LP mint, vaults, observation and LP ATA (Anchor
   `init`, so `system_program::create_account` from it),
3. pays the 0.15 ACRUX creation fee with a `system_program::transfer` to
   `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` (then `sync_native`).

The launch PDA can sign but holds data, so the System program will not move
lamports out of it. So the creator is a new PDA of the launchpad:

    graduator = PDA(["graduator", mint])   (system-owned, never holds data)

The instruction:

1. The caller (`payer`, anyone) sends the graduator `create_pool_fee` (read from
   the chosen fee tier) plus the rent for every account Raydium creates, plus a
   margin.
2. Anchor creates the graduator's token ATA and quote ATA (caller pays).
3. The launch PDA moves the pool amounts from the curve accounts into them.
4. CPI `initialize` with `creator = graduator`, signed with the graduator seeds.
   `open_time = 0` (Raydium opens it one second later).
5. The graduator burns all its LP and closes its LP ATA (rent to the caller).
6. It closes its two token ATAs (rent to the caller), skipping one only if
   someone dusted it, so a dusting cannot block graduation.
7. It sends all its remaining lamports back to the caller. It ends at 0
   lamports, so it never sits rent-paying.
8. The launch PDA burns the leftover tokens; the launch is marked graduated.

Net cost to the caller: the 0.15 ACRUX fee plus the rent for Raydium's pool
accounts (both the same as anyone creating a CPMM pool by hand), plus the tx fee.
Everything else is refunded in the same transaction.

## Which fee tier

The caller passes the `amm_config` (fee tier). The program checks it is a
Raydium `AmmConfig`, pool creation is enabled, and its trade fee is at most 1%
(`MAX_RAYDIUM_TRADE_FEE_RATE = 10_000` ppm), so a cranker cannot put a coin in a
10% pool. Allowing a choice matters because Raydium pool addresses are
deterministic (tier + two mints): anyone holding the token can create that pool
first at a bad price, which would make `initialize` fail. The caller then picks
another tier, or falls back to `graduate` (AcruxHub AMM).

## LP lock

Raydium mints `sqrt(a*b) - 100` LP to the creator and keeps 100 unminted. The
graduator burns all of it, so the LP mint's supply ends at 0: nobody can ever
withdraw. Trading fees stay in the reserves and are locked with them. (Raydium's
Burn & Earn locker would let someone claim fees later; that needs a fee owner,
which a permissionless crank does not have, so we burn, as `graduate` does.)

## Upgrade

Upgrading the deployed launchpad in place keeps its address and all accounts.
No new config or init step.

Cost in test ACRUX, measured 2026-11-18 against Acrux's rent and the live
program account (`3qCdE6...SKrd`, upgrade authority `qqMsXac7...LY9a`):

- The new binary is 540,952 bytes; the program account holds 468,592. So it
  must first be extended by 72,360 bytes (`solana program extend`), which costs
  0.5036256 ACRUX of rent permanently.
- The upgrade buffer needs 3.76617432 ACRUX of rent while it is written. The
  upgrade refunds it.
- Plus the fees for the buffer-write transactions (about 550 writes at
  5,000 lamports, roughly 0.003 ACRUX).

So the deployer needs about 4.28 ACRUX on hand at the peak, and about 0.51 ACRUX
is actually spent.

## Testing

    bash wsl.sh "anchor build -p acruxhub_launchpad"
    bash wsl.sh "bash scripts/raydium-localnet.sh start"   # also loads our built programs
    npm run test:e2e:raydium
    bash wsl.sh "bash scripts/raydium-localnet.sh stop"

`tests/launchpad-raydium.e2e.ts` runs against Raydium's real CPMM program and its
0.25% fee tier, both cloned from mainnet, with the native mint as quote. It
checks that the pool opens at the curve's final price, the LP mint's supply is
0, the graduator ends with no accounts or lamports, the cranker paid exactly the
0.15 fee plus pool rent plus the tx fee, neither graduation can run twice, and
swaps work both ways at the exact CPMM quote. A second test checks that a real Raydium tier with a 2% trade fee is refused (`BadFeeTier`) and that pre-creating and dusting the graduator's token account does not block graduation (that account keeps its 1-unit dust; everything else is closed). Measured: about 187k compute
units; cranker cost 190,122,440 lamports (150,000,000 fee + 40,117,440 rent +
5,000 tx fee).

## Not done

- The site has no button for it yet (`web/` is out of scope here). Use
  `graduateRaydiumAccounts()` from `sdk/src/programs.ts`.
- `graduate` (AcruxHub AMM) can be blocked the same way: anyone can create the
  AMM pool for the coin and wrapped ACRUX at the 30 bps tier before graduation.
  This was already true before this change.
