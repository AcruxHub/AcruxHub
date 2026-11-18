# Token launch: Raydium pool paired with ACRUX, LP locked, 50/50 keeper

1. **Create the token**, in one transaction:
   - the mint, with on-chain Metaplex metadata (name, symbol and a link to the image and details, which wallets, explorers and DEXs read)
   - the fixed supply, minted once
   - mint and freeze authority revoked. Metadata is **immutable** by default, so holders know the name and image can't be swapped later.
2. **Create a Raydium CPMM pool `TOKEN/ACRUX`** on the standard 0.25% fee tier.
3. **Lock 100% of the LP** with Raydium **Burn & Earn**. The liquidity can never be withdrawn. A fee-key NFT (held by the keeper wallet) collects the LP share of trading fees, about 0.21% of volume.
4. **Run the keeper.** Each run claims the fees and splits them 50/50:
   - **50% to the treasury** (both tokens, as claimed), for running costs
   - **50% to buyback and burn**: the TOKEN part is burned directly, and the ACRUX part buys TOKEN on the pool, which is then burned

   Every claim, transfer, buyback and burn is appended to `keeper-log-<network>.jsonl` with its transaction signature.

## Tested

On a local validator running **Raydium's real mainnet programs** (CPMM `CPMMoo8L…`, Burn & Earn `LockrWmn…`, Metaplex) and the real 0.25% fee config, all cloned from mainnet (`scripts/raydium-localnet.sh`):

- Token created with 1,000,000,000 supply, and mint and freeze authority verified `null`.
- Metadata created in the same transaction and read back from the Metaplex account: name, symbol, URI, immutable. The URI's JSON carries the image plus `external_url` and `extensions.twitter/website`. The image is served (HTTP 200).
- Pool created and 100% of LP locked (launcher left with 0 LP). Fee key delivered to the keeper.
- After simulated trading, the keeper claimed 51,282.01 TOKEN + 1,055.02 ACRUX:
  - the treasury received exactly half of each (verified on chain)
  - 527.51 ACRUX bought back 25,575.57 TOKEN
  - 51,216.58 TOKEN was burned, and supply fell by exactly that
- A second run with only dust to claim worked. The lock program caps a harvest at what has accrued, so the keeper always asks for the maximum.

## Running it

Every script takes `NETWORK=local` or `NETWORK=mainnet`. **On mainnet every script prints exactly what it will do and stops. Add `--yes` to execute.**

```bash
bash scripts/raydium-localnet.sh run                          # (local only) chain with Raydium cloned
NETWORK=local node --import tsx launch/src/create-token.ts "Name" TICKER 1000000000 \
  --image logo.png --description "What it is" --x @handle --telegram group --website https://site
NETWORK=local node --import tsx launch/src/create-pool.ts <token amount> <ACRUX amount>
NETWORK=local node --import tsx launch/src/volume.ts 10      # (local only) simulated trading
NETWORK=local node --import tsx launch/src/keeper.ts --once
```

### Mainnet checklist

Wallets live in `keys/mainnet-*.json` (git-ignored):

| Wallet | Needs | Role |
|---|---|---|
| `mainnet-launcher` | ~0.25 SOL + the ACRUX for the pool | creates the token and pool, deposits liquidity |
| `mainnet-keeper` | ~0.05 SOL for fees | holds the fee key, runs claims, buybacks and burns |
| treasury | nothing | receives 50% (`TREASURY=<address>`) |

Costs: Raydium charges a 0.15 SOL pool creation fee, plus about 0.05–0.1 SOL of rent and transaction fees.

The opening price is `ACRUX amount / token amount`. Whoever creates the pool sets it, so pick both amounts deliberately.

### Token metadata

`create-token.ts` uploads the image (PNG/JPG/GIF/WebP, max 1 MB) and details through `acruxhub.com/api/upload`, which stores them under content hashes. Or pass `--uri <metadata json url>` to host them yourself. Limits: name 32 bytes, ticker 1–10 capitals or digits, URI 200 bytes.

Metadata is immutable unless you pass `--mutable`, in which case the launcher wallet stays the update authority. Check the spelling, image and links before a mainnet launch: once immutable, they're permanent.

The image link depends on AcruxHub's file storage staying online. For extra permanence, also pin the image and JSON to IPFS or Arweave and pass that URL with `--uri`.
