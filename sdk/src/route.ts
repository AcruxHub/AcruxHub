// Builds the instructions for one swap made through AcruxHub, whichever pool it
// is routed to (an AcruxHub AMM pool or a Raydium CPMM pool), including
// AcruxHub's platform fee. The web app and scripts/acrux-route-check.ts share it.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Program } from '@coral-xyz/anchor'
import * as anchor from '@coral-xyz/anchor'
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token'
import { cpmmSwapInstruction, platformFee, PLATFORM_FEE_BPS, type CpmmPool } from './raydium.ts'
import type { AcruxhubAmm } from './programs.ts'

export type RouteMarket = {
  kind: 'acruxhub' | 'raydium'
  mintA: PublicKey
  mintB: PublicKey
  programA: PublicKey
  programB: PublicKey
  decimalsA: number
  decimalsB: number
  amm?: { address: PublicKey; vaultA: PublicKey; vaultB: PublicKey }
  raydium?: { pool: CpmmPool }
}

export async function routedSwapInstructions(a: {
  market: RouteMarket
  user: PublicKey
  aToB: boolean
  /** What the user pays in total; AcruxHub's fee comes out of this. */
  amountIn: bigint
  /** Minimum output of the pool swap (after slippage). */
  minOut: bigint
  /** Fee receiver; without one no fee is taken. */
  feeRecipient?: PublicKey
  feeBps?: number
  /** Needed for AcruxHub AMM routes. */
  amm?: Program<AcruxhubAmm>
  deadlineSlot?: number
}): Promise<{ ixs: TransactionInstruction[]; fee: bigint; net: bigint }> {
  const m = a.market
  const [inMint, outMint] = a.aToB ? [m.mintA, m.mintB] : [m.mintB, m.mintA]
  const [inProg, outProg] = a.aToB ? [m.programA, m.programB] : [m.programB, m.programA]
  const inDec = a.aToB ? m.decimalsA : m.decimalsB
  const userIn = getAssociatedTokenAddressSync(inMint, a.user, false, inProg)
  const userOut = getAssociatedTokenAddressSync(outMint, a.user, false, outProg)
  const { fee, net } = platformFee(a.amountIn, a.feeRecipient ? (a.feeBps ?? PLATFORM_FEE_BPS) : 0)
  if (net <= 0n) throw new Error('amount too small')

  const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(a.user, userOut, a.user, outMint, outProg)]
  if (a.feeRecipient && fee > 0n) {
    const feeAta = getAssociatedTokenAddressSync(inMint, a.feeRecipient, true, inProg)
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(a.user, feeAta, a.feeRecipient, inMint, inProg))
    ixs.push(createTransferCheckedInstruction(userIn, inMint, feeAta, a.user, fee, inDec, [], inProg))
  }
  if (m.kind === 'raydium') {
    ixs.push(cpmmSwapInstruction({ pool: m.raydium!.pool, payer: a.user, aToB: a.aToB, userIn, userOut, amountIn: net, minOut: a.minOut }))
  } else {
    if (!a.amm || a.deadlineSlot == null) throw new Error('AcruxHub route needs the AMM program and a deadline slot')
    const p = m.amm!
    ixs.push(await a.amm.methods
      .swap(new anchor.BN(net.toString()), new anchor.BN(a.minOut.toString()), a.aToB, new anchor.BN(a.deadlineSlot))
      .accountsPartial({
        user: a.user, pool: p.address, mintA: m.mintA, mintB: m.mintB, vaultA: p.vaultA, vaultB: p.vaultB,
        userA: getAssociatedTokenAddressSync(m.mintA, a.user), userB: getAssociatedTokenAddressSync(m.mintB, a.user),
      })
      .instruction())
  }
  return { ixs, fee, net }
}
