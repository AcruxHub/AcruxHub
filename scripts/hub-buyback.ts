// Puts AcruxHub's fee money to work for $HUB holders, from the treasury:
//   1. Buyback: swaps part of the treasury's fee balance (in the quote token, e.g.
//      wrapped ACRUX) for $HUB in its Raydium pool and BURNS the $HUB bought.
//   2. Liquidity: swaps half of another part for $HUB, deposits both sides into the
//      same pool and BURNS the LP tokens, so that liquidity is locked forever.
// What's left (the reserve) stays in the treasury.
//
// Prints the plan and simulates every step; changes nothing unless you add --yes.
// Runs from this machine only: it signs with the treasury key, which never goes to GitHub.
//
//   node --import tsx scripts/hub-buyback.ts <HUB mint> <quote mint> [--use <whole amount>]
//        [--reserve <whole amount>] [--buyback <pct>] [--liquidity <pct>] [--slippage <pct>] [--pool <address>] [--yes]
//
// Defaults: use everything above --reserve 0, split 50% buyback / 50% liquidity, 1% slippage.
// RPC and KEY env vars point it elsewhere (KEY defaults to keys/mainnet-treasury.json).
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createBurnInstruction, getMint,
} from '@solana/spl-token'
import { loadCpmm, cpmmSwapOut, cpmmSwapInstruction, cpmmDepositQuote, cpmmDepositInstruction, type CpmmPool } from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'))
const flag = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const yes = process.argv.includes('--yes')
if (pos.length < 2) throw new Error('usage: hub-buyback.ts <HUB mint> <quote mint> [options]')
const HUB = new PublicKey(pos[0])
const QUOTE = new PublicKey(pos[1])
const buybackPct = Number(flag('--buyback') ?? 50)
const liquidityPct = Number(flag('--liquidity') ?? 100 - buybackPct)
const slipBps = BigInt(Math.round(Number(flag('--slippage') ?? 1) * 100))
if (buybackPct < 0 || liquidityPct < 0 || buybackPct + liquidityPct > 100) throw new Error('--buyback + --liquidity must be 0..100')

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEY ?? 'keys/mainnet-treasury.json', 'utf8'))))
const conn = new Connection(RPC, 'confirmed')
const me = kp.publicKey
const [hubDec, qDec] = [(await getMint(conn, HUB)).decimals, (await getMint(conn, QUOTE)).decimals]
const whole = (v: bigint, d: number) => (Number(v) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d })
const raw = (s: string, d: number) => BigInt(Math.round(Number(s) * 10 ** d))
const myHub = getAssociatedTokenAddressSync(HUB, me)
const myQuote = getAssociatedTokenAddressSync(QUOTE, me)
const bal = async (a: PublicKey) => conn.getTokenAccountBalance(a).then(r => BigInt(r.value.amount)).catch(() => 0n)

async function findPool(): Promise<CpmmPool & { r0: bigint; r1: bigint; cfg: any }> {
  const { pools, configs } = await loadCpmm(conn)
  const want = flag('--pool')
  const cands = pools.filter(p => want ? p.address.toBase58() === want
    : (p.mintA.equals(HUB) && p.mintB.equals(QUOTE)) || (p.mintA.equals(QUOTE) && p.mintB.equals(HUB)))
  if (!cands.length) throw new Error(`no Raydium CPMM pool for HUB/quote${want ? ` at ${want}` : ''}`)
  const withRes = await Promise.all(cands.map(async p => {
    const [v0, v1] = await Promise.all([bal(p.vaultA), bal(p.vaultB)])
    return { ...p, r0: v0 - p.heldFeesA, r1: v1 - p.heldFeesB, cfg: configs.get(p.config.toBase58()) }
  }))
  // The deepest pool, measured in the quote token.
  return withRes.sort((a, b) => Number((a.mintA.equals(QUOTE) ? b.r0 - a.r0 : b.r1 - a.r1)))[0]
}

async function run(label: string, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = me
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.sign(kp)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join('\n')}`)
  if (!yes) { console.log(`  ${label}: simulated OK`); return null }
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction(sig, 'confirmed')
  console.log(`  ${label}: ${sig}`)
  return sig
}

/** Swap `amountIn` quote for HUB; returns the HUB received (or the quote's estimate on a dry run). */
async function buyHub(p: Awaited<ReturnType<typeof findPool>>, amountIn: bigint, label: string) {
  const aToB = p.mintA.equals(QUOTE)
  const out = cpmmSwapOut(amountIn, aToB ? p.r0 : p.r1, aToB ? p.r1 : p.r0, p.cfg, p, aToB)
  const before = await bal(myHub)
  await run(label, [
    createAssociatedTokenAccountIdempotentInstruction(me, myHub, me, HUB),
    cpmmSwapInstruction({ pool: p, payer: me, aToB, userIn: myQuote, userOut: myHub, amountIn, minOut: (out * (10_000n - slipBps)) / 10_000n }),
  ])
  return yes ? (await bal(myHub)) - before : out
}

const pool = await findPool()
const have = await bal(myQuote)
const reserve = raw(flag('--reserve') ?? '0', qDec)
const use = flag('--use') ? raw(flag('--use')!, qDec) : have > reserve ? have - reserve : 0n
if (use <= 0n || use > have) throw new Error(`treasury holds ${whole(have, qDec)} quote; nothing to use (or --use is more than that)`)
const forBuyback = (use * BigInt(Math.round(buybackPct * 100))) / 10_000n
const forLiquidity = (use * BigInt(Math.round(liquidityPct * 100))) / 10_000n

console.log(`treasury ${me.toBase58()} holds ${whole(have, qDec)} quote`)
console.log(`pool ${pool.address.toBase58()} · reserves ${whole(pool.mintA.equals(QUOTE) ? pool.r0 : pool.r1, qDec)} quote / ${whole(pool.mintA.equals(HUB) ? pool.r0 : pool.r1, hubDec)} HUB`)
console.log(`using ${whole(use, qDec)}: ${whole(forBuyback, qDec)} buyback+burn · ${whole(forLiquidity, qDec)} liquidity (LP burned) · keeps ${whole(have - use, qDec)}`)
if (!yes) console.log('Dry run: simulating each step. Add --yes to send.')

// 1. Buyback and burn.
if (forBuyback > 0n) {
  const got = await buyHub(pool, forBuyback, 'buyback swap')
  console.log(`  bought ${whole(got, hubDec)} HUB`)
  if (yes && got > 0n) await run('burn bought HUB', [createBurnInstruction(myHub, HUB, me, got)])
  else if (!yes) console.log(`  burn ${whole(got, hubDec)} HUB: runs after the swap lands`)
}

// 2. Liquidity: buy HUB with half, deposit both halves, burn the LP.
if (forLiquidity > 0n) {
  const half = forLiquidity / 2n
  const p2 = yes ? await findPool() : pool // reserves moved after the buyback
  const hubGot = await buyHub(p2, half, 'liquidity swap')
  if (!yes) {
    console.log(`  then deposit ~${whole(hubGot, hubDec)} HUB + ~${whole(forLiquidity - half, qDec)} quote and burn the LP (runs after the swap lands)`)
  } else {
    const p3 = await findPool()
    const hubSide: 0 | 1 = p3.mintA.equals(HUB) ? 0 : 1
    // The LP both sides can afford: the smaller of the HUB-limited and quote-limited deposits.
    const byHub = cpmmDepositQuote(hubGot, hubSide, p3.lpSupply, p3.r0, p3.r1)
    const byQuote = cpmmDepositQuote(forLiquidity - half, hubSide === 0 ? 1 : 0, p3.lpSupply, p3.r0, p3.r1)
    const dq = byHub.lp <= byQuote.lp ? byHub : byQuote
    const lp = (dq.lp * 99n) / 100n // a little room for rounding
    const myLp = getAssociatedTokenAddressSync(p3.lpMint, me)
    const user0 = p3.mintA.equals(HUB) ? myHub : myQuote
    const user1 = p3.mintA.equals(HUB) ? myQuote : myHub
    const lpBefore = await bal(myLp)
    await run('deposit', [
      createAssociatedTokenAccountIdempotentInstruction(me, myLp, me, p3.lpMint),
      cpmmDepositInstruction({ pool: p3, owner: me, userLp: myLp, user0, user1, lp, max0: dq.amount0, max1: dq.amount1 }),
    ])
    const minted = (await bal(myLp)) - lpBefore
    if (minted > 0n) await run('burn LP (locks the liquidity)', [createBurnInstruction(myLp, p3.lpMint, me, minted)])
    console.log(`  added liquidity and burned ${whole(minted, 9)} LP`)
  }
}
