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
