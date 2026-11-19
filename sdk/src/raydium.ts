// Raydium CPMM on Acrux Net. Acrux placed Raydium's mainnet CPMM program at its
// mainnet address (slot 1,100,000), with all 25 fee tiers, so pools made with
// Raydium's own SDK exist on Acrux but no Raydium site shows them. These helpers
// read those pools, quote them exactly as the program computes, and build the
// swap instruction, with no dependency on Raydium's SDK (it is too heavy for the
// browser bundle). tests/raydium.test.ts checks the math against Raydium's SDK.

import { PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha256'

export const RAYDIUM_CPMM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
export const RAYDIUM_CPMM_AUTHORITY = PublicKey.findProgramAddressSync(
  [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
  RAYDIUM_CPMM_ID,
)[0]

/** Raydium's fee rates are parts per million. */
export const FEE_RATE_DENOMINATOR = 1_000_000n

const disc = (name: string) => Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8))
const POOL_DISC = disc('PoolState')
const CONFIG_DISC = disc('AmmConfig')
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222])
export const CPMM_POOL_SIZE = 637
export const CPMM_CONFIG_SIZE = 236

export type CpmmConfig = {
  address: PublicKey
  index: number
  tradeFeeRate: bigint
  protocolFeeRate: bigint
  fundFeeRate: bigint
  creatorFeeRate: bigint
}

export type CpmmPool = {
  address: PublicKey
  config: PublicKey
  vaultA: PublicKey
  vaultB: PublicKey
  lpMint: PublicKey
  mintA: PublicKey
  mintB: PublicKey
  programA: PublicKey
  programB: PublicKey
  observation: PublicKey
  status: number
  decimalsA: number
  decimalsB: number
  lpSupply: bigint
  /** Fees held in the vaults that belong to Raydium/creator, not to the curve. */
  heldFeesA: bigint
  heldFeesB: bigint
  openTime: bigint
  /** 0 both tokens, 1 only token A, 2 only token B. */
  creatorFeeOn: number
  enableCreatorFee: boolean
}

const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32))
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o)

export function decodeCpmmConfig(address: PublicKey, d: Buffer): CpmmConfig {
  if (d.length !== CPMM_CONFIG_SIZE || !d.subarray(0, 8).equals(CONFIG_DISC)) throw new Error('not a CPMM AmmConfig')
  return {
    address,
    index: d.readUInt16LE(10),
    tradeFeeRate: u64(d, 12),
    protocolFeeRate: u64(d, 20),
    fundFeeRate: u64(d, 28),
    creatorFeeRate: u64(d, 108),
  }
}

export function decodeCpmmPool(address: PublicKey, d: Buffer): CpmmPool {
  if (d.length !== CPMM_POOL_SIZE || !d.subarray(0, 8).equals(POOL_DISC)) throw new Error('not a CPMM PoolState')
  return {
    address,
    config: pk(d, 8),
    vaultA: pk(d, 72),
    vaultB: pk(d, 104),
    lpMint: pk(d, 136),
    mintA: pk(d, 168),
    mintB: pk(d, 200),
    programA: pk(d, 232),
    programB: pk(d, 264),
    observation: pk(d, 296),
    status: d[329],
    decimalsA: d[331],
    decimalsB: d[332],
    lpSupply: u64(d, 333),
    heldFeesA: u64(d, 341) + u64(d, 357) + u64(d, 397), // protocol + fund + creator
    heldFeesB: u64(d, 349) + u64(d, 365) + u64(d, 405),
    openTime: u64(d, 373),
    creatorFeeOn: d[389],
    enableCreatorFee: d[390] !== 0,
  }
}

/** Pool status bit 2 set = swaps disabled by Raydium. */
export const cpmmSwapEnabled = (p: CpmmPool, nowSec = BigInt(Math.floor(Date.now() / 1000))) =>
  (p.status & 4) === 0 && nowSec > p.openTime

/**
 * Every CPMM pool and fee tier on the chain. Acrux's getProgramAccounts ignores
 * filters (memcmp, dataSize and dataSlice alike), so this reads every account the
 * program owns and sorts them by size and discriminator here.
 */
export async function loadCpmm(conn: Connection) {
  const raw = await conn.getProgramAccounts(RAYDIUM_CPMM_ID)
  const configs = new Map<string, CpmmConfig>()
  const pools: CpmmPool[] = []
  for (const r of raw) {
    const d = r.account.data as Buffer
    if (d.length === CPMM_CONFIG_SIZE && d.subarray(0, 8).equals(CONFIG_DISC)) configs.set(r.pubkey.toBase58(), decodeCpmmConfig(r.pubkey, d))
    else if (d.length === CPMM_POOL_SIZE && d.subarray(0, 8).equals(POOL_DISC)) pools.push(decodeCpmmPool(r.pubkey, d))
  }
  return { configs, pools }
}

const ceilDiv = (x: bigint, y: bigint) => (x + y - 1n) / y

/**
 * Exact-input swap through a CPMM pool, as the program computes it.
 * reserveIn/reserveOut are vault balances minus the pool's held fees.
 * aToB: input is the pool's token A (token 0).
 */
export function cpmmSwapOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  cfg: Pick<CpmmConfig, 'tradeFeeRate' | 'creatorFeeRate'>,
  pool: Pick<CpmmPool, 'enableCreatorFee' | 'creatorFeeOn'>,
  aToB: boolean,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const creatorRate = pool.enableCreatorFee ? cfg.creatorFeeRate : 0n
  const creatorOnInput = pool.creatorFeeOn === 0 || (pool.creatorFeeOn === 1) === aToB
  const tradeFee = ceilDiv(amountIn * cfg.tradeFeeRate, FEE_RATE_DENOMINATOR)
  let net = amountIn - tradeFee
  if (creatorOnInput) net -= ceilDiv(amountIn * creatorRate, FEE_RATE_DENOMINATOR)
  if (net <= 0n) return 0n
  const swapped = (net * reserveOut) / (reserveIn + net)
  return creatorOnInput ? swapped : swapped - ceilDiv(swapped * creatorRate, FEE_RATE_DENOMINATOR)
}

/** Total fee taken from the input, in parts per million (for display). */
export const cpmmFeePpm = (cfg: CpmmConfig, pool: CpmmPool) => cfg.tradeFeeRate + (pool.enableCreatorFee ? cfg.creatorFeeRate : 0n)

export function cpmmSwapInstruction(a: {
  pool: CpmmPool
  payer: PublicKey
  aToB: boolean
  userIn: PublicKey
  userOut: PublicKey
  amountIn: bigint
  minOut: bigint
}): TransactionInstruction {
  const p = a.pool
  const [vIn, vOut, progIn, progOut, mIn, mOut] = a.aToB
    ? [p.vaultA, p.vaultB, p.programA, p.programB, p.mintA, p.mintB]
    : [p.vaultB, p.vaultA, p.programB, p.programA, p.mintB, p.mintA]
  const data = Buffer.alloc(24)
  SWAP_BASE_INPUT.copy(data, 0)
  data.writeBigUInt64LE(a.amountIn, 8)
  data.writeBigUInt64LE(a.minOut, 16)
  const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
  return new TransactionInstruction({
    programId: RAYDIUM_CPMM_ID,
    keys: [
      m(a.payer, false, true),
      m(RAYDIUM_CPMM_AUTHORITY),
      m(p.config),
      m(p.address, true),
      m(a.userIn, true),
      m(a.userOut, true),
      m(vIn, true),
      m(vOut, true),
      m(progIn),
      m(progOut),
      m(mIn),
      m(mOut),
      m(p.observation, true),
    ],
    data,
  })
}

// ------------------------------------------------------------------ platform fee

/** AcruxHub's swap fee, taken from the input on every swap made through the site. */
export const PLATFORM_FEE_BPS = 10

/** Splits an input amount into AcruxHub's fee (rounded up) and what gets swapped. */
export function platformFee(amountIn: bigint, bps = PLATFORM_FEE_BPS) {
  const fee = bps > 0 && amountIn > 0n ? ceilDiv(amountIn * BigInt(bps), 10_000n) : 0n
  return { fee, net: amountIn - fee }
}
