// Points the launchpad's 1% curve fee at a new address (for example the fee wallet the
// buyback bot spends), keeping every other config param and the admin exactly as they are.
// Each Launch snapshots fee_recipient at create_launch, so only coins launched after
// this pay the new address. Also makes sure that address has a token account for the
// launchpad's quote token (buys create it too, but this way it's there from the start).
//
//   node --import tsx scripts/acrux-launchpad-fee-recipient.ts <new recipient> [--yes]
//
// Simulates without --yes. KEY (default keys/acrux-deployer.json) must be the admin.
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { launchpadProgram, launchConfig } from '../sdk/src/index.ts'

const to = process.argv.slice(2).find(a => !a.startsWith('--'))
if (!to) throw new Error('usage: acrux-launchpad-fee-recipient.ts <new recipient> [--yes]')
const RECIPIENT = new PublicKey(to)
const yes = process.argv.includes('--yes')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEY ?? 'keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection(process.env.RPC ?? 'https://rpc.acrux.computer', 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))

async function send(label: string, tx: Transaction) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = blockhash
  tx.sign(kp)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.slice(-8).join('\n')}`)
  if (!yes) { console.log(`${label}: simulated OK (add --yes to send)`); return }
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (r.value.err) throw new Error(`${label} failed ${JSON.stringify(r.value.err)} ${sig}`)
  console.log(`${label}: ${sig}`)
}

const cfgKey = launchConfig()
const cfg = await lp.account.config.fetch(cfgKey)
console.log('admin', cfg.admin.toBase58(), '| quote', cfg.quoteMint.toBase58(), '| fee recipient now', cfg.params.feeRecipient.toBase58())
if (!cfg.admin.equals(kp.publicKey)) throw new Error(`this key (${kp.publicKey.toBase58()}) is not the admin`)

const ata = getAssociatedTokenAddressSync(cfg.quoteMint, RECIPIENT, true)
if (!(await conn.getAccountInfo(ata))) {
  await send('create the recipient\'s quote token account', new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, RECIPIENT, cfg.quoteMint)))
} else console.log('recipient quote token account exists', ata.toBase58())

if (cfg.params.feeRecipient.equals(RECIPIENT)) {
  console.log('fee recipient already', RECIPIENT.toBase58(), '- nothing to update')
} else {
  const params = { ...cfg.params, feeRecipient: RECIPIENT }
  await send('update_config (fee recipient only)', await lp.methods.updateConfig(params, cfg.admin)
    .accountsPartial({ admin: kp.publicKey, config: cfgKey }).transaction())
}

if (yes) {
  const after = await lp.account.config.fetch(cfgKey)
  for (const k of Object.keys(cfg.params) as (keyof typeof cfg.params)[]) {
    if (k === 'feeRecipient') continue
    if (cfg.params[k].toString() !== after.params[k].toString()) throw new Error(`param ${String(k)} changed`)
  }
  if (!after.admin.equals(cfg.admin)) throw new Error('admin changed')
  if (!after.params.feeRecipient.equals(RECIPIENT)) throw new Error(`fee recipient is ${after.params.feeRecipient.toBase58()}`)
  console.log('read back OK: fee recipient', after.params.feeRecipient.toBase58(), '| every other param and the admin unchanged')
}
