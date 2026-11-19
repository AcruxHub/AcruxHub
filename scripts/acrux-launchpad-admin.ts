// Launchpad admin on Acrux Net: approve quote tokens creators can pair with, and
// the emergency pause. Signs with keys/acrux-deployer.json (the launchpad admin).
// Prints exactly what it would do and changes nothing unless you add --yes.
//
//   node --import tsx scripts/acrux-launchpad-admin.ts status
//   node --import tsx scripts/acrux-launchpad-admin.ts pair <quote mint> [--graduate <amount>] [--virtual <amount>] [--yes]
//   node --import tsx scripts/acrux-launchpad-admin.ts unpair <quote mint> [--yes]
//   node --import tsx scripts/acrux-launchpad-admin.ts pause|unpause [--yes]
//
// A new pair copies the default curve (supply, fee, fee recipient) with the quote
// amounts rescaled to the pair token's decimals; --graduate / --virtual set them
// in whole tokens instead, since a token worth more needs a smaller target.
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey, type Transaction } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { launchpadProgram, launchConfig, launchPairAddress, launchPauseAddress, allAccounts, BN } from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const [cmd, arg] = process.argv.slice(2).filter(a => !a.startsWith('--') && !/^[\d.]+$/.test(a))
const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
const yes = process.argv.includes('--yes')

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection(RPC, 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const cfg: any = await lp.account.config.fetch(launchConfig())
const whole = (v: anchor.BN, d: number) => (Number(v.toString()) / 10 ** d).toString()

async function send(label: string, tx: Transaction) {
  if (!(cfg.admin as PublicKey).equals(kp.publicKey)) throw new Error(`deployer is not the launchpad admin (${cfg.admin.toBase58()})`)
  if (!yes) { console.log(`\nDry run. Add --yes to send ${label}.`); return }
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.sign(kp)
  const sim = await conn.simulateTransaction(tx)
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join('\n')}`)
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction(sig, 'confirmed')
  console.log(`${label} sent | ${sig}`)
}

if (cmd === 'status' || !cmd) {
  const pause: any = await (lp.account as any).pause.fetchNullable(launchPauseAddress())
  console.log(`default quote ${cfg.quoteMint.toBase58()} · ${pause?.paused ? 'PAUSED' : 'running'}`)
  for (const p of (await allAccounts<any>(lp, 'QuotePair')) as any[]) {
    const d = (await getMint(conn, p.account.mint)).decimals
    console.log(`pair ${p.account.mint.toBase58()} ${p.account.enabled ? 'enabled' : 'disabled'} · graduates at ${whole(p.account.params.graduationQuote, d)}`)
  }
} else if (cmd === 'pair' || cmd === 'unpair') {
  const mint = new PublicKey(arg ?? '')
  const existing: any = await lp.account.quotePair.fetchNullable(launchPairAddress(mint))
  const [baseDec, dec] = [(await getMint(conn, cfg.quoteMint)).decimals, (await getMint(conn, mint)).decimals]
  const scale = (v: anchor.BN) => (dec >= baseDec ? v.mul(new BN(10).pow(new BN(dec - baseDec))) : v.div(new BN(10).pow(new BN(baseDec - dec))))
  const base = existing?.params ?? { ...cfg.params, virtualQuote: scale(cfg.params.virtualQuote), graduationQuote: scale(cfg.params.graduationQuote) }
  const toRaw = (s: string) => new BN(Math.round(Number(s) * 10 ** dec))
  const params = {
    ...base,
    ...(flag('--graduate') ? { graduationQuote: toRaw(flag('--graduate')!) } : {}),
    ...(flag('--virtual') ? { virtualQuote: toRaw(flag('--virtual')!) } : {}),
  }
  const enabled = cmd === 'pair'
  console.log(`${enabled ? 'approve' : 'disable'} pair ${mint.toBase58()} (${dec} decimals)${existing ? ' (updating)' : ' (new)'}`)
  console.log(`virtual quote ${whole(params.virtualQuote, dec)} · graduates at ${whole(params.graduationQuote, dec)} · fee ${params.feeBps / 100}% to ${params.feeRecipient.toBase58()}`)
  await send(`set_pair`, await lp.methods.setPair(params, enabled).accountsPartial({ admin: kp.publicKey, config: launchConfig(), quoteMint: mint }).transaction())
} else if (cmd === 'pause' || cmd === 'unpause') {
  console.log(`${cmd}: ${cmd === 'pause' ? 'stops new launches, buys, sells and graduations' : 'resumes everything'}`)
  await send(cmd, await lp.methods.setPaused(cmd === 'pause').accountsPartial({ admin: kp.publicKey, config: launchConfig() }).transaction())
} else {
  throw new Error(`unknown command ${cmd}`)
}
