// Points the Acrux Net launchpad's 1% fee at the treasury instead of the deployer.
// The launchpad was initialized before the treasury existed, so config.fee_recipient
// is still the deployer. update_config replaces the whole ConfigParams (and admin), so
// this keeps every other param and the admin exactly as they are on-chain.
//
// Note: each Launch snapshots fee_recipient at create_launch. Launches created before
// this change keep paying the deployer; only new launches pay the treasury.
//
// Idempotent: does nothing if the config already points at the treasury. Also makes
// sure the treasury's AXB token account exists (buys require it), then proves the new
// routing by SIMULATING (never sending) a fresh launch + 1 AXB buy that pays its fee
// to the treasury's AXB account, with the deployer's account as a must-fail control.
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { launchpadProgram, launchConfig, launchAddress, curveBuy, BN } from '../sdk/src/index.ts'

const AXB = new PublicKey('28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td')
const TREASURY = new PublicKey('AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection('https://rpc.acrux.computer', 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const treasuryAta = getAssociatedTokenAddressSync(AXB, TREASURY, true)

async function prepare(tx: Transaction, signers: Keypair[] = []) {
  const bh = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = bh.blockhash
  tx.sign(kp, ...signers)
  return bh
}

async function simulateThenSend(label: string, tx: Transaction) {
  const { blockhash, lastValidBlockHeight } = await prepare(tx)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) throw new Error(`${label} simulation failed ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.join('\n')}`)
  console.log(`${label}: simulation ok`)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (r.value.err) throw new Error(`${label} failed ${JSON.stringify(r.value.err)} ${sig}`)
  console.log(`${label}: ${sig}`)
  return sig
}

const cfgKey = launchConfig()
const cfg = await lp.account.config.fetch(cfgKey)
console.log('config', cfgKey.toBase58(), 'admin', cfg.admin.toBase58(), 'fee recipient', cfg.params.feeRecipient.toBase58())
if (!cfg.quoteMint.equals(AXB)) throw new Error(`unexpected quote mint ${cfg.quoteMint.toBase58()}`)

// 1. Treasury AXB account (buys on new launches require it to exist).
if (!(await conn.getAccountInfo(treasuryAta))) {
  await simulateThenSend('create treasury AXB ATA', new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, treasuryAta, TREASURY, AXB)))
} else console.log('treasury AXB ATA exists', treasuryAta.toBase58())

// 2. Switch the fee recipient, keeping every other param and the admin.
if (cfg.params.feeRecipient.equals(TREASURY)) {
  console.log('fee recipient already the treasury; nothing to update')
} else {
  if (!cfg.admin.equals(kp.publicKey)) throw new Error(`deployer is not the admin (${cfg.admin.toBase58()})`)
  const params = { ...cfg.params, feeRecipient: TREASURY }
  const tx = await lp.methods.updateConfig(params, cfg.admin)
    .accountsPartial({ admin: kp.publicKey, config: cfgKey })
    .transaction()
  await simulateThenSend('update_config', tx)
}

// 3. Read back.
const after = await lp.account.config.fetch(cfgKey)
const same = (k: keyof typeof cfg.params) => cfg.params[k].toString() === after.params[k].toString()
for (const k of ['feeBps', 'totalSupply', 'curveSupply', 'virtualQuote', 'virtualTokens', 'graduationQuote'] as const)
  if (!same(k)) throw new Error(`param ${k} changed`)
if (!after.admin.equals(cfg.admin)) throw new Error('admin changed')
if (!after.params.feeRecipient.equals(TREASURY)) throw new Error(`fee recipient is ${after.params.feeRecipient.toBase58()}`)
console.log('read back: fee recipient', after.params.feeRecipient.toBase58(), 'fee bps', after.params.feeBps, 'admin', after.admin.toBase58())

// 4. Simulate (do not send) a new launch + 1 AXB buy; the fee must land in the treasury.
const mint = Keypair.generate()
const launchKey = launchAddress(mint.publicKey)
const curveTokens = getAssociatedTokenAddressSync(mint.publicKey, launchKey, true)
const curveQuote = getAssociatedTokenAddressSync(AXB, launchKey, true)
const quoteIn = 1_000_000n
const q = curveBuy({
  virtualQuote: BigInt(after.params.virtualQuote.toString()), virtualTokens: BigInt(after.params.virtualTokens.toString()),
  realQuote: 0n, realTokens: BigInt(after.params.curveSupply.toString()),
  graduationQuote: BigInt(after.params.graduationQuote.toString()), feeBps: after.params.feeBps,
}, quoteIn)!
// The Acrux RPC ignores simulateTransaction's `accounts` option, so instead of reading
// post-state we lean on the program: buy requires fee_quote to be the ATA of
// launch.fee_recipient and transfers the fee into it. So the buy must simulate OK with
// the treasury's account and fail with the deployer's (the control).
const create = await lp.methods.createLaunch('FeeCheck', 'FEE', '')
  .accountsPartial({ creator: kp.publicKey, config: cfgKey, mint: mint.publicKey, quoteMint: AXB, quotePair: null })
  .instruction()
async function simulateBuy(feeQuote: PublicKey) {
  const buy = await lp.methods.buy(new BN(quoteIn.toString()), new BN(q.tokensOut.toString()))
    .accountsPartial({
      user: kp.publicKey, launch: launchKey, mint: mint.publicKey, quoteMint: AXB, curveTokens, curveQuote,
      userTokens: getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey),
      userQuote: getAssociatedTokenAddressSync(AXB, kp.publicKey), feeQuote,
    })
    .instruction()
  const tx = new Transaction().add(create, buy)
  await prepare(tx, [mint])
  return (await conn.simulateTransaction(tx)).value
}
const ok = await simulateBuy(treasuryAta)
if (ok.err) throw new Error(`launch+buy (fee -> treasury) simulation failed ${JSON.stringify(ok.err)}\n${ok.logs?.join('\n')}`)
const control = await simulateBuy(getAssociatedTokenAddressSync(AXB, kp.publicKey))
if (!control.err) throw new Error('control failed: a buy paying the fee to the deployer also simulated OK')
console.log(`simulated new launch + 1 AXB buy: fee ${q.fee} -> treasury ${treasuryAta.toBase58()} OK; deployer as fee account rejected (${JSON.stringify(control.err)})`)
