// Acrux's own bridge (acrux_bridge, EDm6Hx...K3PEe5), the deposit side on Solana:
// ACRUX locked in the bridge's vault on Solana is credited on Acrux as native ACRUX,
// 1 base unit (6 decimals) = 1,000 lamports (9 decimals), i.e. 1:1 in whole ACRUX.
// Layout from https://acrux.computer/docs/reference/bridge-program (deposit).
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export const ACRUX_BRIDGE_ID = new PublicKey('EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5')
/** ACRUX on Solana mainnet (the one mint the bridge admits). */
export const ACRUX_SOLANA_MINT = new PublicKey('7Evw4uxTxLGGEFEvXLUNYyc1J7PnFk9EYwTUFagARUX')
export const ACRUX_SOLANA_DECIMALS = 6

const seed = (s: string) => new TextEncoder().encode(s)
const pda = (...s: Uint8Array[]) => PublicKey.findProgramAddressSync(s, ACRUX_BRIDGE_ID)[0]
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b }

export const acruxBridgeAccount = () => pda(seed('bridge'))
export const acruxBridgeVault = (mint = ACRUX_SOLANA_MINT) => pda(seed('vault'), mint.toBytes())
const allowed = (mint: PublicKey) => pda(seed('allowed'), mint.toBytes())
const record = (sequence: bigint) => pda(seed('deposit'), u64(sequence))
const eventAuthority = () => pda(seed('__event_authority'))

const BRIDGE_DISC = 'e7e81f626e03173b'
const DEPOSIT_DISC = Uint8Array.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6])

/** The next deposit's sequence number (Bridge.deposits). */
export async function acruxBridgeNextSequence(solana: Connection): Promise<bigint> {
  const info = await solana.getAccountInfo(acruxBridgeAccount(), 'confirmed')
  if (!info || !info.owner.equals(ACRUX_BRIDGE_ID)) throw new Error('Acrux bridge not found on Solana')
  const d = info.data as Uint8Array
  if (Array.from(d.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('') !== BRIDGE_DISC) throw new Error('unexpected bridge account')
  return new DataView(d.buffer, d.byteOffset).getBigUint64(8, true)
}

/** Deposit `amount` (Solana base units, 6 decimals) of ACRUX, credited to `recipient` on Acrux. */
export function acruxBridgeDeposit(a: { depositor: PublicKey; recipient: PublicKey; amount: bigint; sequence: bigint; mint?: PublicKey }) {
  const mint = a.mint ?? ACRUX_SOLANA_MINT
  const data = new Uint8Array(8 + 8 + 32)
  data.set(DEPOSIT_DISC, 0)
  data.set(u64(a.amount), 8)
  data.set(a.recipient.toBytes(), 16)
  const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
  return new TransactionInstruction({
    programId: ACRUX_BRIDGE_ID,
    keys: [
      m(a.depositor, true, true),
      m(acruxBridgeAccount(), true),
      m(mint),
      m(allowed(mint)),
      m(getAssociatedTokenAddressSync(mint, a.depositor), true),
      m(acruxBridgeVault(mint), true),
      m(record(a.sequence), true),
      m(TOKEN_PROGRAM_ID),
      m(SystemProgram.programId),
      m(eventAuthority()),
      m(ACRUX_BRIDGE_ID),
    ],
    data: Buffer.from(data),
  })
}

// ---- The way back: Acrux -> Solana (withdraw_native, on Acrux) ----
// Burns native ACRUX on Acrux and records a Withdrawal; Acrux's relayer proves it to
// Solana and `release` pays the recipient's ACRUX token account from the vault, usually
// in about a minute. The recipient's ACRUX token account on Solana must exist for the
// payout to land. Layout from https://acrux.computer/docs/reference/bridge-program.
const WITHDRAW_NATIVE_DISC = Uint8Array.from([0x71, 0xe3, 0x1a, 0x20, 0x35, 0x42, 0x5a, 0xfa])
const OUTBOUND_DISC = '25f20b6bf29c4681'
/** Smallest withdrawal Acrux's bridge accepts: 1 ACRUX (the "minimum" account). */
export const ACRUX_MIN_WITHDRAWAL = 1_000_000n

export const acruxBridgeOutbound = () => pda(seed('outbound'))
export const acruxBridgeWithdrawalRecord = (sequence: bigint) => pda(seed('withdrawal'), u64(sequence))

/** The next withdrawal's sequence (Outbound.withdrawals, on Acrux). */
export async function acruxBridgeNextWithdrawal(acrux: Connection): Promise<bigint> {
  const info = await acrux.getAccountInfo(acruxBridgeOutbound(), 'confirmed')
  if (!info) return 0n // the first withdrawal creates it
  if (!info.owner.equals(ACRUX_BRIDGE_ID)) throw new Error('unexpected outbound account')
  const d = info.data as Uint8Array
  if (Array.from(d.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('') !== OUTBOUND_DISC) throw new Error('unexpected outbound account')
  return new DataView(d.buffer, d.byteOffset).getBigUint64(8, true)
}

/** Bridge `amount` ACRUX (Solana base units, 6 decimals) from Acrux back to `recipient` on Solana.
 * Costs `amount` x 1,000 lamports of native ACRUX, plus the fee and the record's rent. */
export function acruxBridgeWithdrawNative(a: { owner: PublicKey; recipient: PublicKey; amount: bigint; sequence: bigint; mint?: PublicKey }) {
  const mint = a.mint ?? ACRUX_SOLANA_MINT
  const data = new Uint8Array(8 + 8 + 32)
  data.set(WITHDRAW_NATIVE_DISC, 0)
  data.set(u64(a.amount), 8)
  data.set(a.recipient.toBytes(), 16)
  const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })
  return new TransactionInstruction({
    programId: ACRUX_BRIDGE_ID,
    keys: [
      m(a.owner, true, true),
      m(pda(seed('native')), true),
      m(pda(seed('minimum'), mint.toBytes())),
      m(pda(seed('native_burn')), true),
      m(acruxBridgeOutbound(), true),
      m(acruxBridgeWithdrawalRecord(a.sequence), true),
      m(SystemProgram.programId),
    ],
    data: Buffer.from(data),
  })
}
