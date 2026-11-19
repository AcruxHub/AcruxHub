// Creates a Raydium CPMM pool AXA/AXB on Acrux Net (0.25% fee tier) with Raydium's
// own SDK, so the Swap page has a second market for the same pair and routes
// between the two. Test tokens only. Idempotent: does nothing if the pool exists.
//
//   node --import tsx scripts/acrux-raydium-pool.ts <AXA amount> <AXB amount>
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmRawTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Raydium, TxVersion, getCpmmPdaPoolId } from '@raydium-io/raydium-sdk-v2'
import { RAYDIUM_CPMM_ID, sortMints } from '../sdk/src/index.ts'

const RPC = process.env.RPC ?? 'https://rpc.acrux.computer'
const AXA = new PublicKey('713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss')
const AXB = new PublicKey('28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td')
/** Raydium CPMM fee tier 0 (0.25%) and its pool-creation fee receiver, as placed on Acrux. */
const FEE_CONFIG = { id: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2', index: 0, protocolFeeRate: 120000, tradeFeeRate: 2500, fundFeeRate: 40000, createPoolFee: '150000000', creatorFeeRate: 500 }
const POOL_FEE_ACCOUNT = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')

const [a, b] = process.argv.slice(2).map(Number)
if (!(a > 0 && b > 0)) throw new Error('usage: acrux-raydium-pool.ts <AXA amount> <AXB amount>')
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/acrux-deployer.json', 'utf8'))))
const conn = new Connection(RPC, 'confirmed')

const [m0, m1] = sortMints(AXA, AXB)
const poolId = getCpmmPdaPoolId(RAYDIUM_CPMM_ID, new PublicKey(FEE_CONFIG.id), m0, m1).publicKey
if (await conn.getAccountInfo(poolId)) {
  console.log('Raydium AXA/AXB pool already exists:', poolId.toBase58())
  process.exit(0)
}

const raydium = await Raydium.load({ connection: conn, owner: kp, cluster: 'mainnet', disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'confirmed' })
const info = (mint: PublicKey) => ({ address: mint.toBase58(), decimals: 6, programId: TOKEN_PROGRAM_ID.toBase58() })
const raw = (whole: number) => new BN(Math.round(whole * 1e6))
const created = await raydium.cpmm.createPool({
  programId: RAYDIUM_CPMM_ID,
  poolFeeAccount: POOL_FEE_ACCOUNT,
  mintA: info(AXA),
  mintB: info(AXB),
  mintAAmount: raw(a),
  mintBAmount: raw(b),
  startTime: new BN(0),
  feeConfig: FEE_CONFIG as any,
  associatedOnly: false,
  ownerInfo: { useSOLBalance: true },
  txVersion: TxVersion.LEGACY,
  computeBudgetConfig: process.env.CU ? { units: Number(process.env.CU) } : undefined,
})
// Build and send the transaction ourselves from the SDK's instructions, so a
// failure shows the program logs instead of the SDK's wrapped error.
const builder: any = created.builder
const tx = new Transaction().add(...builder.allInstructions)
tx.feePayer = kp.publicKey
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
tx.sign(kp, ...(builder.signers ?? []))
const sim = await conn.simulateTransaction(tx)
if (sim.value.err) {
  console.log('simulation failed:', JSON.stringify(sim.value.err), '\n' + (sim.value.logs ?? []).join('\n'))
  process.exit(1)
}
const sig = await sendAndConfirmRawTransaction(conn, tx.serialize(), { commitment: 'confirmed' })
console.log('created Raydium CPMM AXA/AXB pool', created.extInfo.address.poolId.toBase58(), `(${sim.value.unitsConsumed} CU) |`, sig)
