# Getting started

AcruxHub is a DEX, token launchpad and explorer for **Acrux Net**, a Solana fork with 50 ms slots. Solana programs run on Acrux unchanged, so AcruxHub is ordinary Solana code deployed to a faster chain.

> AcruxHub is an independent project. It is not affiliated with the Acrux team. Acrux Net is a new network and AcruxHub's code is unaudited: use it at your own risk, only with amounts you can afford to lose.

## 1. Get a wallet

Click **Connect** at the top right. You have two choices:

- **Browser key**: a key kept in this browser. Fastest way to try things. Anyone with access to this browser can use it, so keep only small amounts in it.
- **Browser wallet** (Phantom, Backpack): your own wallet signs and AcruxHub sends the signed transaction to Acrux. Phantom can't switch its own network to Acrux and may show warnings, because it checks transactions against Solana. Browser wallets are less tested here than the browser key.

## 2. Get ACRUX

At Acrux slot **4,752,000** (about 22:00 UTC on Nov 20), gas on Acrux becomes **real ACRUX** bridged from Solana. Test ACRUX retires at that slot and the faucet closes.

- **Before the switch:** open **Portfolio** and press **Get test funds**. Your address is copied and the Acrux faucet opens. Paste it there to receive test ACRUX plus AXA and AXB (demo tokens).
- **After the switch:** **Portfolio** links to the Acrux bridge instead. Bridge ACRUX from Solana at [acrux.computer/bridge](https://acrux.computer/bridge) and paste your address as the destination. Bridged ACRUX is your native balance on Acrux and pays every fee.

## 3. Use it

| Page | What it's for |
|---|---|
| **Swap** | Trade tokens at the best price across AcruxHub and Raydium pools. Paste any token's address (CA) to find its pools. |
| **Pools** | Create AcruxHub or Raydium pools and add or remove liquidity, no code needed. |
| **Launch** | Create a coin in one step, buy coins still on their bonding curve, and graduate finished ones into a Raydium pool or the AcruxHub DEX. |
| **Explorer** | Live Acrux Net data: current window, proposers, slots, accounts, transactions. |
| **Portfolio** | Your balances and liquidity positions. |
| **Bridge** | Not live yet: see [Bridge](#Docs/bridge). |

## Network details

| | |
|---|---|
| RPC | `https://rpc.acrux.computer` |
| Native token | ACRUX (shown as "SOL" by some Solana tools) |
| Slot time | 50 ms target |
