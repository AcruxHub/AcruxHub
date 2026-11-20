// The site works with both launchpad builds: the one live on Acrux Net now, and the
// upgrade in this repo (pairs, pause, quote switch). They take different accounts,
// so the site checks which build is deployed (by its program data size) and uses
// the matching IDL. The upgrade can then land without redeploying the site.
import * as anchor from '@coral-xyz/anchor'
import { PublicKey, type Connection } from '@solana/web3.js'
import { launchpadProgram } from '@acruxhub/sdk'
import liveV1 from './idl-launchpad-live-v1.json'
import type { Network } from './net.ts'

/** The launchpad's program data account (holds the deployed binary). */
const PROGRAM_DATA = new PublicKey('JGZFP11vsgFPoQJAvYDfzE8LF9NeVFMfa2tJSozs5CE')
/** Size of the upgraded build; anything smaller is the live v1. */
export const UPGRADED_BYTES = 633_168

const cache = new Map<string, Promise<boolean>>()

/** True when the deployed launchpad is the upgraded build. Local dev chains always run it. */
export function launchpadUpgraded(network: Network, conn: Connection): Promise<boolean> {
  if (network.id === 'local') return Promise.resolve(true)
  const key = conn.rpcEndpoint
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const r = await fetch(conn.rpcEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [PROGRAM_DATA.toBase58(), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }] }),
        }).then(r => r.json())
        const space = r?.result?.value?.space ?? 0
        return space - 45 >= UPGRADED_BYTES
      } catch {
        return false
      }
    })())
  }
  return cache.get(key)!
}

/** The launchpad client for the deployed build. */
export function launchpadFor(provider: anchor.Provider, upgraded: boolean): anchor.Program<any> {
  return upgraded ? (launchpadProgram(provider) as anchor.Program<any>) : new anchor.Program(liveV1 as anchor.Idl, provider)
}
