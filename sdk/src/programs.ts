// Typed clients, PDA helpers and off-chain quote math (mirrors the on-chain Rust
// exactly, in bigint) for the three AcruxHub programs.

import * as anchor from '@coral-xyz/anchor'
import { Program, type Provider } from '@coral-xyz/anchor'
import { PublicKey, type Connection } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import ammIdl from './idl/acruxhub_amm.json' with { type: 'json' }
import launchpadIdl from './idl/acruxhub_launchpad.json' with { type: 'json' }
import bridgeIdl from './idl/acruxhub_bridge.json' with { type: 'json' }
import type { AcruxhubAmm } from './idl/acruxhub_amm.ts'
import type { AcruxhubLaunchpad } from './idl/acruxhub_launchpad.ts'
import type { AcruxhubBridge } from './idl/acruxhub_bridge.ts'
import { sha256 } from '@noble/hashes/sha256'
import { cpmmPoolAddresses, RAYDIUM_CPMM_AUTHORITY, RAYDIUM_CPMM_CREATE_FEE_RECEIVER, RAYDIUM_CPMM_ID } from './raydium.ts'

export type { AcruxhubAmm, AcruxhubLaunchpad, AcruxhubBridge }
export const AMM_ID = new PublicKey(ammIdl.address)
export const LAUNCHPAD_ID = new PublicKey(launchpadIdl.address)
export const BRIDGE_ID = new PublicKey(bridgeIdl.address)

export const ammProgram = (p: Provider) => new Program<AcruxhubAmm>(ammIdl as AcruxhubAmm, p)
export const launchpadProgram = (p: Provider) => new Program<AcruxhubLaunchpad>(launchpadIdl as AcruxhubLaunchpad, p)
export const bridgeProgram = (p: Provider) => new Program<AcruxhubBridge>(bridgeIdl as AcruxhubBridge, p)

const enc = (s: string) => new TextEncoder().encode(s)
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b }
const u64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b }
const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0]

// ------------------------------------------------------------------ AMM

/** Pools are keyed by sorted mints. */
export function sortMints(x: PublicKey, y: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(x.toBuffer(), y.toBuffer()) < 0 ? [x, y] : [y, x]
}

export function poolAddresses(mintX: PublicKey, mintY: PublicKey, feeBps: number) {
  const [mintA, mintB] = sortMints(mintX, mintY)
  const pool = pda([enc('pool'), mintA.toBytes(), mintB.toBytes(), u16(feeBps)], AMM_ID)
  return {
    mintA, mintB, pool,
    vaultA: pda([enc('vault'), pool.toBytes(), mintA.toBytes()], AMM_ID),
    vaultB: pda([enc('vault'), pool.toBytes(), mintB.toBytes()], AMM_ID),
    lpMint: pda([enc('lp'), pool.toBytes()], AMM_ID),
  }
}

export const MIN_LIQUIDITY = 1_000n
const BPS = 10_000n

export function swapOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const inAfter = amountIn * (BPS - BigInt(feeBps))
  return (inAfter * reserveOut) / (reserveIn * BPS + inAfter)
}

/** Output and price impact (in bps of the mid price) for a swap. */
export function swapQuote(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: number) {
  const out = swapOut(amountIn, reserveIn, reserveOut, feeBps)
  const ideal = reserveIn > 0n ? (amountIn * reserveOut) / reserveIn : 0n
  const impactBps = ideal > 0n ? Number(((ideal - out) * BPS) / ideal) : 0
  return { out, impactBps }
}

export const minOut = (out: bigint, slippageBps: number) => (out * (BPS - BigInt(slippageBps))) / BPS

export function depositQuote(ra: bigint, rb: bigint, mintedLp: bigint, maxA: bigint, maxB: bigint) {
  if (mintedLp === 0n) {
    const root = isqrt(maxA * maxB)
    return { amountA: maxA, amountB: maxB, lp: root > MIN_LIQUIDITY ? root - MIN_LIQUIDITY : 0n }
  }
  const total = mintedLp + MIN_LIQUIDITY
  const lpA = (maxA * total) / ra
  const lpB = (maxB * total) / rb
  const lp = lpA < lpB ? lpA : lpB
  const ceil = (x: bigint, y: bigint) => (x + y - 1n) / y
  return { amountA: ceil(lp * ra, total), amountB: ceil(lp * rb, total), lp }
}

export function withdrawQuote(ra: bigint, rb: bigint, mintedLp: bigint, lp: bigint) {
  const total = mintedLp + MIN_LIQUIDITY
  return { amountA: (lp * ra) / total, amountB: (lp * rb) / total }
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) { x = y; y = (x + n / x) / 2n }
  return x
}

// ------------------------------------------------------------------ Launchpad

export const launchConfig = () => pda([enc('config')], LAUNCHPAD_ID)
export const launchAddress = (mint: PublicKey) => pda([enc('launch'), mint.toBytes()], LAUNCHPAD_ID)
/** An approved quote token creators can pair a coin with (set by the admin with set_pair). */
export const launchPairAddress = (quoteMint: PublicKey) => pda([enc('pair'), quoteMint.toBytes()], LAUNCHPAD_ID)
/** The launchpad's emergency pause switch (absent until first set = not paused). */
export const launchPauseAddress = () => pda([enc('pause')], LAUNCHPAD_ID)

// ---- Holder tiers: trading-fee discounts for holders of the platform token ----
export const holderTiersAddress = () => pda([enc('holder_tiers')], LAUNCHPAD_ID)
export type HolderTiersInfo = { mint: PublicKey; tiers: { minBalance: bigint; discountBps: number }[] }

/** The holder tiers set on chain, smallest first, or null when none are set. */
export async function loadHolderTiers(conn: Connection, program: Program<any>): Promise<HolderTiersInfo | null> {
  const info = await conn.getAccountInfo(holderTiersAddress())
  if (!info || !info.owner.equals(LAUNCHPAD_ID)) return null
  const d: any = program.coder.accounts.decode('holderTiers', info.data)
  const tiers = (d.tiers as any[])
    .map(t => ({ minBalance: BigInt(t.minBalance.toString()), discountBps: Number(t.discountBps) }))
    .filter(t => t.minBalance > 0n)
  return tiers.length ? { mint: d.mint, tiers } : null
}

/** Discount (bps off the trade fee) a balance earns: the biggest tier it reaches. */
export function holderDiscountBps(t: HolderTiersInfo | null, balance: bigint): number {
  return Math.max(0, ...(t?.tiers ?? []).filter(x => balance >= x.minBalance).map(x => x.discountBps))
}

/** The fee after a discount, rounded like the program does. */
export const discountedFeeBps = (feeBps: number, discountBps: number) => Math.floor((feeBps * (10_000 - discountBps)) / 10_000)

/**
 * What a trader passes as `holderTokens` and the discount it earns. The account is
 * null unless it exists and earns a discount (the program also accepts null).
 */
export async function holderStatus(conn: Connection, program: Program<any>, user: PublicKey) {
  const tiers = await loadHolderTiers(conn, program)
  if (!tiers) return { tiers, account: null as PublicKey | null, balance: 0n, discountBps: 0 }
  const ata = getAssociatedTokenAddressSync(tiers.mint, user)
  const bal = await conn.getTokenAccountBalance(ata).then(r => BigInt(r.value.amount)).catch(() => 0n)
  const discountBps = holderDiscountBps(tiers, bal)
  return { tiers, account: discountBps > 0 ? ata : null, balance: bal, discountBps }
}

export type CurveState = { virtualQuote: bigint; virtualTokens: bigint; realQuote: bigint; realTokens: bigint; graduationQuote: bigint; feeBps: number }

export function curveBuy(s: CurveState, quoteIn: bigint) {
  const need = s.graduationQuote - s.realQuote
  if (quoteIn <= 0n || need <= 0n) return null
  const fee = (net: bigint) => (net * BigInt(s.feeBps) + BPS - 1n) / BPS
  let net = (quoteIn * BPS) / (BPS + BigInt(s.feeBps))
  if (net > need) net = need
  while (net > 0n && net + fee(net) > quoteIn) net -= 1n
  if (net <= 0n) return null
  const k = s.virtualQuote * s.virtualTokens
  const vq = s.virtualQuote + net
  const vt = (k + vq - 1n) / vq
  return { quoteToCurve: net, fee: fee(net), tokensOut: s.virtualTokens - vt, completes: s.realQuote + net >= s.graduationQuote }
}

export function curveSell(s: CurveState, tokensIn: bigint) {
  if (tokensIn <= 0n) return null
  const k = s.virtualQuote * s.virtualTokens
  const vt = s.virtualTokens + tokensIn
  const vq = (k + vt - 1n) / vt
  const gross = s.virtualQuote - vq
  if (gross > s.realQuote) return null
  let fee = (gross * BigInt(s.feeBps) + BPS - 1n) / BPS
  if (fee > gross) fee = gross
  return { quoteOut: gross - fee, fee }
}

/** Price in quote per whole token (both 6 decimals here, so the ratio is the price). */
export const curvePrice = (s: CurveState) => Number(s.virtualQuote) / Number(s.virtualTokens)
export const curveProgress = (s: CurveState) => Math.min(1, Number(s.realQuote) / Number(s.graduationQuote))

export function stateOf(l: any): CurveState {
  return {
    virtualQuote: BigInt(l.virtualQuote.toString()),
    virtualTokens: BigInt(l.virtualTokens.toString()),
    realQuote: BigInt(l.realQuote.toString()),
    realTokens: BigInt(l.realTokens.toString()),
    graduationQuote: BigInt(l.graduationQuote.toString()),
    feeBps: l.feeBps,
  }
}

/** All accounts `graduate` needs for a completed launch. */
export function graduateAccounts(launch: { mint: PublicKey; curveTokens: PublicKey; curveQuote: PublicKey }, quoteMint: PublicKey) {
  const launchKey = launchAddress(launch.mint)
  const p = poolAddresses(launch.mint, quoteMint, 30)
  return {
    launch: launchKey,
    tokenMint: launch.mint,
    quoteMint,
    curveTokens: launch.curveTokens,
    curveQuote: launch.curveQuote,
    pool: p.pool,
    vaultA: p.vaultA,
    vaultB: p.vaultB,
    lpMint: p.lpMint,
    launchLp: getAssociatedTokenAddressSync(p.lpMint, launchKey, true),
  }
}

/** System-owned PDA that signs as the Raydium pool creator during `graduate_raydium`. */
export const graduatorAddress = (mint: PublicKey) => pda([enc('graduator'), mint.toBytes()], LAUNCHPAD_ID)

/**
 * All accounts `graduate_raydium` needs: the launch's coin paired with the quote
 * mint in a Raydium CPMM pool on fee tier `ammConfig` (trade fee at most 1%).
 * It uses about 252k compute units on Acrux Net (187k on a local validator); send it with a limit of 300k or more.
 */
export function graduateRaydiumAccounts(launch: { mint: PublicKey; curveTokens: PublicKey; curveQuote: PublicKey }, quoteMint: PublicKey, ammConfig: PublicKey) {
  const graduator = graduatorAddress(launch.mint)
  const p = cpmmPoolAddresses(ammConfig, launch.mint, quoteMint)
  return {
    launch: launchAddress(launch.mint),
    tokenMint: launch.mint,
    quoteMint,
    curveTokens: launch.curveTokens,
    curveQuote: launch.curveQuote,
    graduator,
    graduatorTokens: getAssociatedTokenAddressSync(launch.mint, graduator, true),
    graduatorQuote: getAssociatedTokenAddressSync(quoteMint, graduator, true),
    graduatorLp: getAssociatedTokenAddressSync(p.lpMint, graduator, true),
    ammConfig,
    cpmmAuthority: RAYDIUM_CPMM_AUTHORITY,
    poolState: p.pool,
    lpMint: p.lpMint,
    vault0: p.vault0,
    vault1: p.vault1,
    createPoolFee: RAYDIUM_CPMM_CREATE_FEE_RECEIVER,
    observation: p.observation,
    cpmmProgram: RAYDIUM_CPMM_ID,
  }
}

// ------------------------------------------------------------------ Bridge

export const CHAIN = { solana: 1, acrux: 2 } as const
export const bridgeConfig = () => pda([enc('config')], BRIDGE_ID)
export const bridgeRoute = (mint: PublicKey) => pda([enc('route'), mint.toBytes()], BRIDGE_ID)
export const bridgeCustody = (mint: PublicKey) => pda([enc('custody'), mint.toBytes()], BRIDGE_ID)
export const wrappedMint = (remoteChain: number, remoteMint: PublicKey) => pda([enc('wrapped'), u16(remoteChain), remoteMint.toBytes()], BRIDGE_ID)
export const outboundAddress = (nonce: bigint | number) => pda([enc('out'), u64(nonce)], BRIDGE_ID)
export const consumedAddress = (sourceChain: number, nonce: bigint | number) => pda([enc('consumed'), u16(sourceChain), u64(nonce)], BRIDGE_ID)

export type Payload = { sourceChain: number; nonce: bigint; destChain: number; destMint: PublicKey; recipient: PublicKey; amount: bigint }

export function payloadDigest(p: Payload): Uint8Array {
  const parts = [enc('acruxhub-bridge-v1'), u16(p.sourceChain), u64(p.nonce), u16(p.destChain), p.destMint.toBytes(), p.recipient.toBytes(), u64(p.amount)]
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of parts) { all.set(x, o); o += x.length }
  return sha256(all)
}

export const approvalAddress = (p: Payload) => pda([enc('approval'), payloadDigest(p)], BRIDGE_ID)

/** Anchor-shaped payload argument. */
export const payloadArg = (p: Payload) => ({
  sourceChain: p.sourceChain,
  nonce: new anchor.BN(p.nonce.toString()),
  destChain: p.destChain,
  destMint: p.destMint,
  recipient: p.recipient,
  amount: new anchor.BN(p.amount.toString()),
})

export const BN = anchor.BN

/**
 * All accounts of one type owned by a program, filtered client-side. Acrux Net's
 * getProgramAccounts ignores memcmp filters, so Anchor's `.all()` returns every
 * account the program owns and fails decoding the other types.
 * `match` sees the raw account data (discriminator included) for extra filtering.
 */
export async function allAccounts<A = any>(
  program: Program<any>,
  name: string,
  { match, commitment }: { match?: (data: Buffer) => boolean; commitment?: anchor.web3.Commitment } = {},
): Promise<{ publicKey: PublicKey; account: A }[]> {
  // Anchor's Program camelCases IDL names ("Launch" -> "launch"); match either form.
  const def = (program.idl.accounts ?? []).find((a: any) => a.name.toLowerCase() === name.toLowerCase())
  if (!def) throw new Error(`no account type ${name}`)
  name = def.name
  const disc = Buffer.from(def.discriminator)
  const raw = await program.provider.connection.getProgramAccounts(program.programId, { commitment })
  return raw
    .filter(r => r.account.data.subarray(0, 8).equals(disc) && (!match || match(r.account.data)))
    .map(r => ({ publicKey: r.pubkey, account: program.coder.accounts.decode(name, r.account.data) as A }))
}

/** Byte offset of Outbound.sender: discriminator 8 + nonce 8 + source_chain 2 + dest_chain 2 + dest_mint 32. */
export const OUTBOUND_SENDER_OFFSET = 52
