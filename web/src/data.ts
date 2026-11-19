import { PublicKey, type Connection } from '@solana/web3.js'
import { getMint, getTransferFeeConfig, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { ammProgram, launchpadProgram, launchConfig, allAccounts, swapOut, loadCpmm, cpmmSwapOut, cpmmFeePpm, cpmmSwapEnabled, RAYDIUM_CPMM_ID, type CpmmPool, type CpmmConfig } from '@acruxhub/sdk'
import { readProvider, } from './wallet.tsx'
import { KNOWN_TOKENS } from './net.ts'

export type PoolInfo = {
  address: PublicKey
  mintA: PublicKey
  mintB: PublicKey
  vaultA: PublicKey
  vaultB: PublicKey
  lpMint: PublicKey
  feeBps: number
  reserveA: bigint
  reserveB: bigint
  lpSupply: bigint
  decimalsA: number
  decimalsB: number
  swapCount: number
}

const decimalsCache = new Map<string, number>()
export async function decimalsOf(conn: Connection, mint: PublicKey) {
  const k = mint.toBase58()
  if (KNOWN_TOKENS[k]) return KNOWN_TOKENS[k].decimals
  if (!decimalsCache.has(k)) decimalsCache.set(k, (await getMint(conn, mint)).decimals)
  return decimalsCache.get(k)!
}

export async function loadPools(conn: Connection): Promise<PoolInfo[]> {
  const amm = ammProgram(readProvider(conn))
  const pools = await allAccounts<any>(amm, 'Pool')
  if (!pools.length) return []
  const keys = pools.flatMap(p => [p.account.vaultA, p.account.vaultB, p.account.lpMint])
  const infos: any[] = []
  for (let i = 0; i < keys.length; i += 99) {
    const chunk = await conn.getMultipleParsedAccounts(keys.slice(i, i + 99))
    infos.push(...chunk.value)
  }
  const out: PoolInfo[] = []
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i].account
    const [va, vb, lm] = infos.slice(i * 3, i * 3 + 3).map(x => (x?.data as any)?.parsed?.info)
    out.push({
      address: pools[i].publicKey,
      mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint,
      feeBps: p.feeBps,
      reserveA: BigInt(va?.tokenAmount?.amount ?? 0),
      reserveB: BigInt(vb?.tokenAmount?.amount ?? 0),
      lpSupply: BigInt(lm?.supply ?? 0),
      decimalsA: va?.tokenAmount?.decimals ?? 6,
      decimalsB: vb?.tokenAmount?.decimals ?? 6,
      swapCount: p.swapCount.toNumber(),
    })
  }
  return out.sort((a, b) => b.swapCount - a.swapCount)
}

/** Launch symbols by mint, so launched tokens show their tickers everywhere. */
export async function launchSymbols(conn: Connection): Promise<Record<string, string>> {
  try {
    const lp = launchpadProgram(readProvider(conn))
    const all = await allAccounts<any>(lp, 'Launch')
    return Object.fromEntries(all.map(l => [l.account.mint.toBase58(), l.account.symbol]))
  } catch {
    return {}
  }
}

export async function loadLaunchConfig(conn: Connection) {
  const lp = launchpadProgram(readProvider(conn))
  return lp.account.config.fetchNullable(launchConfig())
}

// ------------------------------------------------------------------ markets (AcruxHub AMM + Raydium CPMM)

/** One place a pair can be swapped: an AcruxHub AMM pool or a Raydium CPMM pool. */
export type Market = {
  kind: 'acruxhub' | 'raydium'
  address: PublicKey
  mintA: PublicKey
  mintB: PublicKey
  programA: PublicKey
  programB: PublicKey
  decimalsA: number
  decimalsB: number
  reserveA: bigint
  reserveB: bigint
  /** Pool fee in parts per million, for display. */
  feePpm: bigint
  swapEnabled: boolean
  /** Why this market can't be used, when swapEnabled is false. */
  note?: string
  amm?: PoolInfo
  raydium?: { pool: CpmmPool; config: CpmmConfig }
}

export const marketName = (m: Market) => (m.kind === 'raydium' ? 'Raydium CPMM' : 'AcruxHub AMM')

/** Raydium CPMM pools on this chain, with live reserves. Empty where Raydium isn't deployed. */
export async function loadRaydiumMarkets(conn: Connection): Promise<Market[]> {
  if (!(await conn.getAccountInfo(RAYDIUM_CPMM_ID))?.executable) return []
  const { configs, pools } = await loadCpmm(conn)
  if (!pools.length) return []
  const vaults = pools.flatMap(p => [p.vaultA, p.vaultB])
  const infos: any[] = []
  for (let i = 0; i < vaults.length; i += 99) infos.push(...(await conn.getMultipleParsedAccounts(vaults.slice(i, i + 99))).value)
  const out: Market[] = []
  pools.forEach((pool, i) => {
    const config = configs.get(pool.config.toBase58())
    const va = BigInt((infos[i * 2]?.data as any)?.parsed?.info?.tokenAmount?.amount ?? 0)
    const vb = BigInt((infos[i * 2 + 1]?.data as any)?.parsed?.info?.tokenAmount?.amount ?? 0)
    if (!config) return
    out.push({
      kind: 'raydium',
      address: pool.address,
      mintA: pool.mintA, mintB: pool.mintB, programA: pool.programA, programB: pool.programB,
      decimalsA: pool.decimalsA, decimalsB: pool.decimalsB,
      reserveA: va > pool.heldFeesA ? va - pool.heldFeesA : 0n,
      reserveB: vb > pool.heldFeesB ? vb - pool.heldFeesB : 0n,
      feePpm: cpmmFeePpm(config, pool),
      swapEnabled: cpmmSwapEnabled(pool),
      raydium: { pool, config },
    })
  })
  // Token-2022 mints with a transfer fee change what arrives, so the quote here
  // would be wrong. Leave those pools out of routing rather than misquote them.
  const t22 = [...new Set(out.flatMap(m => [[m.mintA, m.programA], [m.mintB, m.programB]])
    .filter(([, p]) => (p as PublicKey).equals(TOKEN_2022_PROGRAM_ID)).map(([k]) => (k as PublicKey).toBase58()))]
  const feeMints = new Set<string>()
  for (const k of t22) {
    try { if (getTransferFeeConfig(await getMint(conn, new PublicKey(k), 'confirmed', TOKEN_2022_PROGRAM_ID))) feeMints.add(k) } catch { feeMints.add(k) }
  }
  for (const m of out) {
    if (!m.swapEnabled) m.note = 'swaps paused or not open yet'
    if (feeMints.has(m.mintA.toBase58()) || feeMints.has(m.mintB.toBase58())) { m.swapEnabled = false; m.note = 'Token-2022 transfer fee, not supported yet' }
  }
  return out
}

export async function loadMarkets(conn: Connection): Promise<Market[]> {
  const [amm, ray] = await Promise.all([
    loadPools(conn).catch(() => [] as PoolInfo[]),
    loadRaydiumMarkets(conn).catch(() => [] as Market[]),
  ])
  const ours: Market[] = amm.map(p => ({
    kind: 'acruxhub',
    address: p.address, mintA: p.mintA, mintB: p.mintB, programA: TOKEN_PROGRAM_ID, programB: TOKEN_PROGRAM_ID,
    decimalsA: p.decimalsA, decimalsB: p.decimalsB, reserveA: p.reserveA, reserveB: p.reserveB,
    feePpm: BigInt(p.feeBps) * 100n, swapEnabled: true, amm: p,
  }))
  return [...ours, ...ray].filter(m => m.reserveA > 0n && m.reserveB > 0n)
}

/** Exact output of swapping `amountIn` (after AcruxHub's fee) through a market. */
export function marketQuote(m: Market, amountIn: bigint, aToB: boolean): bigint {
  const [ri, ro] = aToB ? [m.reserveA, m.reserveB] : [m.reserveB, m.reserveA]
  if (m.kind === 'raydium') return cpmmSwapOut(amountIn, ri, ro, m.raydium!.config, m.raydium!.pool, aToB)
  return swapOut(amountIn, ri, ro, m.amm!.feeBps)
}
