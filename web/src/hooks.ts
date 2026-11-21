import { useEffect, useState } from 'react'
import { PublicKey, type Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { AMM_ID, LAUNCHPAD_ID, BRIDGE_ID, wacruxMint } from '@acruxhub/sdk'
import { KNOWN_TOKENS } from './net.ts'
import { API_BASE } from './native.ts'

// ---- ACRUX in US dollars (from /api/price: Jupiter, then DexScreener) ----
let usdCache: { at: number; p: Promise<number | null> } | null = null
export function acruxUsdPrice(): Promise<number | null> {
  if (usdCache && Date.now() - usdCache.at < 60_000) return usdCache.p
  const p = fetch(`${API_BASE || location.origin}/api/price`)
    .then(r => (r.ok ? r.json() : null))
    .then(j => (j && Number(j.acruxUsd) > 0 ? Number(j.acruxUsd) : null))
    .catch(() => null)
  usdCache = { at: Date.now(), p }
  return p
}
/** ACRUX's dollar price, refreshed every minute; null until known (or if no source answers). */
export function useAcruxUsd() {
  const [p, setP] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const go = () => acruxUsdPrice().then(v => { if (live && v) setP(v) })
    go()
    const t = setInterval(go, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [])
  return p
}
/** Dollars, short: $1.23M, $555.2K, $12.34, $0.000809. */
export function usd(n: number) {
  if (!isFinite(n) || n <= 0) return '$0'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(3)}`
}

export type Holding = { mint: string; amount: bigint; decimals: number; account: string }

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; loading: boolean } {
  const [state, set] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  useEffect(() => {
    let live = true
    set(s => ({ ...s, loading: true }))
    fn().then(
      data => live && set({ data, error: null, loading: false }),
      e => live && set({ data: undefined, error: e?.message ?? String(e), loading: false }),
    )
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

export async function holdings(conn: Connection, owner: PublicKey): Promise<Holding[]> {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })
  return res.value.map(({ pubkey, account }) => {
    const info = (account.data as any).parsed.info
    return { mint: info.mint, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, account: pubkey.toBase58() }
  })
}

/** Which AcruxHub programs are deployed on this network. */
export async function deployed(conn: Connection) {
  const infos = await conn.getMultipleAccountsInfo([AMM_ID, LAUNCHPAD_ID, BRIDGE_ID])
  return { amm: !!infos[0]?.executable, launchpad: !!infos[1]?.executable, bridge: !!infos[2]?.executable }
}

const symbolCache = new Map<string, string>()
/** Our wrapped ACRUX shows as plain ACRUX: it is 1:1 and the site wraps for you. */
export const WACRUX = wacruxMint().toBase58()

export function tokenLabel(mint: string, extra?: Record<string, string>) {
  if (mint === WACRUX) return 'ACRUX'
  return KNOWN_TOKENS[mint]?.symbol ?? extra?.[mint] ?? symbolCache.get(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`
}
export function rememberSymbol(mint: string, symbol: string) {
  symbolCache.set(mint, symbol)
}
