// LOCAL TESTING ONLY: a trader buys and sells on the pool to generate trading fees
// for the keeper to collect.   NETWORK=local node --import tsx launch/src/volume.ts 20
import { NETWORK, wallet, raydiumFor, loadState, fmt } from './common.ts'
import { swapExactIn } from './common.ts'

if (NETWORK !== 'local') throw new Error('volume.ts is for the local test chain only')
const rounds = Number(process.argv[2] ?? 10)
const state = loadState()
const trader = wallet('trader')
const raydium = await raydiumFor(trader)

let held = 0n
for (let i = 0; i < rounds; i++) {
  // Buy with 20k-120k stand-in ACRUX, then sell back most of what was bought.
  const spend = BigInt(20_000 + Math.floor(Math.random() * 100_000)) * 1_000_000n
  const buy = await swapExactIn(raydium, state.pool!.id, state.quote!.mint, spend)
  held += buy.out
  const sellAmt = (buy.out * 9n) / 10n
  const sell = await swapExactIn(raydium, state.pool!.id, state.token!.mint, sellAmt)
  held -= sellAmt
  console.log(`round ${i + 1}: bought ${fmt(buy.out, 6)} ${state.token!.symbol} for ${fmt(spend, 6)} ACRUX, sold ${fmt(sellAmt, 6)} for ${fmt(sell.out, 6)} ACRUX`)
}
console.log('trader now holds', fmt(held, 6), state.token!.symbol, 'from this run')
