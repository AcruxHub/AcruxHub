// Buying with ACRUX: pools and the launchpad take ACRUX as an SPL token, so a buy first
// wraps whatever part of the amount isn't wrapped yet. Traders only ever see "ACRUX".
//
// Two wrapped forms, both 1:1 with native ACRUX:
//  - wACRUX (8wkvan…): AcruxHub's own wrapper. Our launchpad and the HUB pool use it.
//  - the native mint (So111…112): SPL Token's standard wrapped-native mint, live on Acrux
//    from slot 6,480,000. It wraps like SOL on Solana (fund the token account, then
//    syncNative) and unwraps by closing the account; other apps' pools may use it.
import type { AnchorProvider } from '@coral-xyz/anchor'
import { SystemProgram, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction,
} from '@solana/spl-token'
import { wacruxProgram, wrapInstruction } from '@acruxhub/sdk'
import { WACRUX, NATIVE_ACRUX } from './hooks.ts'

/** Native ACRUX kept back for network fees when spending "everything". */
export const FEE_RESERVE = 10_000_000n

export const isWacrux = (mint: PublicKey) => mint.toBase58() === WACRUX
export const isNativeMint = (mint: PublicKey) => mint.toBase58() === NATIVE_ACRUX
/** Either wrapped form of ACRUX. */
export const isAcruxMint = (mint: PublicKey) => isWacrux(mint) || isNativeMint(mint)

/** The wrap instructions a payment of `amount` needs (none if already wrapped, or not ACRUX). */
export async function wrapFor(conn: Connection, provider: AnchorProvider, user: PublicKey, quoteMint: PublicKey, amount: bigint): Promise<TransactionInstruction[]> {
  if (!isAcruxMint(quoteMint)) return []
  const ata = getAssociatedTokenAddressSync(quoteMint, user)
  const have = await conn.getTokenAccountBalance(ata).then(r => BigInt(r.value.amount)).catch(() => 0n)
  const need = amount - have
  if (need <= 0n) return []
  if (isWacrux(quoteMint)) return [await wrapInstruction(wacruxProgram(provider), user, need)]
  // The native mint: move lamports into the token account and sync its balance.
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, ata, user, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: ata, lamports: need }),
    createSyncNativeInstruction(ata),
  ]
}

/** Unwraps everything in the native-mint account back to plain ACRUX (closes the account). */
export function unwrapNativeMint(user: PublicKey): TransactionInstruction {
  return createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, user), user, user)
}

/** What a user can spend in the quote: for ACRUX, wrapped plus native minus a fee reserve. */
export async function spendable(conn: Connection, user: PublicKey, quoteMint: PublicKey, wrapped: bigint) {
  if (!isAcruxMint(quoteMint)) return wrapped
  const native = BigInt(await conn.getBalance(user))
  return wrapped + (native > FEE_RESERVE ? native - FEE_RESERVE : 0n)
}
