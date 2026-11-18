// Seeds the first AcruxHub pool on Acrux Net (AXA/AXB, 0.30%, at the demo pool's
// 1:2 price), then makes a small swap through a PRIVATE (2-of-3 threshold) send to
// prove our sealer against the live chain.
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ammProgram, poolAddresses, depositQuote, swapOut, minOut, AcruxGateway, privateSend, waitForTx, BN } from '../sdk/src/index.ts'

const AXA = new PublicKey('713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss')
const AXB = new PublicKey('28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection('https://rpc.acrux.computer', 'confirmed')
const gw = new AcruxGateway()
const amm = ammProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const p = poolAddresses(AXA, AXB, 30)
const bal = async (k: PublicKey) => BigInt((await conn.getTokenAccountBalance(k)).value.amount)

async function sendPlain(tx: anchor.web3.Transaction) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = blockhash
  tx.sign(kp)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (r.value.err) throw new Error(`failed: ${JSON.stringify(r.value.err)} ${sig}`)
  return sig
}

if (!(await conn.getAccountInfo(p.pool))) {
  const [ra, rb] = p.mintA.equals(AXA) ? [100_000_000n, 200_000_000n] : [200_000_000n, 100_000_000n]
  const q = depositQuote(0n, 0n, 0n, ra, rb)
  const create = await amm.methods.createPool(30).accountsPartial({ payer: kp.publicKey, mintA: p.mintA, mintB: p.mintB }).instruction()
  const tx = await amm.methods.addLiquidity(new BN(ra.toString()), new BN(rb.toString()), new BN(q.lp.toString()))
    .accountsPartial({
      payer: kp.publicKey, owner: kp.publicKey, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint,
      ownerA: getAssociatedTokenAddressSync(p.mintA, kp.publicKey), ownerB: getAssociatedTokenAddressSync(p.mintB, kp.publicKey),
    })
    .preInstructions([create])
    .transaction()
  console.log('pool created + funded:', p.pool.toBase58(), await sendPlain(tx))
}
console.log('reserves', (await bal(p.vaultA)).toString(), (await bal(p.vaultB)).toString())

// Private swap: 1 AXA -> AXB.
const aToB = p.mintA.equals(AXA)
const [ri, ro] = aToB ? [await bal(p.vaultA), await bal(p.vaultB)] : [await bal(p.vaultB), await bal(p.vaultA)]
const expect = swapOut(1_000_000n, ri, ro, 30)
const userOut = getAssociatedTokenAddressSync(AXB, kp.publicKey)
const before = await bal(userOut)
const { blockhash } = await gw.call<{ blockhash: string }>('getLatestBlockhash', {})
const slot = await conn.getSlot()
const tx = await amm.methods.swap(new BN(1_000_000), new BN(minOut(expect, 50).toString()), aToB, new BN(slot + 2000))
  .accountsPartial({
    user: kp.publicKey, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB,
    userA: getAssociatedTokenAddressSync(p.mintA, kp.publicKey), userB: getAssociatedTokenAddressSync(p.mintB, kp.publicKey),
  })
  .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 })])
  .transaction()
tx.feePayer = kp.publicKey
tx.recentBlockhash = blockhash
tx.sign(kp)
const { id, targetSlot } = await privateSend(gw, tx.serialize(), kp.secretKey, { n: 3, t: 2 })
console.log('private send', id, 'target slot', targetSlot)
const state = await waitForTx(gw, id, 60_000)
const got = (await bal(userOut)) - before
console.log('state', state, '| received', got.toString(), 'AXB units, expected', expect.toString())
if (got !== expect) throw new Error('private swap output mismatch')
