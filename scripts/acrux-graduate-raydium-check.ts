// Live check of `graduate_raydium` on Acrux Net (test tokens only): creates a test
// coin, buys its curve to completion in the same transaction, then graduates it
// into a Raydium CPMM pool on the 0.25% tier, and verifies the result on chain:
// launch graduated, pool at the curve's final price, every LP token burned,
// graduator left empty, and the caller charged only Raydium's fee + pool rent.
//
//   node --import tsx scripts/acrux-graduate-raydium-check.ts [--complete-only]
//   (--complete-only stops before graduating, to test the site's Graduate button)
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getMint } from '@solana/spl-token'
import {
  launchpadProgram, launchConfig, launchAddress, curveBuy, stateOf, graduateRaydiumAccounts, BN,
  decodeCpmmPool, decodeCpmmConfigExtra,
} from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
/** Raydium CPMM fee tier 0 (0.25%). */
const TIER = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection(RPC, 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const bal = async (k: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(k)).value.amount) } catch { return 0n } }
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`ok  ${what}`) }

async function send(tx: Transaction, signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = blockhash
  tx.sign(...signers)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-15).join('\n')}`)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (r.value.err) throw new Error(`failed ${JSON.stringify(r.value.err)} ${sig}`)
  return { sig, cu: sim.value.unitsConsumed }
}

const config = await lp.account.config.fetch(launchConfig())
const quoteMint = config.quoteMint as PublicKey
const p = config.params
const fee = p.feeRecipient as PublicKey
const userQuote = getAssociatedTokenAddressSync(quoteMint, kp.publicKey)
const need = BigInt(p.graduationQuote.toString())
const buyRaw = need + need / 50n // 2% over, so fee and rounding are covered; the program trims to what completes the curve
const have = await bal(userQuote)
console.log(`deployer holds ${have} raw quote; graduation needs ${need} (+1% fee)`)
check(have >= buyRaw, 'deployer has enough quote tokens to complete a curve')

// 1. Create the test coin and buy it to completion.
const mint = Keypair.generate()
const launch = launchAddress(mint.publicKey)
const fresh = {
  virtualQuote: BigInt(p.virtualQuote.toString()), virtualTokens: BigInt(p.virtualTokens.toString()),
  realQuote: 0n, realTokens: BigInt(p.curveSupply.toString()), graduationQuote: need, feeBps: p.feeBps,
}
const q = curveBuy(fresh, buyRaw)!
check(q.completes, 'the buy completes the curve')
const curveTokens = getAssociatedTokenAddressSync(mint.publicKey, launch, true)
const curveQuote = getAssociatedTokenAddressSync(quoteMint, launch, true)
const created = await send(new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  await lp.methods.createLaunch(process.argv.includes('--complete-only') ? 'Graduation Test 2' : 'Graduation Test', process.argv.includes('--complete-only') ? 'GRAD2' : 'GRADT', 'https://acruxhub.com').accountsPartial({ creator: kp.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint, quotePair: null }).instruction(),
  createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, getAssociatedTokenAddressSync(quoteMint, fee, true), fee, quoteMint),
  await lp.methods.buy(new BN(buyRaw.toString()), new BN(q.tokensOut.toString())).accountsPartial({ holderTokens: null,
    user: kp.publicKey, launch, mint: mint.publicKey, quoteMint, curveTokens, curveQuote,
    userTokens: getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey), userQuote, feeQuote: getAssociatedTokenAddressSync(quoteMint, fee, true),
  }).instruction(),
), [kp, mint])
console.log(`created test coin ${mint.publicKey.toBase58()} and completed its curve | ${created.sig}`)
let l = await lp.account.launch.fetch(launch)
check(l.complete && !l.graduated, 'launch is complete and not yet graduated')
if (process.argv.includes('--complete-only')) {
  console.log(`left complete for graduation from the site: #Launch/${launch.toBase58()}`)
  process.exit(0)
}

// 2. Graduate it into Raydium.
const s = stateOf(l)
const held = await bal(curveTokens)
const poolTokens = (s.realQuote * s.virtualTokens) / s.virtualQuote
const g = graduateRaydiumAccounts(l, quoteMint, TIER)
const createFee = decodeCpmmConfigExtra((await conn.getAccountInfo(TIER))!.data as Buffer).createPoolFee
const before = BigInt(await conn.getBalance(kp.publicKey))
const grad = await send(new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
  await lp.methods.graduateRaydium().accountsPartial({ payer: kp.publicKey, ...g }).instruction(),
), [kp])
console.log(`graduated into Raydium pool ${g.poolState.toBase58()} (${grad.cu} CU) | ${grad.sig}`)

// 3. Verify.
l = await lp.account.launch.fetch(launch)
check(l.graduated && (l.pool as PublicKey).equals(g.poolState), 'launch marked graduated, pointing at the Raydium pool')
const pool = decodeCpmmPool(g.poolState, (await conn.getAccountInfo(g.poolState))!.data as Buffer)
const tokenIs0 = pool.mintA.equals(mint.publicKey)
const [tokVault, quoteVault] = tokenIs0 ? [pool.vaultA, pool.vaultB] : [pool.vaultB, pool.vaultA]
check(await bal(quoteVault) === s.realQuote, `pool holds all ${s.realQuote} raised quote`)
check(await bal(tokVault) === poolTokens, `pool holds ${poolTokens} tokens (the curve's final price)`)
check((await getMint(conn, g.lpMint)).supply === 0n, 'every LP token burned: liquidity locked forever')
check(await bal(curveTokens) === 0n, `leftover ${held - poolTokens} tokens burned`)
for (const a of [g.graduatorTokens, g.graduatorQuote, g.graduatorLp]) check(!(await conn.getAccountInfo(a)), `graduator account ${a.toBase58().slice(0, 6)} closed`)
check((await conn.getBalance(g.graduator)) === 0, 'graduator holds no lamports')
let rent = 0n
for (const a of [g.poolState, g.lpMint, g.vault0, g.vault1, g.observation]) rent += BigInt((await conn.getAccountInfo(a))!.lamports)
const spent = before - BigInt(await conn.getBalance(kp.publicKey))
const txFee = BigInt((await conn.getTransaction(grad.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.fee ?? 0)
console.log(`caller spent ${spent} lamports = Raydium fee ${createFee} + pool rent ${rent} + tx fee ${txFee}`)
check(spent === createFee + rent + txFee, 'caller paid exactly the Raydium fee, the pool rent and the tx fee')
console.log('\nALL CHECKS PASSED')
