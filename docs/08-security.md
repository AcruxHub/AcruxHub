# Security and risks

**AcruxHub has not had an independent audit.** Use test funds only.

## What is tested

- **Unit tests** for the AMM math (rounding never favours the trader, the pool never loses value on a swap, the share-inflation attack is blocked), the bonding curve (200 buys and sells can't drain it, the final buy is trimmed correctly) and the bridge (guardian rules, payload hashing).
- **End-to-end tests** on local chains for the full AMM, launchpad (through graduation into a locked pool) and the two-chain bridge, including attack cases.
- **Private-send sealing** checked byte-for-byte against the Acrux node's own test vectors.
- **Raydium routing**: our Raydium CPMM reader, quote math and swap instruction are checked against Raydium's own SDK (over 1,400 random quotes, all exact).
- **Live checks** on Acrux Net: pool creation, private swaps, coin creation with a first buy, and routed swaps through both an AcruxHub pool and a Raydium pool in both directions, all landing with the exact quoted amounts and the exact 0.1% fee.

## Known risks

- **Unaudited code**: tests can't prove the absence of bugs.
- **Upgradeable programs**: see [Contracts](#Docs/contracts).
- **New network**: Acrux Net launched on 2026-11-17. It may reset, change or stop.
- **Private sends**: they don't protect against 2 of the 3 proposers colluding.
- **Coin creators**: anyone can launch a coin with any name, image and links. A coin on AcruxHub is not an endorsement.

## Reporting a vulnerability

Please report security issues privately through [GitHub's private vulnerability reporting](https://github.com/acruxhub/acruxhub/security/advisories/new), not in public issues.
