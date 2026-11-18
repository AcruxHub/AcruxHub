// Restores AcruxHub on Acrux Net after a network reset (every Acrux Net restart is a
// fresh genesis). Safe to run any time: each step checks the chain and only does
// what is missing.
//
//   node --import tsx scripts/acrux-redeploy.ts            # check and restore
//   node --import tsx scripts/acrux-redeploy.ts --check    # report only, change nothing
//   node --import tsx scripts/acrux-redeploy.ts --wait     # if short on ACRUX, wait for a top-up
//
// Programs are redeployed from target/deploy/*.so with the same program keypairs, so
// they come back at the SAME addresses and the website needs no change.
// RPC=http://127.0.0.1:8899 runs the same steps against a plain local validator
// (demo tokens are created locally and SOL is airdropped), which is how it's tested.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { AMM_ID, LAUNCHPAD_ID, AcruxGateway, ammProgram, launchpadProgram, launchConfig, poolAddresses, depositQuote, BN } from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const IS_ACRUX = RPC.includes('acrux.computer')
const CHECK_ONLY = process.argv.includes('--check')
const WAIT = process.argv.includes('--wait')
const root = new URL('../', import.meta.url)
const path = (p: string) => decodeURIComponent(new URL(p, root).pathname).replace(/^\/([A-Za-z]:)/, '$1')
const DEPLOYER_FILE = path('keys/acrux-deployer.json')
const TREASURY = new PublicKey(process.env.TREASURY ?? 'AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd')
const PROGRAMS = [
  { name: 'AMM (DEX)', id: AMM_ID, so: path('target/deploy/acruxhub_amm.so'), key: path('keys/acruxhub_amm-keypair.json') },
  { name: 'Launchpad', id: LAUNCHPAD_ID, so: path('target/deploy/acruxhub_launchpad.so'), key: path('keys/acruxhub_launchpad-keypair.json') },
]
// Launchpad curve on Acrux Net: 1B supply, 800M on the curve, 30 AXB virtual, graduate at 20 AXB, 1% fee.
const LAUNCH_PARAMS = {
  feeBps: 100,
  totalSupply: new BN('1000000000000000'),
  curveSupply: new BN('800000000000000'),
  virtualQuote: new BN(30_000_000),
  virtualTokens: new BN('1073000000000000'),
  graduationQuote: new BN(20_000_000),
}
const POOL_SEED = { axa: 50_000_000n, axb: 100_000_000n } // 50 AXA : 100 AXB, the demo pool's 1:2 price

const conn = new Connection(RPC, 'confirmed')
const gw = new AcruxGateway(RPC)
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(DEPLOYER_FILE, 'utf8'))))
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), { commitment: 'confirmed' })
const say = (...a: unknown[]) => console.log(...a)
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(4)
const exists = async (k: PublicKey) => (await conn.getAccountInfo(k)) !== null
const report: Record<string, string> = {}

// ---- demo tokens (AXA/AXB): live from the gateway on Acrux, created locally otherwise
async function demoTokens(): Promise<{ AXA: PublicKey; AXB: PublicKey }> {
  if (IS_ACRUX) {
    const pool = await gw.call<{ mints: { address: string; symbol: string }[] }>('getDemoPool', {})
    const bySym = Object.fromEntries(pool.mints.map(m => [m.symbol, new PublicKey(m.address)]))
    return { AXA: bySym.AXA, AXB: bySym.AXB }
  }
  const stateFile = path('scripts/.redeploy-local.json')
  if (existsSync(stateFile)) {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (await exists(new PublicKey(s.AXA))) return { AXA: new PublicKey(s.AXA), AXB: new PublicKey(s.AXB) }
  }
  if (CHECK_ONLY) throw new Error('local demo tokens not created yet')
  const AXA = await createMint(conn, deployer, deployer.publicKey, null, 6)
  const AXB = await createMint(conn, deployer, deployer.publicKey, null, 6)
  for (const m of [AXA, AXB]) {
    const a = await getOrCreateAssociatedTokenAccount(conn, deployer, m, deployer.publicKey)
    await mintTo(conn, deployer, m, a.address, deployer, 1_000_000_000n)
  }
  writeFileSync(stateFile, JSON.stringify({ AXA: AXA.toBase58(), AXB: AXB.toBase58() }))
  return { AXA, AXB }
}

// ---- funding: faucet on Acrux (3 grants per key per 24 h), airdrop locally, else a top-up
async function ensureBalance(needLamports: number, why: string) {
  let bal = await conn.getBalance(deployer.publicKey)
  if (bal >= needLamports) return true
  if (!IS_ACRUX) {
    await conn.confirmTransaction(await conn.requestAirdrop(deployer.publicKey, needLamports - bal + LAMPORTS_PER_SOL), 'confirmed')
    return true
  }
  for (let i = 0; i < 3 && bal < needLamports; i++) {
    try {
      await gw.faucet(deployer.publicKey.toBase58())
      say(`  faucet grant ${i + 1} requested`)
      await new Promise(r => setTimeout(r, 4000))
    } catch (e: any) {
      say(`  faucet: ${String(e?.message ?? e).slice(0, 140)}`)
      break
    }
    bal = await conn.getBalance(deployer.publicKey)
  }
  if (bal >= needLamports) return true
  say(`\n  NEED ${sol(needLamports - bal)} more ACRUX for ${why}.`)
  say(`  Send it to the deployer: ${deployer.publicKey.toBase58()}`)
  if (!WAIT) return false
  say('  Waiting for the top-up (checking every 15 s; Ctrl+C to stop)...')
  while ((bal = await conn.getBalance(deployer.publicKey)) < needLamports) await new Promise(r => setTimeout(r, 15000))
  say(`  received, balance ${sol(bal)}`)
  return true
}

// ---- 1. programs
async function restorePrograms() {
  for (const p of PROGRAMS) {
    const info = await conn.getAccountInfo(p.id)
    if (info?.executable) { report[p.name] = `present at ${p.id.toBase58()}`; say(`✓ ${p.name} present`); continue }
    if (!existsSync(p.so) || !existsSync(p.key)) throw new Error(`missing ${p.so} or ${p.key}`)
    // The deploy holds the binary twice (buffer + program data) until the buffer is refunded.
    const size = statSync(p.so).size
    const need = 2 * (await conn.getMinimumBalanceForRentExemption(size + 45)) + 0.05 * LAMPORTS_PER_SOL
    say(`✗ ${p.name} missing: deploying (${(size / 1024).toFixed(0)} KB, needs ~${sol(need)} ACRUX)`)
    if (CHECK_ONLY) { report[p.name] = 'MISSING'; continue }
    if (!(await ensureBalance(need, `deploying the ${p.name}`))) { report[p.name] = 'MISSING (not enough ACRUX)'; return false }
    execFileSync('solana', ['program', 'deploy', '--use-rpc', '-u', RPC, '--keypair', DEPLOYER_FILE, '--program-id', p.key, p.so], { stdio: ['ignore', 'pipe', 'inherit'] })
    if (!(await conn.getAccountInfo(p.id))?.executable) throw new Error(`${p.name} deploy did not land`)
    report[p.name] = `REDEPLOYED at ${p.id.toBase58()}`
    say(`  ✓ deployed, balance now ${sol(await conn.getBalance(deployer.publicKey))}`)
  }
  return true
}

// ---- 2. the AXA/AXB pool
async function restorePool(tok: { AXA: PublicKey; AXB: PublicKey }) {
  const p = poolAddresses(tok.AXA, tok.AXB, 30)
  if (await exists(p.pool)) { report.pool = `present at ${p.pool.toBase58()}`; say('✓ AXA/AXB pool present'); return }
  say('✗ AXA/AXB pool missing: creating and seeding 50 AXA : 100 AXB')
  if (CHECK_ONLY) { report.pool = 'MISSING'; return }
  if (!(await ensureBalance(0.05 * LAMPORTS_PER_SOL, 'pool rent'))) { report.pool = 'MISSING (not enough ACRUX)'; return }
  const own = async (m: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(m, deployer.publicKey))).value.amount) } catch { return 0n } }
  if ((await own(tok.AXA)) < POOL_SEED.axa || (await own(tok.AXB)) < POOL_SEED.axb) {
    report.pool = 'MISSING (deployer needs 50 AXA + 100 AXB; one faucet grant gives 100 of each)'
    say('  skipped: ' + report.pool)
    return
  }
  const [ra, rb] = p.mintA.equals(tok.AXA) ? [POOL_SEED.axa, POOL_SEED.axb] : [POOL_SEED.axb, POOL_SEED.axa]
  const amm = ammProgram(provider)
  const tx = await amm.methods.addLiquidity(new BN(ra.toString()), new BN(rb.toString()), new BN(depositQuote(0n, 0n, 0n, ra, rb).lp.toString()))
    .accountsPartial({
      payer: deployer.publicKey, owner: deployer.publicKey, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint,
      ownerA: getAssociatedTokenAddressSync(p.mintA, deployer.publicKey), ownerB: getAssociatedTokenAddressSync(p.mintB, deployer.publicKey),
    })
    .preInstructions([await amm.methods.createPool(30).accountsPartial({ payer: deployer.publicKey, mintA: p.mintA, mintB: p.mintB }).instruction()])
    .transaction()
  await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: 'confirmed' })
  report.pool = `RECREATED at ${p.pool.toBase58()}`
  say(`  ✓ pool ${p.pool.toBase58()}`)
}

// ---- 3. launchpad config (quote AXB, fees to the treasury)
async function restoreLaunchpad(tok: { AXB: PublicKey }) {
  const lp = launchpadProgram(provider)
  const cfg = await lp.account.config.fetchNullable(launchConfig())
  if (cfg) {
    const ok = cfg.quoteMint.equals(tok.AXB)
    report.launchpad = `initialized (quote ${ok ? 'AXB' : 'MISMATCH: ' + cfg.quoteMint.toBase58()}, fees to ${cfg.params.feeRecipient.toBase58()})`
    say(`✓ launchpad initialized${ok ? '' : ' — WARNING: quote mint is not the live AXB'}`)
    return
  }
  say('✗ launchpad not initialized: initializing (quote AXB, fees to treasury)')
  if (CHECK_ONLY) { report.launchpad = 'NOT INITIALIZED'; return }
  const programData = PublicKey.findProgramAddressSync([LAUNCHPAD_ID.toBytes()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0]
  const feeAta = getAssociatedTokenAddressSync(tok.AXB, TREASURY, true)
  const tx = await lp.methods.initialize({ ...LAUNCH_PARAMS, feeRecipient: TREASURY })
    .accountsPartial({ admin: deployer.publicKey, quoteMint: tok.AXB, program: LAUNCHPAD_ID, programData })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, feeAta, TREASURY, tok.AXB)])
    .transaction()
  await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: 'confirmed' })
  report.launchpad = `INITIALIZED (quote AXB, fees to treasury ${TREASURY.toBase58()})`
  say('  ✓ initialized')
}

// ---- run
const genesis = await conn.getGenesisHash()
say(`AcruxHub restore on ${RPC}${CHECK_ONLY ? ' (check only)' : ''}`)
say(`genesis ${genesis} | deployer ${deployer.publicKey.toBase58()} balance ${sol(await conn.getBalance(deployer.publicKey))}\n`)
if (!IS_ACRUX && !CHECK_ONLY && (await conn.getBalance(deployer.publicKey)) < LAMPORTS_PER_SOL) {
  await conn.confirmTransaction(await conn.requestAirdrop(deployer.publicKey, 5 * LAMPORTS_PER_SOL), 'confirmed')
}
const tokens = await demoTokens()
say(`demo tokens: AXA ${tokens.AXA.toBase58()} | AXB ${tokens.AXB.toBase58()}`)
const programsOk = await restorePrograms()
if (programsOk && (await conn.getAccountInfo(AMM_ID))?.executable) await restorePool(tokens)
if (programsOk && (await conn.getAccountInfo(LAUNCHPAD_ID))?.executable) await restoreLaunchpad(tokens)

say('\nSummary:')
for (const [k, v] of Object.entries(report)) say(`  ${k.padEnd(10)} ${v}`)
if (IS_ACRUX && !CHECK_ONLY) {
  writeFileSync(path('scripts/acrux-net-state.json'), JSON.stringify({ checkedAt: new Date().toISOString(), genesis, tokens: { AXA: tokens.AXA.toBase58(), AXB: tokens.AXB.toBase58() }, report }, null, 2) + '\n')
}
const missing = Object.values(report).some(v => /MISSING|NOT INITIALIZED/.test(v))
process.exit(missing ? 2 : 0)
