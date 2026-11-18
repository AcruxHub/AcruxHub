# Launching a coin

## Create a coin in one step

1. Open **Launch** and press **Start a new coin**.
2. Drop in an image (PNG, JPG, GIF or WebP, up to 1 MB; square looks best).
3. Add a name (up to 32 characters), a ticker (up to 10 letters or numbers) and a description.
4. Optionally add your X, Telegram and website links.
5. Optionally **buy at launch**: your first buy goes in the same transaction as the creation, at the opening price, on the same terms as everyone else.
6. Press **Create coin** and approve in your wallet.

Creating a coin is free apart from network rent for its accounts (about 0.01 ACRUX).

## Fair-launch rules

These are enforced by the launchpad program, not by the website:

- **Fixed supply**: 1,000,000,000 tokens are minted once and the mint authority is revoked in the same instruction. Nobody can ever mint more.
- **No creator allocation, no presale**: all tokens start in the bonding curve. The creator gets tokens only by buying, like everyone else.
- **Same price for everyone**: the price depends only on how much has been bought, along a constant-product curve.

## The bonding curve

| Parameter | Value on Acrux Net |
|---|---|
| Quote token | AXB (the faucet's demo token; Acrux Net has no wrapped ACRUX yet) |
| Total supply | 1,000,000,000 |
| Sold on the curve | up to 800,000,000 |
| Starting virtual reserves | 30 AXB : 1,073,000,000 tokens |
| Graduates at | 20 AXB raised |
| Trade fee | 1% on buys and sells |

Price only rises as people buy and falls as they sell. The buy that crosses the graduation threshold is trimmed so it pays only for what it gets.

## Graduation to the DEX

Once 20 AXB is raised, trading on the curve stops and **anyone** can press **Graduate to DEX**. In one transaction the program:

1. Creates an AcruxHub AMM pool (0.30% fee) for the coin and the quote token.
2. Deposits all the raised quote and the matching tokens **at the curve's final price**, so the pool opens exactly where the curve ended.
3. **Burns every LP token**, so the liquidity is locked forever and nobody can pull it.
4. Burns any tokens left over.

After that the coin trades on **Swap**.

## Metadata

The image and details are stored in AcruxHub's file storage under a name derived from the file's contents (SHA-256). Each coin records a link to its details on chain. That link can't be changed after launch, so check your links before you create.
