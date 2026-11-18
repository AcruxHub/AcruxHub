// Initializes the launchpad on Acrux Net (quote = faucet AXB, 6 dp) and smoke-tests
// a launch + buy. Params: 1B supply, 800M on the curve, 30 AXB virtual, graduate at
// 20 AXB raised, 1% fee to the deployer. The faucet hands out 100 AXB per grant.
import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { launchpadProgram, launchConfig, launchAddress, curveBuy, stateOf, LAUNCHPAD_ID, BN } from '../sdk/src/index.ts'

const AXB = new PublicKey('28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td')
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection('https://rpc.acrux.computer', 'confirmed')
const lp = launchpadProgram(new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' }))

async function send(tx: anchor.web3.Transaction, signers: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.feePayer = kp.publicKey
  tx.recentBlockhash = blockhash
  tx.sign(kp, ...signers)
  const sig = await conn.sendRawTransaction(tx.serialize())
  const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (r.value.err) throw new Error(`failed ${JSON.stringify(r.value.err)} ${sig}`)
  return sig
}

if (!(await lp.account.config.fetchNullable(launchConfig()))) {
  const params = {
    feeBps: 100,
    feeRecipient: kp.publicKey,
    totalSupply: new BN('1000000000000000'),
    curveSupply: new BN('800000000000000'),
    virtualQuote: new BN(30_000_000),
    virtualTokens: new BN('1073000000000000'),
    graduationQuote: new BN(20_000_000),
  }
  const programData = PublicKey.findProgramAddressSync([LAUNCHPAD_ID.toBytes()], LOADER)[0]
  const feeAta = getAssociatedTokenAddressSync(AXB, kp.publicKey)
  const tx = await lp.methods.initialize(params)
    .accountsPartial({ admin: kp.publicKey, quoteMint: AXB, program: LAUNCHPAD_ID, programData })
    .preInstructions([createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, feeAta, kp.publicKey, AXB)])
    .transaction()
  console.log('initialized', await send(tx))
}

// Smoke test: launch a token and buy 1 AXB of it.
const mint = Keypair.generate()
const create = await lp.methods.createLaunch('AcruxHub', 'HUB', '')
  .accountsPartial({ creator: kp.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint: AXB })
  .transaction()
console.log('launched HUB', mint.publicKey.toBase58(), await send(create, [mint]))

const launchKey = launchAddress(mint.publicKey)
const l = await lp.account.launch.fetch(launchKey)
const q = curveBuy(stateOf(l), 1_000_000n)!
const userTokens = getAssociatedTokenAddressSync(mint.publicKey, kp.publicKey)
const buy = await lp.methods.buy(new BN(1_000_000), new BN(q.tokensOut.toString()))
  .accountsPartial({
    user: kp.publicKey, launch: launchKey, mint: mint.publicKey, quoteMint: AXB, curveTokens: l.curveTokens, curveQuote: l.curveQuote,
    userTokens, userQuote: getAssociatedTokenAddressSync(AXB, kp.publicKey), feeQuote: getAssociatedTokenAddressSync(AXB, kp.publicKey),
  })
  .transaction()
console.log('bought', await send(buy))
const got = BigInt((await conn.getTokenAccountBalance(userTokens)).value.amount)
console.log('received', got.toString(), 'expected', q.tokensOut.toString())
if (got !== q.tokensOut) throw new Error('buy output mismatch')
