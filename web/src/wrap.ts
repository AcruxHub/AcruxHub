// Buying with ACRUX: the launchpad and pools take wrapped ACRUX (an SPL token, 1:1),
// so a buy first wraps whatever part of the amount isn't wrapped yet. Traders only
// ever see "ACRUX".
import type { AnchorProvider } from '@coral-xyz/anchor'
import type { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { wacruxProgram, wrapInstruction } from '@acruxhub/sdk'
import { WACRUX } from './hooks.ts'

/** Native ACRUX kept back for network fees when spending "everything". */
export const FEE_RESERVE = 10_000_000n

export const isWacrux = (mint: PublicKey) => mint.toBase58() === WACRUX

/** The wrap instruction a buy of `amount` needs (none if already wrapped, or not wACRUX). */
export async function wrapFor(conn: Connection, provider: AnchorProvider, user: PublicKey, quoteMint: PublicKey, amount: bigint): Promise<TransactionInstruction[]> {
  if (!isWacrux(quoteMint)) return []
  const ata = getAssociatedTokenAddressSync(quoteMint, user)
  const have = await conn.getTokenAccountBalance(ata).then(r => BigInt(r.value.amount)).catch(() => 0n)
  const need = amount - have
  return need > 0n ? [await wrapInstruction(wacruxProgram(provider), user, need)] : []
}

/** What a user can spend in the quote: for wACRUX, wrapped plus native minus a fee reserve. */
export async function spendable(conn: Connection, user: PublicKey, quoteMint: PublicKey, wrapped: bigint) {
  if (!isWacrux(quoteMint)) return wrapped
  const native = BigInt(await conn.getBalance(user))
  return wrapped + (native > FEE_RESERVE ? native - FEE_RESERVE : 0n)
}
