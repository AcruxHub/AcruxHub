# Fees

These are the fees charged today, read straight from the code.

| Where | Fee | Who receives it |
|---|---|---|
| Launchpad curve, buy and sell | **1%** (less for HUB holders) | The AcruxHub fee wallet |
| Swap, AcruxHub pool | the pool's fee tier (0.05%, 0.30% or 1.00%) | **100% to that pool's liquidity providers** |
| Swap, Raydium pool | the pool's Raydium fee tier (0.25% on the most common one) | Raydium's split: mostly the pool's liquidity providers, part to Raydium |
| Swap through acruxhub.com, any pool | **0.1%** of what you pay (less for HUB holders) | The AcruxHub fee wallet |
| Graduated pools | 0.30% | Stays in the pool, which nobody can withdraw (LP burned) |
| Creating a coin | free (network rent only) | |
| Bridge | Acrux's own bridge (see [Bridge](#Docs/bridge)) | |
| Private sends | 1,000 lamports per included fragment | Acrux proposers (a network fee, not ours) |

On every buy, the launchpad fee comes on top of the amount that goes into the curve, and you see the total before you sign. On sells it comes out of what you receive.

## The 0.1% swap fee

The site adds it to the swap transaction as a separate transfer, before the pool swap, so you see it as its own line on the form and in the transaction. It is charged by the AcruxHub site, not by the pool programs: swapping directly with the programs costs only the pool fee.

## HUB holders pay less

Holding HUB lowers your AcruxHub fees, on both the site's 0.1% swap fee and the launchpad's 1% curve fee:

| Tier | HUB held | Discount |
|---|---|---|
| Bronze | 10,000+ | a third off |
| Silver | 100,000+ | two thirds off |
| Gold | 1,000,000+ | no AcruxHub fee |

On the 0.1% swap fee, HUB in your wallet and HUB you've locked in a token lock both count. On launchpad trades the launchpad program checks the HUB in your wallet, so a Silver holder pays 0.33% instead of 1% on the curve.

## Buyback and burn

Fees don't sit in a wallet. Every 6 hours an automated job ([`fee-buyback.yml`](https://github.com/AcruxHub/AcruxHub/blob/main/.github/workflows/fee-buyback.yml), running [`scripts/hub-buyback.ts`](https://github.com/AcruxHub/AcruxHub/blob/main/scripts/hub-buyback.ts)) spends the ACRUX that came in as fees:

| Share | What happens |
|---|---|
| **30%** | Buys HUB and **burns** it |
| **30%** | Adds HUB/ACRUX liquidity: half buys HUB, the other half is paired with it in the HUB pool, and the LP tokens are **burned**, so that liquidity is locked forever |
| **40%** | Paid to the AcruxHub team, to run the project |

Fees that arrive as HUB (the site's fee on sells) go 40% to the team and the rest is burned. Runs with less than 50 ACRUX of fees are skipped until enough builds up.

HUB has no mint authority, so nothing can add to its supply: every burn lowers it for good. The buys show up in our Telegram group as 🔥 **HUB Buyback** alerts, and every step is an ordinary transaction you can check on chain.

The first run, on Nov 21 2026, spent 465.07 ACRUX of fees: it burned 37.12 HUB in total and added 17.35 HUB with 115.18 ACRUX to the HUB pool, LP burned.

## Fee wallets

Swap fees and launchpad fees go to the AcruxHub fee wallet, `2sxQXf69KQuw4LiBy8QcDzK4r6w7jQDDkbP39Ltcm69X`. It only holds fees waiting for the next buyback run. Earlier fees went to the treasury, `AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd`.

## The AcruxHub token: HUB

HUB is AcruxHub's own coin, contract address `AuVCwgJQRQP1EA655JLDP86uD7r6qEcQZRti4Htp5Uvp`. Its supply was fixed at 686,720,000 at launch with no mint authority, and the buyback burns lower it. 99.6% of the supply is locked until 2028, and its pool's LP is burned. Any other token calling itself "the AcruxHub token" is not ours.
