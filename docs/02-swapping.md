# Swapping

## How to swap

1. Open **Swap**.
2. Pick a pair, or **paste a token address (CA)**. AcruxHub finds every pool for that token and sets you up to buy it. If the token is still on its launch curve, it links you to the coin's page instead.
3. Enter an amount. The page shows what you'll receive, the **route** (which pool it goes through), the **price impact** (how much your trade moves the price), the **minimum received** after slippage, and AcruxHub's fee.
4. Press **Swap** and approve in your wallet.

You can share a direct link: `https://acruxhub.com/#Swap/<token address>`.

## Best-price routing: AcruxHub and Raydium pools

Raydium's CPMM pool program runs on Acrux Net at its Solana mainnet address (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`), placed there by the Acrux team. Pools made with Raydium's own tools exist on Acrux, but Raydium's website doesn't show Acrux.

AcruxHub reads every Raydium CPMM pool on the chain next to its own pools. For each swap it quotes **every pool for the pair**, using each program's exact math, and sends your swap to the one that pays you the most. When a pair has more than one pool, the page lists each pool's quote and marks the one it picked.

Raydium pools whose tokens use a Token-2022 transfer fee aren't routed yet, because the quote would be wrong.

## Slippage and deadlines

Every swap carries these guards, enforced on chain:

- **Minimum output**: if the price moves against you by more than your slippage setting (0.5% by default), the swap fails instead of filling at a worse price.
- **Deadline**: on AcruxHub pools, a swap must land within about 300 slots (15 seconds) of being signed, or it fails. Raydium's program has no deadline argument, so a Raydium-routed swap is limited by the transaction's blockhash instead, which expires after about a minute on Acrux.

## Private sends (front-running protection)

On Acrux Net, AcruxHub sends your swap as an Acrux **threshold transaction** by default:

1. Your signed swap is encrypted with ChaCha20-Poly1305 under a one-time key.
2. The encrypted bytes are split into 3 pieces (Reed-Solomon coding), and so is the key (Shamir secret sharing).
3. Each of the slot's 3 block proposers receives one piece. **Any 2 pieces are needed to read the swap**, and they only come together once the proposers have committed to including it.

So no single proposer can see your swap early and trade ahead of you or sandwich it. What this does **not** protect against: 2 of the 3 proposers colluding, and the public header (fee payer, compute budget and the accounts the swap writes to) is visible.

The **Send** row on the swap form shows `private` or `public`. You can turn private sends off in the wallet menu. Browser wallets need message signing for private sends.

Our sealing code is an independent implementation of the published Acrux wire format, checked byte-for-byte against the Acrux node's own test vectors.

## Fees

Each pool has its own fee: 0.05%, 0.30% or 1.00% on AcruxHub pools, and the pool's fee tier on Raydium pools (0.25% on the most common one). On top of that, AcruxHub takes **0.1%** of what you pay. See [Fees](#Docs/fees).
