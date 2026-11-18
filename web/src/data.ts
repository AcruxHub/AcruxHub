import { PublicKey, type Connection } from '@solana/web3.js'
import { getMint } from '@solana/spl-token'
import { ammProgram, launchpadProgram, launchConfig, allAccounts } from '@acruxhub/sdk'
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
