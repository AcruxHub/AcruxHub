# Contracts and addresses

All live on **Acrux Net** (`https://rpc.acrux.computer`). Source: [github.com/acruxhub/acruxhub](https://github.com/acruxhub/acruxhub).

| Program | Address | Status |
|---|---|---|
| AMM (DEX) | `845G7nDPuxfzqbxEnVsrT72XxG5UJMBvunxhEYyAEMjB` | live |
| Launchpad | `3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd` | live |
| Bridge | `D3ct55qQUcEp8RBiD6xU5e923yGN6B1SopFMNhQTc3CT` | not deployed |

Swaps can also route through **Raydium CPMM** pools (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`). That's Raydium's program, placed on Acrux by the Acrux team with no upgrade authority. AcruxHub doesn't control it.

| Account | Address |
|---|---|
| Upgrade authority and launchpad fee wallet | `qqMsXac73aoHZn2r6cYzsk543WsJYbD2jqRvzPoLY9a` |
| Treasury (0.1% swap fee) | `AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd` |
| AXA/AXB pool (0.30%) | `NwPYYN8Xey8afqbyejv7GvJaqK9AwAZtyFkSdGqLr4b` |
| AXA/AXB Raydium CPMM pool (0.25%) | `Edc9VT8nxTDGRuH7o918wufHkSKdJHFLuX3oj3YYpJ7p` |
| Launchpad quote token (AXB) | `28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td` |

## Upgradeability

The programs are upgradeable by the upgrade authority above. That lets bugs get fixed, but it also means you are trusting whoever holds that key. Coins and pools already created keep their own parameters: an upgrade can't change a coin's fixed supply or un-burn locked liquidity.

## Verify for yourself

```bash
solana program show 845G7nDPuxfzqbxEnVsrT72XxG5UJMBvunxhEYyAEMjB -u https://rpc.acrux.computer
```

The deployed programs were built from this repository with Anchor 0.31.1 and Agave 4.0.3 (SBF v0). Solana builds aren't guaranteed byte-identical across machines, so this isn't yet a verified build.
