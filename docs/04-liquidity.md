# Pools and liquidity

The **Pools** page lists two kinds of constant-product (`x · y = k`) pool side by side:

- **AcruxHub pools**: our own AMM, with fee tiers of 0.05%, 0.30% or 1.00%.
- **Raydium CPMM pools**: Raydium's pool program, which runs on Acrux at its Solana mainnet address. Raydium's own website doesn't support Acrux, so AcruxHub is where you create and manage these pools without writing code.

Both kinds show up on **Swap**, which routes each trade to whichever pool pays the most.

## Create a pool

On **Pools**, under **Create a pool**, pick the pool type, paste both token addresses, pick a fee tier and enter starting amounts. **The first deposit sets the price**, so deposit the two tokens in the ratio you want the price to be. The form shows the opening price before you sign.

**AcruxHub pool**: fee tier 0.05%, 0.30% or 1.00%. Creating one costs only network rent. The first deposit permanently locks 1,000 units of LP. That makes the pool impossible to fully empty, and it blocks a known attack where the first depositor inflates the share price.

**Raydium pool**: pick any of Raydium's 25 fee tiers, from 0.005% to 4%. Raydium charges a **0.15 ACRUX** pool-creation fee, plus about 0.04 ACRUX of rent. The form shows the total and your balance. Raydium permanently locks 100 units of LP in every pool. There can be one Raydium pool per pair on each fee tier; if one already exists, the form says so and you add liquidity to it instead. A new pool opens for swaps about a second after it's created.

## Add and remove liquidity

Press **Manage** on any pool in the list.

- **Add**: deposit both tokens at the current pool ratio and receive LP tokens for your share. On Raydium pools, type an amount of either token and the other fills in. Rounding always goes in the pool's favour, so adding and immediately removing can never make a profit.
- **Remove**: burn LP tokens to get back your share of both reserves. **Max** fills in your whole balance.

Raydium deposits and withdrawals carry a slippage limit (1% by default). If the pool's price moves more than that before your transaction lands, it fails instead of filling at a worse ratio.

**Portfolio** shows each position and what it's worth in each token.

## Risks

- **Impermanent loss**: when the price moves, your position ends up holding more of the token that fell. Fees earned can make up for this, or not.
- **Unaudited code**: see [Security](#Docs/security).
