// Creates a coin exactly the way the web form does: create_launch + first buy in ONE
// transaction (with a 400k compute limit). Usage:
//   node --import tsx scripts/acrux-create-coin.ts "<name>" <SYMBOL> <metadata uri> <first buy in AXB>
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { launchpadProgram, launchConfig, launchAddress, curveBuy, BN } from '../sdk/src/index.ts'

const [name, symbol, uri, buyAxb] = process.argv.slice(2)
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection('https://rpc.acrux.computer', 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))
const config = await lp.account.config.fetch(launchConfig())
const quoteMint = config.quoteMint
const p = config.params
const buyRaw = BigInt(Math.round(Number(buyAxb) * 1e6))
const q = curveBuy({
  virtualQuote: BigInt(p.virtualQuote.toString()), virtualTokens: BigInt(p.virtualTokens.toString()),
  realQuote: 0n, realTokens: BigInt(p.curveSupply.toString()), graduationQuote: BigInt(p.graduationQuote.toString()), feeBps: p.feeBps,
}, buyRaw)!

const mint = Keypair.generate()
const launch = launchAddress(mint.publicKey)
const fee = p.feeRecipient as PublicKey
const tx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  await lp.methods.createLaunch(name, symbol, uri).accountsPartial({ creator: kp.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint, quotePair: null }).instruction(),
  createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, getAssociatedTokenAddressSync(quoteMint, fee, true), fee, quoteMint),
  await lp.methods.buy(new BN(buyRaw.toString()), new BN(q.tokensOut.toString())).accountsPartial({ holderTokens: null,
    user: kp.publicKey, launch, mint: mint.publicKey, quoteMint,
    curveTokens: getAssociatedTokenAddressSync(mint.publicKey, launch, true),
    curveQuote: getAssociatedTokenAddressSync(quoteMint, launch, true),
    userTokens: getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey),
    userQuote: getAssociatedTokenAddressSync(quoteMint, kp.publicKey),
    feeQuote: getAssociatedTokenAddressSync(quoteMint, fee, true),
  }).instruction(),
)
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
tx.feePayer = kp.publicKey
tx.recentBlockhash = blockhash
tx.sign(kp, mint)
console.log('tx size', tx.serialize().length, 'bytes (limit 1232)')
const sig = await conn.sendRawTransaction(tx.serialize())
const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
if (r.value.err) throw new Error(`failed ${JSON.stringify(r.value.err)}`)
const got = BigInt((await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey))).value.amount)
console.log('created', symbol, mint.publicKey.toBase58(), '| first buy got', got.toString(), 'expected', q.tokensOut.toString(), '|', sig)
