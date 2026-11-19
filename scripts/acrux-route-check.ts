// Live check of the Swap page's routing on Acrux Net: quotes AXA -> AXB on both the
// AcruxHub AMM pool and the Raydium CPMM pool, builds the swap with the same SDK
// code the site uses (routedSwapInstructions, 0.1% fee to the treasury), sends it
// as a private 2-of-3 send, and checks the output and the fee land exactly as quoted.
//
//   ROUTE=best|raydium|acruxhub node --import tsx scripts/acrux-route-check.ts <AXA amount> [aToB=1]
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  ammProgram, poolAddresses, swapOut, minOut, loadCpmm, cpmmSwapOut, cpmmSwapEnabled, platformFee,
  routedSwapInstructions, AcruxGateway, privateSend, waitForTx, type RouteMarket,
} from '../sdk/src/index.ts'

const AXA = new PublicKey('713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss')
const AXB = new PublicKey('28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td')
const TREASURY = new PublicKey('AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd')
const route = process.env.ROUTE ?? 'best'
const whole = Number(process.argv[2] ?? '1')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection('https://rpc.acrux.computer', 'confirmed')
const gw = new AcruxGateway()
const amm = ammProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const bal = async (k: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(k)).value.amount) } catch { return 0n } }

const ours = poolAddresses(AXA, AXB, 30)
const aToB = (process.argv[3] ?? (ours.mintA.equals(AXA) ? '1' : '0')) === '1' // default: pay AXA
const amountIn = BigInt(Math.round(whole * 1e6))
const { fee, net } = platformFee(amountIn)

type Q = { name: string; market: RouteMarket; out: bigint }
const quotes: Q[] = []
const [oa, ob] = [await bal(ours.vaultA), await bal(ours.vaultB)]
const ammFee = (await amm.account.pool.fetch(ours.pool)).feeBps
quotes.push({
  name: 'AcruxHub AMM',
  market: { kind: 'acruxhub', mintA: ours.mintA, mintB: ours.mintB, programA: TOKEN_PROGRAM_ID, programB: TOKEN_PROGRAM_ID, decimalsA: 6, decimalsB: 6, amm: { address: ours.pool, vaultA: ours.vaultA, vaultB: ours.vaultB } },
  out: aToB ? swapOut(net, oa, ob, ammFee) : swapOut(net, ob, oa, ammFee),
})
const { configs, pools } = await loadCpmm(conn)
for (const p of pools.filter(p => p.mintA.equals(ours.mintA) && p.mintB.equals(ours.mintB) && cpmmSwapEnabled(p))) {
  const cfg = configs.get(p.config.toBase58())!
  const ra = (await bal(p.vaultA)) - p.heldFeesA, rb = (await bal(p.vaultB)) - p.heldFeesB
  quotes.push({
    name: `Raydium CPMM ${p.address.toBase58().slice(0, 6)}`,
    market: { kind: 'raydium', mintA: p.mintA, mintB: p.mintB, programA: p.programA, programB: p.programB, decimalsA: p.decimalsA, decimalsB: p.decimalsB, raydium: { pool: p } },
    out: aToB ? cpmmSwapOut(net, ra, rb, cfg, p, true) : cpmmSwapOut(net, rb, ra, cfg, p, false),
  })
}
quotes.sort((x, y) => (x.out > y.out ? -1 : x.out < y.out ? 1 : 0))
for (const q of quotes) console.log(`quote ${q.name.padEnd(22)} ${net} in -> ${q.out} out`)
const pick = route === 'best' ? quotes[0] : quotes.find(q => q.market.kind === route)
if (!pick) throw new Error(`no ${route} market`)
console.log(`routing via ${pick.name}${route === 'best' ? ' (best price)' : ' (forced)'}; fee ${fee} of ${amountIn}`)

const [inMint, outMint] = aToB ? [ours.mintA, ours.mintB] : [ours.mintB, ours.mintA]
const userOut = getAssociatedTokenAddressSync(outMint, kp.publicKey)
const feeAta = getAssociatedTokenAddressSync(inMint, TREASURY, true)
const [outBefore, feeBefore] = [await bal(userOut), await bal(feeAta)]

const { ixs } = await routedSwapInstructions({
  market: pick.market, user: kp.publicKey, aToB, amountIn, minOut: minOut(pick.out, 50),
  feeRecipient: TREASURY, amm, deadlineSlot: (await conn.getSlot()) + 300,
})
const tx = new Transaction().add(...ixs)
tx.feePayer = kp.publicKey
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
tx.sign(kp)
console.log(`tx ${tx.serialize().length} bytes, ${ixs.length} instructions, sent private 2-of-3`)
const { id } = await privateSend(gw, tx.serialize(), kp.secretKey, { n: 3, t: 2 })
const state = await waitForTx(gw, id, 60_000)
console.log('state', state, id)
if (state !== 'executed' && state !== 'finalized') throw new Error(`send ${state}`)

await new Promise(r => setTimeout(r, 1500))
const gotOut = (await bal(userOut)) - outBefore
const gotFee = (await bal(feeAta)) - feeBefore
console.log(`received ${gotOut} (quoted ${pick.out}) | treasury fee ${gotFee} (expected ${fee})`)
if (gotOut !== pick.out || gotFee !== fee) throw new Error('MISMATCH')
console.log('OK: output and fee exactly as quoted')
