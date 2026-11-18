import { useEffect, useState } from 'react'
import { PublicKey, type Connection } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { AMM_ID, LAUNCHPAD_ID, BRIDGE_ID } from '@acruxhub/sdk'
import { KNOWN_TOKENS } from './net.ts'

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
export function tokenLabel(mint: string, extra?: Record<string, string>) {
  return KNOWN_TOKENS[mint]?.symbol ?? extra?.[mint] ?? symbolCache.get(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`
}
export function rememberSymbol(mint: string, symbol: string) {
  symbolCache.set(mint, symbol)
}
