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

// ------------------------------------------------------------------ create pool, add and remove liquidity

const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111')
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const INITIALIZE = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237])
const DEPOSIT = Buffer.from([242, 35, 198, 137, 82, 225, 242, 182])
const WITHDRAW = Buffer.from([183, 18, 70, 156, 148, 109, 161, 34])

/** Receives Raydium's pool-creation fee (placed on Acrux with the program). */
export const RAYDIUM_CPMM_CREATE_FEE_RECEIVER = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')
/** LP the program locks in every new pool so it can never be emptied. */
export const CPMM_LOCKED_LP = 100n
export const CPMM_LP_DECIMALS = 9

/** Config fields beyond the fee rates, for the create-pool form. */
export function decodeCpmmConfigExtra(d: Buffer) {
  return { disableCreatePool: d[9] !== 0, createPoolFee: d.readBigUInt64LE(36) }
}

const seed = (s: string) => new TextEncoder().encode(s)
const find = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM_ID)[0]

/** Every address of the canonical (PDA) pool for a fee tier and two mints, in program order (token 0 < token 1). */
export function cpmmPoolAddresses(config: PublicKey, mintX: PublicKey, mintY: PublicKey) {
  const [mint0, mint1] = Buffer.compare(mintX.toBuffer(), mintY.toBuffer()) < 0 ? [mintX, mintY] : [mintY, mintX]
  const pool = find([seed('pool'), config.toBytes(), mint0.toBytes(), mint1.toBytes()])
  return {
    mint0, mint1, pool,
    lpMint: find([seed('pool_lp_mint'), pool.toBytes()]),
    vault0: find([seed('pool_vault'), pool.toBytes(), mint0.toBytes()]),
    vault1: find([seed('pool_vault'), pool.toBytes(), mint1.toBytes()]),
    observation: find([seed('observation'), pool.toBytes()]),
  }
}

const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
const u64s = (disc: Buffer, ...vals: bigint[]) => {
  const d = Buffer.alloc(8 + vals.length * 8)
  disc.copy(d, 0)
  vals.forEach((v, i) => d.writeBigUInt64LE(v, 8 + i * 8))
  return d
}

/** Creates a pool and makes its first deposit, which sets the price. */
export function cpmmInitializeInstruction(a: {
  creator: PublicKey
  config: PublicKey
  mint0: PublicKey
  mint1: PublicKey
  program0: PublicKey
  program1: PublicKey
  /** The creator's token accounts for token 0 and 1, and their LP ATA (created by the program). */
  user0: PublicKey
  user1: PublicKey
  userLp: PublicKey
  amount0: bigint
  amount1: bigint
  openTime?: bigint
}): TransactionInstruction {
  const p = cpmmPoolAddresses(a.config, a.mint0, a.mint1)
  if (!p.mint0.equals(a.mint0)) throw new Error('mint0 must sort before mint1')
  return new TransactionInstruction({
    programId: RAYDIUM_CPMM_ID,
    keys: [
      m(a.creator, true, true), // the program pays rent and the creation fee from it
      m(a.config),
      m(RAYDIUM_CPMM_AUTHORITY),
      m(p.pool, true),
      m(a.mint0),
      m(a.mint1),
      m(p.lpMint, true),
      m(a.user0, true),
      m(a.user1, true),
      m(a.userLp, true),
      m(p.vault0, true),
      m(p.vault1, true),
      m(RAYDIUM_CPMM_CREATE_FEE_RECEIVER, true),
      m(p.observation, true),
      m(TOKEN_PROGRAM),
      m(a.program0),
      m(a.program1),
      m(ATA_PROGRAM),
      m(SYSTEM_PROGRAM),
      m(RENT_SYSVAR),
    ],
    data: u64s(INITIALIZE, a.amount0, a.amount1, a.openTime ?? 0n),
  })
}

/** LP the creator receives from a new pool: sqrt(amount0 * amount1) minus the locked part. */
export function cpmmInitialLp(amount0: bigint, amount1: bigint) {
  let x = amount0 * amount1
  if (x < 2n) return 0n
  let y = (x + 1n) / 2n
  let r = x
  while (y < r) { r = y; y = (r + x / r) / 2n }
  return r > CPMM_LOCKED_LP ? r - CPMM_LOCKED_LP : 0n
}

/**
 * Tokens for an LP amount, as the program computes them: rounded up for a
 * deposit (what you must put in), down for a withdrawal (what you get back).
 */
export function cpmmLpToTokens(lp: bigint, lpSupply: bigint, reserve0: bigint, reserve1: bigint, roundUp: boolean) {
  if (lpSupply === 0n) return { amount0: 0n, amount1: 0n }
  const conv = (r: bigint) => {
    const q = (lp * r) / lpSupply
    return roundUp && (lp * r) % lpSupply > 0n && q > 0n ? q + 1n : q
  }
  return { amount0: conv(reserve0), amount1: conv(reserve1) }
}

/** The deposit for a chosen amount of one token: LP minted and what both sides cost. */
export function cpmmDepositQuote(amountIn: bigint, side: 0 | 1, lpSupply: bigint, reserve0: bigint, reserve1: bigint) {
  const lp = (amountIn * lpSupply) / (side === 0 ? reserve0 : reserve1)
  return { lp, ...cpmmLpToTokens(lp, lpSupply, reserve0, reserve1, true) }
}

type LiqAccounts = {
  pool: CpmmPool
  owner: PublicKey
  userLp: PublicKey
  /** Owner's token accounts for the pool's token A (0) and B (1). */
  user0: PublicKey
  user1: PublicKey
}
const liqKeys = (a: LiqAccounts) => [
  m(a.owner, false, true),
  m(RAYDIUM_CPMM_AUTHORITY),
  m(a.pool.address, true),
  m(a.userLp, true),
  m(a.user0, true),
  m(a.user1, true),
  m(a.pool.vaultA, true),
  m(a.pool.vaultB, true),
  m(TOKEN_PROGRAM),
  m(TOKEN_2022_PROGRAM),
  m(a.pool.mintA),
  m(a.pool.mintB),
  m(a.pool.lpMint, true),
]

/** Mints `lp` LP for at most max0/max1 of the two tokens. */
export function cpmmDepositInstruction(a: LiqAccounts & { lp: bigint; max0: bigint; max1: bigint }) {
  return new TransactionInstruction({ programId: RAYDIUM_CPMM_ID, keys: liqKeys(a), data: u64s(DEPOSIT, a.lp, a.max0, a.max1) })
}

/** Burns `lp` LP for at least min0/min1 of the two tokens. */
export function cpmmWithdrawInstruction(a: LiqAccounts & { lp: bigint; min0: bigint; min1: bigint }) {
  return new TransactionInstruction({ programId: RAYDIUM_CPMM_ID, keys: [...liqKeys(a), m(MEMO_PROGRAM)], data: u64s(WITHDRAW, a.lp, a.min0, a.min1) })
}

export type CpmmFeeTier = CpmmConfig & { disableCreatePool: boolean; createPoolFee: bigint }

/** The fee tiers (AmmConfig index 0..max) a pool can be created on, read in one call. */
export async function loadCpmmFeeTiers(conn: Connection, max = 32): Promise<CpmmFeeTier[]> {
  const ids = Array.from({ length: max }, (_, i) => {
    const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, i, false)
    return find([seed('amm_config'), b])
  })
  const infos = await conn.getMultipleAccountsInfo(ids)
  const out: CpmmFeeTier[] = []
  infos.forEach((info, i) => {
    if (!info || !info.owner.equals(RAYDIUM_CPMM_ID)) return
    const d = info.data as Buffer
    try { out.push({ ...decodeCpmmConfig(ids[i], d), ...decodeCpmmConfigExtra(d) }) } catch { /* not a config */ }
  })
  return out.sort((a, b) => (a.tradeFeeRate === b.tradeFeeRate ? a.index - b.index : a.tradeFeeRate < b.tradeFeeRate ? -1 : 1))
}
