// Shared setup for the token launch: network, wallets, Raydium SDK, state file.
//
// Networks:
//   local   — a local validator with Raydium's REAL mainnet programs cloned in
//             (scripts/raydium-localnet.sh). Free; used for testing.
//   mainnet — Solana mainnet. Real money: these scripts print what they will do
//             and refuse to run without --yes.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { Raydium, TxVersion } from '@raydium-io/raydium-sdk-v2'

export const NETWORK = (process.env.NETWORK ?? 'local') as 'local' | 'mainnet'
export const RPC = process.env.RPC ?? (NETWORK === 'local' ? 'http://127.0.0.1:8899' : 'https://api.mainnet-beta.solana.com')

/** Raydium mainnet addresses (cloned as-is into the local validator). */
export const RAY = {
  cpmmProgram: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  cpmmPoolFeeAccount: new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'),
  lockProgram: new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'),
  lockAuth: new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH'),
}

/** Raydium CPMM fee tier index 0 (from api-v3.raydium.io/main/cpmm-config): 0.25% trade fee. */
export const FEE_CONFIG = {
  id: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',
  index: 0,
  protocolFeeRate: 120000,
  tradeFeeRate: 2500,
  fundFeeRate: 40000,
  createPoolFee: '150000000',
  creatorFeeRate: 500,
}

/** The real ACRUX mint on Solana mainnet. Locally a stand-in mint is created. */
export const ACRUX_MAINNET = new PublicKey('7Evw4uxTxLGGEFEvXLUNYyc1J7PnFk9EYwTUFagARUX')

export const conn = new Connection(RPC, 'confirmed')
export const txVersion = TxVersion.V0

const keyDir = new URL('../../keys/', import.meta.url)
export function wallet(name: string): Keypair {
  const file = new URL(`${NETWORK}-${name}.json`, keyDir)
  if (!existsSync(file)) {
    if (NETWORK === 'mainnet') throw new Error(`missing key keys/${NETWORK}-${name}.json`)
    const kp = Keypair.generate()
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)))
    return kp
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))))
}

export async function raydiumFor(owner: Keypair) {
  return Raydium.load({
    connection: conn,
    owner,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'confirmed',
  })
}

// --- state: what was created, so later steps and the keeper can find it ---
export type State = {
  network: string
  token?: { mint: string; decimals: number; supply: string; name: string; symbol: string }
  quote?: { mint: string; decimals: number }
  pool?: { id: string; lpMint: string; mintA: string; mintB: string }
  lock?: { nftMint: string; lpLocked: string; owner: string }
}
const stateFile = new URL(`../state-${NETWORK}.json`, import.meta.url)
export const loadState = (): State => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { network: NETWORK })
export const saveState = (s: State) => writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\n')

/** Append-only public log of every keeper action (one JSON object per line). */
const logFile = new URL(`../keeper-log-${NETWORK}.jsonl`, import.meta.url)
export function logAction(entry: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), network: NETWORK, ...entry })
  appendFileSync(logFile, line + '\n')
  console.log(line)
}

/** Swaps an exact input on our CPMM pool; returns the quoted output (raw units). */
export async function swapExactIn(raydium: Awaited<ReturnType<typeof raydiumFor>>, poolId: string, inputMint: string, amountIn: bigint, slippage = 0.01) {
  const { CurveCalculator } = await import('@raydium-io/raydium-sdk-v2')
  const BN = (await import('bn.js')).default
  await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true })
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(poolId)
  const baseIn = inputMint === poolInfo.mintA.address
  const cfg = rpcData.configInfo!
  const creatorRate = rpcData.enableCreatorFee ? cfg.creatorFeeRate : new BN(0)
  const result = CurveCalculator.swapBaseInput(
    new BN(amountIn.toString()),
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    cfg.tradeFeeRate, creatorRate, cfg.protocolFeeRate, cfg.fundFeeRate,
    rpcData.feeOn === 0 || (rpcData.feeOn === 1) === baseIn,
  )
  const { execute } = await raydium.cpmm.swap({ poolInfo, poolKeys, inputAmount: new BN(amountIn.toString()), swapResult: result, slippage, baseIn, txVersion })
  const { txId } = await execute({ sendAndConfirm: true })
  return { out: BigInt(result.outputAmount.toString()), txId }
}

export function requireYes(summary: string) {
  if (NETWORK !== 'mainnet') return
  console.log(`\nMAINNET — real money:\n${summary}\n`)
  if (!process.argv.includes('--yes')) {
    console.log('Dry run only. Re-run with --yes to execute.')
    process.exit(0)
  }
}

export const fmt = (raw: bigint, decimals: number) => {
  const s = raw.toString().padStart(decimals + 1, '0')
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '')
}
