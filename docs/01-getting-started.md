# Getting started

AcruxHub is a DEX, token launchpad and explorer for **Acrux Net**, a Solana fork with 50 ms slots. Solana programs run on Acrux unchanged, so AcruxHub is ordinary Solana code deployed to a faster chain.

> AcruxHub is an independent project. It is not affiliated with the Acrux team. Acrux Net is a new network and AcruxHub is unaudited: only use test funds.

## 1. Get a wallet

Click **Connect** at the top right. You have two choices:

- **Test wallet**: a key kept in this browser. Fastest way to try things. Anyone with access to this browser can use it, so keep only test funds in it.
- **Browser wallet** (Phantom, Backpack): your own wallet signs and AcruxHub sends the signed transaction to Acrux. Phantom can't switch its own network to Acrux and may show warnings, because it checks transactions against Solana. Browser wallets are less tested here than the test wallet.

## 2. Get test funds

Open **Portfolio** and press **Get test funds**. Your address is copied and the Acrux faucet opens. Paste it there to receive test **ACRUX** (for fees) plus **100 AXA** and **100 AXB** (demo tokens). Acrux sets the amounts and limits, and the faucet page shows the current ones for your address.

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
