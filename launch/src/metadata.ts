// Metaplex Token Metadata: the account wallets, explorers and DEXs read for a
// token's name, symbol and image. Built by hand (Borsh) so the kit needs no extra
// dependency; the layout follows mpl-token-metadata's CreateMetadataAccountV3.
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from '@solana/web3.js'

export const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const CREATE_METADATA_V3 = 33

export const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0]

const str = (s: string) => {
  const b = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(b.length)
  return Buffer.concat([len, b])
}

/** Limits enforced by the Metaplex program. */
export const LIMITS = { name: 32, symbol: 10, uri: 200 }

export function createMetadataIx(p: {
  mint: PublicKey
  mintAuthority: PublicKey
  payer: PublicKey
  updateAuthority: PublicKey
  name: string
  symbol: string
  uri: string
  isMutable: boolean
}) {
  if (Buffer.byteLength(p.name) > LIMITS.name) throw new Error(`name over ${LIMITS.name} bytes`)
  if (Buffer.byteLength(p.symbol) > LIMITS.symbol) throw new Error(`symbol over ${LIMITS.symbol} bytes`)
  if (Buffer.byteLength(p.uri) > LIMITS.uri) throw new Error(`uri over ${LIMITS.uri} bytes`)
  const fee = Buffer.alloc(2) // seller_fee_basis_points = 0
  const data = Buffer.concat([
    Buffer.from([CREATE_METADATA_V3]),
    // DataV2
    str(p.name), str(p.symbol), str(p.uri), fee,
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([p.isMutable ? 1 : 0]),
    Buffer.from([0]), // collection_details: None
  ])
  return new TransactionInstruction({
    programId: METADATA_PROGRAM,
    keys: [
      { pubkey: metadataPda(p.mint), isSigner: false, isWritable: true },
      { pubkey: p.mint, isSigner: false, isWritable: false },
      { pubkey: p.mintAuthority, isSigner: true, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/** Reads back name, symbol, uri, update authority and mutability. */
export async function readMetadata(conn: Connection, mint: PublicKey) {
  const acct = await conn.getAccountInfo(metadataPda(mint))
  if (!acct) return null
  const d = acct.data
  let o = 1 // key
  const updateAuthority = new PublicKey(d.subarray(o, (o += 32)))
  const mintKey = new PublicKey(d.subarray(o, (o += 32)))
  const read = () => {
    const n = d.readUInt32LE(o)
    o += 4
    const s = d.subarray(o, o + n).toString('utf8').replace(/\0+$/, '')
    o += n
    return s
  }
  const name = read(), symbol = read(), uri = read()
  o += 2 // seller fee
  // creators, then primary_sale_happened, is_mutable
  if (d[o++] === 1) o += 4 + d.readUInt32LE(o) * 34
  o += 1
  const isMutable = d[o] === 1
  return { owner: acct.owner.toBase58(), updateAuthority: updateAuthority.toBase58(), mint: mintKey.toBase58(), name, symbol, uri, isMutable }
}
