# Fees

These are the fees charged today, read straight from the code.

| Where | Fee | Who receives it |
|---|---|---|
| Launchpad curve, buy and sell | **1%** | The AcruxHub treasury |
| Swap, AcruxHub pool | the pool's fee tier (0.05%, 0.30% or 1.00%) | **100% to that pool's liquidity providers** |
| Swap, Raydium pool | the pool's Raydium fee tier (0.25% on the most common one) | Raydium's split: mostly the pool's liquidity providers, part to Raydium |
| Swap through acruxhub.com, any pool | **0.1%** of what you pay | The AcruxHub treasury |
| Graduated pools | 0.30% | Stays in the pool, which nobody can withdraw (LP burned) |
| Creating a coin | free (network rent only) | |
| Bridge | not live | |
| Private sends | 1,000 lamports per included fragment | Acrux proposers (a network fee, not ours) |

On every buy, the launchpad fee comes on top of the amount that goes into the curve, and you see the total before you sign. On sells it comes out of what you receive.

## The 0.1% swap fee

The site adds it to the swap transaction as a separate transfer, before the pool swap, so you see it as its own line on the form and in the transaction. It is charged by the AcruxHub site, not by the pool programs: swapping directly with the programs costs only the pool fee.

## Fee wallets

Swap fees and launchpad fees both go to the AcruxHub treasury, `AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd`. They pay for running AcruxHub: hosting, storage and network fees.

## There is no AcruxHub token

AcruxHub has no token and no airdrop. Any token claiming to be "the AcruxHub token" is not ours unless it is announced on [our X account](https://x.com/AcruxHub) and on this site.
