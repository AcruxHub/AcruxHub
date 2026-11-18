// The keeper: collects the locked LP's trading fees and splits every claim 50/50.
//
//   50%  -> treasury (both tokens, as claimed)
//   50%  -> buyback and burn:
//             the TOKEN part is burned directly,
//             the ACRUX part buys TOKEN on our pool, and everything bought is burned.
//
// Every claim, transfer, swap and burn is appended to keeper-log-<network>.jsonl.
//
//   NETWORK=local node --import tsx launch/src/keeper.ts --once
//   NETWORK=mainnet TREASURY=<address> node --import tsx launch/src/keeper.ts --every 30 --yes
import BN from 'bn.js'
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, createBurnInstruction, getAccount,
} from '@solana/spl-token'
import { NETWORK, conn, wallet, raydiumFor, loadState, logAction, requireYes, swapExactIn, RAY, txVersion, fmt } from './common.ts'

const U64_MAX = '18446744073709551615' // the lock program caps the claim at what has accrued
const MIN_SWAP = 1_000n // raw units; below this a swap isn't worth the fee

const state = loadState()
if (!state.pool || !state.lock || !state.token || !state.quote) throw new Error('run create-token and create-pool first')
const keeper = wallet('keeper')
const treasury = new PublicKey(process.env.TREASURY ?? wallet('treasury').publicKey)
const TOKEN = new PublicKey(state.token.mint)
const QUOTE = new PublicKey(state.quote.mint)
const sym = state.token.symbol

const every = process.argv.includes('--every') ? Number(process.argv[process.argv.indexOf('--every') + 1]) : 0
requireYes([
  `Keeper for pool ${state.pool.id} (fee key ${state.lock.nftMint}, held by ${keeper.publicKey.toBase58()}).`,
  `Each run: claim fees, send 50% to treasury ${treasury.toBase58()},`,
  `burn the ${sym} half and swap the ACRUX half for ${sym} and burn it.`,
  every ? `Repeats every ${every} minutes.` : 'Runs once.',
].join('\n'))

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner)
async function balance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
  try { return (await getAccount(conn, ata(mint, owner))).amount } catch { return 0n }
}

async function runOnce() {
  const raydium = await raydiumFor(keeper)
  await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true })
  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(state.pool!.id)

  // 1. Claim.
  const before = { token: await balance(TOKEN, keeper.publicKey), quote: await balance(QUOTE, keeper.publicKey) }
  let claimTx: string
  try {
    const harvest = await raydium.cpmm.harvestLockLp({
      programId: RAY.lockProgram, authProgram: RAY.lockAuth, poolInfo, poolKeys,
      nftMint: new PublicKey(state.lock!.nftMint), lpFeeAmount: new BN(U64_MAX), txVersion, closeWsol: false,
      cpmmProgram: { programId: RAY.cpmmProgram },
    })
    claimTx = (await harvest.execute({ sendAndConfirm: true })).txId
  } catch (e: any) {
    console.log(new Date().toISOString(), 'nothing to claim yet:', String(e?.message ?? e).slice(0, 120))
    return
  }
  const claimed = {
    token: (await balance(TOKEN, keeper.publicKey)) - before.token,
    quote: (await balance(QUOTE, keeper.publicKey)) - before.quote,
  }
  logAction({ action: 'claim', tx: claimTx, token: fmt(claimed.token, state.token!.decimals), acrux: fmt(claimed.quote, state.quote!.decimals) })
  if (claimed.token <= 0n && claimed.quote <= 0n) return

  // 2. Split: treasury gets half of each (rounded down), the rest goes to buyback/burn.
  const toTreasury = { token: claimed.token / 2n, quote: claimed.quote / 2n }
  const toBurn = claimed.token - toTreasury.token
  const toSwap = claimed.quote - toTreasury.quote

  const pay = new Transaction()
  for (const [mint, amt] of [[TOKEN, toTreasury.token], [QUOTE, toTreasury.quote]] as const) {
    if (amt <= 0n) continue
    pay.add(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata(mint, treasury), treasury, mint))
    pay.add(createTransferInstruction(ata(mint, keeper.publicKey), ata(mint, treasury), keeper.publicKey, amt))
  }
  if (pay.instructions.length) {
    const tx = await sendAndConfirmTransaction(conn, pay, [keeper], { commitment: 'confirmed' })
    logAction({ action: 'treasury', tx, to: treasury.toBase58(), token: fmt(toTreasury.token, state.token!.decimals), acrux: fmt(toTreasury.quote, state.quote!.decimals) })
  }

  // 3. Buy back with the ACRUX half.
  let bought = 0n
  if (toSwap >= MIN_SWAP) {
    const pre = await balance(TOKEN, keeper.publicKey)
    const { txId } = await swapExactIn(raydium, state.pool!.id, QUOTE.toBase58(), toSwap, 0.02)
    bought = (await balance(TOKEN, keeper.publicKey)) - pre
    logAction({ action: 'buyback', tx: txId, acruxIn: fmt(toSwap, state.quote!.decimals), tokenOut: fmt(bought, state.token!.decimals) })
  }

  // 4. Burn the TOKEN half of the claim plus everything bought back.
  const burnAmt = toBurn + bought
  if (burnAmt > 0n) {
    const tx = await sendAndConfirmTransaction(conn, new Transaction().add(
      createBurnInstruction(ata(TOKEN, keeper.publicKey), TOKEN, keeper.publicKey, burnAmt),
    ), [keeper], { commitment: 'confirmed' })
    const supply = (await conn.getTokenSupply(TOKEN)).value.uiAmountString
    logAction({ action: 'burn', tx, token: fmt(burnAmt, state.token!.decimals), fromClaim: fmt(toBurn, state.token!.decimals), fromBuyback: fmt(bought, state.token!.decimals), supplyAfter: supply })
  }
}

await runOnce()
if (every > 0) {
  setInterval(() => runOnce().catch(e => console.error(new Date().toISOString(), 'keeper run failed:', e?.message ?? e)), every * 60_000)
}
