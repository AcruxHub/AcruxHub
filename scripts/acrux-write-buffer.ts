// Writes a program binary into an upgradeable-loader buffer on Acrux Net, slowly
// enough to stay under Acrux's per-fee-payer inclusion rate (inclusion fees of at
// most 0.001/6 ACRUX per proposer per window, ~166 transactions). The Solana CLI
// sends every chunk at once and gets most of them refused ("The fee payer cannot pay
// the inclusion fee"). Finish with one CLI call that deploys from the buffer:
//   solana program deploy --use-rpc -u https://rpc.acrux.computer --keypair <payer>
//     --program-id <program keypair> --buffer <buffer>        (new program)
//   solana program deploy ... --program-id <id> --buffer <buffer>   (upgrade)
//
//   node --import tsx scripts/acrux-write-buffer.ts <buffer address> <program.so> [--key keys/acrux-deployer.json] [--rate 8]
//
// The buffer must already exist, sized for the binary, with the key as its authority
// (the CLI creates one when a deploy starts; `solana program write-buffer` does too).
// Chunks already correct in the buffer are skipped, so it can be re-run safely.
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const HEADER = 37 // Buffer state: u32 tag + Option<Pubkey>
const CHUNK = 900
const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'))
const flag = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const buffer = new PublicKey(pos[0])
const so = readFileSync(pos[1])
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(flag('--key') ?? 'keys/acrux-deployer.json', 'utf8'))))
const perSecond = Number(flag('--rate') ?? 8)
const conn = new Connection(RPC, 'confirmed')

function writeIx(offset: number, bytes: Buffer) {
  const data = Buffer.alloc(4 + 4 + 8 + bytes.length)
  data.writeUInt32LE(1, 0) // Write
  data.writeUInt32LE(offset, 4)
  data.writeBigUInt64LE(BigInt(bytes.length), 8)
  bytes.copy(data, 16)
  return new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: kp.publicKey, isSigner: true, isWritable: false }], data })
}

async function current() {
  const info = await conn.getAccountInfo(buffer, 'confirmed')
  if (!info) throw new Error(`buffer ${buffer.toBase58()} not found`)
  if (!info.owner.equals(LOADER)) throw new Error('not a loader account')
  const d = info.data as Buffer
  if (d.readUInt32LE(0) !== 1) throw new Error('not a buffer')
  if (d[4] !== 1 || !new PublicKey(d.subarray(5, 37)).equals(kp.publicKey)) throw new Error('the key is not this buffer\'s authority')
  if (d.length - HEADER < so.length) throw new Error(`buffer holds ${d.length - HEADER} bytes, binary is ${so.length}`)
  return d.subarray(HEADER)
}

const chunks = Array.from({ length: Math.ceil(so.length / CHUNK) }, (_, i) => i * CHUNK)
for (let pass = 1; pass <= 6; pass++) {
  const have = await current()
  const todo = chunks.filter(o => !have.subarray(o, o + CHUNK).equals(so.subarray(o, o + CHUNK)))
  console.log(`pass ${pass}: ${chunks.length - todo.length}/${chunks.length} chunks already written, ${todo.length} to go`)
  if (!todo.length) { console.log('buffer matches the binary'); process.exit(0) }
  let { blockhash } = await conn.getLatestBlockhash('confirmed')
  let bhAt = Date.now()
  let refused = 0
  for (let i = 0; i < todo.length; i++) {
    // Acrux slots are 50 ms, so blockhashes age fast: refresh every 2 s.
    if (Date.now() - bhAt > 2000) { ({ blockhash } = await conn.getLatestBlockhash('confirmed')); bhAt = Date.now() }
    const o = todo[i]
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(writeIx(o, so.subarray(o, o + CHUNK)))
    tx.sign(kp)
    try {
      await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
    } catch (e: any) {
      refused++
      if (/inclusion fee/i.test(e.message)) await new Promise(r => setTimeout(r, 1500)) // over the rate: back off
      else console.log(`  chunk @${o}: ${e.message.slice(0, 120)}`)
    }
    await new Promise(r => setTimeout(r, 1000 / perSecond))
    if (i % 50 === 49) console.log(`  sent ${i + 1}/${todo.length} (${refused} refused so far)`)
  }
  await new Promise(r => setTimeout(r, 3000)) // let the last writes land before re-checking
}
console.error('buffer still differs after 6 passes')
process.exit(1)
