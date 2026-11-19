// Pair keeper: approves launchpad pairs by liquidity on Acrux (rules in
// scripts/pair-rules.ts). Reads every AcruxHub AMM and Raydium CPMM pool that
// pairs a token with the launchpad's default quote, decides, and sends set_pair
// signed by the PAIR APPROVER key, a key the admin names with set_pair_approver
// that can only approve or disable pairs (the program forces fee, fee recipient
// and supply to the defaults for it).
//
// Prints its decisions and changes nothing unless you add --yes.
//   RPC=<url> node --import tsx scripts/pair-keeper.ts [--yes]
// Signer: PAIR_APPROVER_KEY (JSON byte array) or keys/acrux-pair-approver.json.
// Tuning (env): PAIR_MIN_LIQUIDITY, PAIR_DELIST_LIQUIDITY, PAIR_SUSTAIN_HOURS, PAIR_MAX_PAIRS.
// State (env PAIR_STATE, default pair-keeper-state.json) remembers how long each
// token has been above or below the line between runs; actions are appended to
// PAIR_LOG (default pair-keeper-log.jsonl).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token'
import {
  launchpadProgram, ammProgram, launchConfig, launchPairAddress, allAccounts, loadCpmm, BN,
} from '../sdk/src/index.ts'
import { decide, DEFAULT_RULES, type PoolObs, type TokenInfo, type KeeperState, type PairNow } from './pair-rules.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const yes = process.argv.includes('--yes')
const STATE = process.env.PAIR_STATE ?? 'pair-keeper-state.json'
const LOG = process.env.PAIR_LOG ?? 'pair-keeper-log.jsonl'
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d)
const rules = {
  minLiquidity: num('PAIR_MIN_LIQUIDITY', DEFAULT_RULES.minLiquidity),
  delistLiquidity: num('PAIR_DELIST_LIQUIDITY', DEFAULT_RULES.delistLiquidity),
  sustainHours: num('PAIR_SUSTAIN_HOURS', DEFAULT_RULES.sustainHours),
  maxPairs: num('PAIR_MAX_PAIRS', DEFAULT_RULES.maxPairs),
}

const secret = process.env.PAIR_APPROVER_KEY ?? (existsSync('keys/acrux-pair-approver.json') ? readFileSync('keys/acrux-pair-approver.json', 'utf8') : null)
const signer = secret ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))) : null
if (yes && !signer) throw new Error('no pair approver key: set PAIR_APPROVER_KEY or keys/acrux-pair-approver.json')
const conn = new Connection(RPC, 'confirmed')
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(signer ?? Keypair.generate()), { commitment: 'confirmed' })
const lp = launchpadProgram(provider)
const amm = ammProgram(provider)

const cfg: any = await lp.account.config.fetch(launchConfig())
const quote = (cfg.quoteMint as PublicKey).toBase58()
const quoteDecimals = unpackMint(cfg.quoteMint, await conn.getAccountInfo(cfg.quoteMint)).decimals
const defaults = { virtualQuote: BigInt(cfg.params.virtualQuote.toString()), graduationQuote: BigInt(cfg.params.graduationQuote.toString()) }

const balances = async (keys: PublicKey[]) => {
  const out: bigint[] = []
  for (let i = 0; i < keys.length; i += 99) {
    for (const v of (await conn.getMultipleParsedAccounts(keys.slice(i, i + 99))).value) out.push(BigInt((v?.data as any)?.parsed?.info?.tokenAmount?.amount ?? 0))
  }
  return out
}

// Pools of each token against the default quote, from both venues.
const pools: Record<string, PoolObs[]> = {}
const add = (mintA: PublicKey, mintB: PublicKey, ra: bigint, rb: bigint, id: string) => {
  const [a, b] = [mintA.toBase58(), mintB.toBase58()]
  if (a !== quote && b !== quote) return
  const token = a === quote ? b : a
  ;(pools[token] ??= []).push({ pool: id, tokenReserve: a === quote ? rb : ra, quoteReserve: a === quote ? ra : rb })
}
const ammPools = (await allAccounts<any>(amm, 'Pool').catch(() => [])) as any[]
const ammBal = await balances(ammPools.flatMap(p => [p.account.vaultA, p.account.vaultB]))
ammPools.forEach((p, i) => add(p.account.mintA, p.account.mintB, ammBal[2 * i], ammBal[2 * i + 1], p.publicKey.toBase58()))
const { pools: ray } = await loadCpmm(conn).catch(() => ({ pools: [] as any[] }))
const rayBal = await balances(ray.flatMap((p: any) => [p.vaultA, p.vaultB]))
ray.forEach((p: any, i: number) => {
  if ((p.status & 4) !== 0) return // swaps disabled
  const ra = rayBal[2 * i] - p.heldFeesA, rb = rayBal[2 * i + 1] - p.heldFeesB
  add(p.mintA, p.mintB, ra > 0n ? ra : 0n, rb > 0n ? rb : 0n, p.address.toBase58())
})

// Token safety info for every candidate.
const tokens: Record<string, TokenInfo> = {}
const mints = Object.keys(pools)
for (let i = 0; i < mints.length; i += 99) {
  const chunk = mints.slice(i, i + 99)
  const infos = await conn.getMultipleAccountsInfo(chunk.map(m => new PublicKey(m)))
  chunk.forEach((m, j) => {
    const info = infos[j]
    if (!info) return
    const classic = info.owner.equals(TOKEN_PROGRAM_ID)
    try {
      const mi = unpackMint(new PublicKey(m), info, info.owner)
      tokens[m] = { mint: m, classic, mintAuthority: mi.mintAuthority?.toBase58() ?? null, freezeAuthority: mi.freezeAuthority?.toBase58() ?? null, decimals: mi.decimals }
    } catch { /* not a mint */ }
  })
}

const state: KeeperState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { mints: {}, managed: [] }
const pairs: Record<string, PairNow> = {}
for (const p of (await allAccounts<any>(lp, 'QuotePair').catch(() => [])) as any[]) {
  const m = (p.account.mint as PublicKey).toBase58()
  pairs[m] = { enabled: p.account.enabled, managed: state.managed.includes(m) }
}

const { actions, state: next, notes } = decide({ now: new Date(), rules, quoteDecimals, defaults, pools, tokens, pairs, state })
console.log(`default quote ${quote} · ${mints.length} tokens with pools · rules ${JSON.stringify(rules)}`)
for (const n of notes) console.log('note:', n)
if (!actions.length) console.log('no changes')

for (const act of actions) {
  const mint = new PublicKey(act.mint)
  console.log(`${act.type} ${act.mint}: ${act.reason}`)
  if (!yes) continue
  const params = act.type === 'approve'
    ? { ...cfg.params, virtualQuote: new BN(act.virtualQuote.toString()), graduationQuote: new BN(act.graduationQuote.toString()) }
    : (await lp.account.quotePair.fetch(launchPairAddress(mint))).params
  const sig = await lp.methods.setPair(params, act.type === 'approve')
    .accountsPartial({ authority: signer!.publicKey, config: launchConfig(), quoteMint: mint })
    .rpc()
  appendFileSync(LOG, JSON.stringify({ time: new Date().toISOString(), action: act.type, mint: act.mint, liquidity: act.liquidity, reason: act.reason, sig }) + '\n')
  console.log(`  sent ${sig}`)
}
if (yes) writeFileSync(STATE, JSON.stringify(next, null, 2) + '\n')
else console.log('\nDry run: state not saved. Add --yes to send and save.')
