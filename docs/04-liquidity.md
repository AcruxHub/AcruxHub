# Pools and liquidity

AcruxHub pools are constant-product AMMs (`x · y = k`), one pool per token pair and fee tier.

## Create a pool

On **Pools**, paste both token addresses, pick a fee tier (0.05%, 0.30% or 1.00%) and enter starting amounts. **The first deposit sets the price**, so deposit the two tokens in the ratio you want the price to be.

The first deposit permanently locks 1,000 units of LP. That makes the pool impossible to fully empty, and it blocks a known attack where the first depositor inflates the share price.

## Add and remove liquidity

- **Add**: deposit both tokens at the current pool ratio and receive LP tokens for your share. Rounding always goes in the pool's favour, so adding and immediately removing can never make a profit.
- **Remove**: burn LP tokens to get back your share of both reserves.

**Portfolio** shows each position and what it's worth in each token.

## Risks

- **Impermanent loss**: when the price moves, your position ends up holding more of the token that fell. Fees earned can make up for this, or not.
- **Unaudited code**: see [Security](#Docs/security).
