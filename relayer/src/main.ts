// Guardian daemon. Config by environment:
//   SOLANA_RPC, ACRUX_RPC        RPC URLs of the two chains
//   GUARDIAN_KEY                 path to this guardian's keypair JSON
//   INTERVAL_MS (default 5000)   poll interval
import { readFileSync } from 'node:fs'
import { Connection, Keypair } from '@solana/web3.js'
import { CHAIN } from '../../sdk/src/programs.ts'
import { relayOnce } from './guardian.ts'

const need = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} is required`) })()
const guardian = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need('GUARDIAN_KEY'), 'utf8'))))
const solana = { conn: new Connection(need('SOLANA_RPC'), 'confirmed'), chainId: CHAIN.solana }
const acrux = { conn: new Connection(need('ACRUX_RPC'), 'confirmed'), chainId: CHAIN.acrux }
const interval = Number(process.env.INTERVAL_MS ?? 5000)
const log = (m: string) => console.log(new Date().toISOString(), m)

log(`guardian ${guardian.publicKey.toBase58()} starting`)
for (;;) {
  for (const [src, dst] of [[solana, acrux], [acrux, solana]] as const) {
    try {
      await relayOnce(src, dst, guardian, log, 'finalized')
    } catch (e: any) {
      log(`pass ${src.chainId}->${dst.chainId} failed: ${e?.message ?? e}`)
    }
  }
  await new Promise(r => setTimeout(r, interval))
}
