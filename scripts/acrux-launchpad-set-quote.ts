// Switches the live launchpad's quote token for FUTURE launches (set_quote), e.g.
// from the faucet's AXB to wrapped ACRUX once Acrux has one. Launches already
// created keep trading and graduating in their own quote token.
//
// The curve parameters are rescaled to the new token's decimals so a launch still
// starts and graduates at the same whole-token amounts (pass --graduate <whole
// amount> to change the graduation target as well).
//
// Prints exactly what it would do and changes nothing unless you add --yes.
//   node --import tsx scripts/acrux-launchpad-set-quote.ts <new quote mint> [--graduate <amount>] [--yes]
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { launchpadProgram, launchConfig, BN } from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const args = process.argv.slice(2)
const newQuote = new PublicKey(args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--graduate') ?? '')
const gradIdx = args.indexOf('--graduate')
const yes = args.includes('--yes')

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEY ?? 'keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection(RPC, 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const cfg: any = await lp.account.config.fetch(launchConfig())
if (!(cfg.admin as PublicKey).equals(kp.publicKey)) throw new Error(`deployer is not the launchpad admin (${cfg.admin.toBase58()})`)
if ((cfg.quoteMint as PublicKey).equals(newQuote)) { console.log('quote is already', newQuote.toBase58()); process.exit(0) }

const [oldDec, newDec] = [(await getMint(conn, cfg.quoteMint)).decimals, (await getMint(conn, newQuote)).decimals]
const scale = (v: anchor.BN) => (newDec >= oldDec ? v.mul(new BN(10).pow(new BN(newDec - oldDec))) : v.div(new BN(10).pow(new BN(oldDec - newDec))))
const params = {
  ...cfg.params,
  virtualQuote: scale(cfg.params.virtualQuote),
  graduationQuote: gradIdx >= 0 ? new BN(Math.round(Number(args[gradIdx + 1]) * 10 ** newDec)) : scale(cfg.params.graduationQuote),
}
const whole = (v: anchor.BN, d: number) => (Number(v.toString()) / 10 ** d).toString()
console.log(`launchpad quote: ${cfg.quoteMint.toBase58()} (${oldDec} decimals) -> ${newQuote.toBase58()} (${newDec} decimals)`)
console.log(`virtual quote:   ${whole(cfg.params.virtualQuote, oldDec)} -> ${whole(params.virtualQuote, newDec)}`)
console.log(`graduates at:    ${whole(cfg.params.graduationQuote, oldDec)} -> ${whole(params.graduationQuote, newDec)}`)
console.log(`fee ${cfg.params.feeBps / 100}% to ${cfg.params.feeRecipient.toBase58()} (unchanged)`)
if (!yes) { console.log('\nDry run. Add --yes to send set_quote.'); process.exit(0) }

const tx = await lp.methods.setQuote(params).accountsPartial({ admin: kp.publicKey, config: launchConfig(), quoteMint: newQuote }).transaction()
tx.feePayer = kp.publicKey
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
tx.sign(kp)
const sim = await conn.simulateTransaction(tx)
if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join('\n')}`)
const sig = await conn.sendRawTransaction(tx.serialize())
await conn.confirmTransaction(sig, 'confirmed')
const after: any = await lp.account.config.fetch(launchConfig())
console.log(`set_quote sent | ${sig}\nconfig quote is now ${after.quoteMint.toBase58()}`)
