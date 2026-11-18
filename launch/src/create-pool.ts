// Step 2: create the Raydium CPMM pool TOKEN/ACRUX (0.25% fee tier) and lock 100%
// of the LP with Raydium Burn & Earn. The liquidity can then never be withdrawn,
// but the fee-key NFT (sent to the keeper wallet) can still collect trading fees.
//
//   NETWORK=local node --import tsx launch/src/create-pool.ts <token amount> <ACRUX amount>
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { NETWORK, conn, wallet, raydiumFor, loadState, saveState, requireYes, RAY, FEE_CONFIG, txVersion, fmt } from './common.ts'

const [tokenWhole, quoteWhole] = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (!tokenWhole || !quoteWhole) throw new Error('usage: create-pool.ts <token amount> <ACRUX amount>')
const state = loadState()
if (!state.token || !state.quote) throw new Error('run create-token first')
if (state.pool) throw new Error(`pool already exists: ${state.pool.id}`)

const launcher = wallet('launcher')
const keeper = wallet('keeper')
const tokenAmt = new BN(tokenWhole).mul(new BN(10).pow(new BN(state.token.decimals)))
const quoteAmt = new BN(quoteWhole).mul(new BN(10).pow(new BN(state.quote.decimals)))

requireYes([
  `Create Raydium CPMM pool ${state.token.symbol}/ACRUX (0.25% fee, 0.15 SOL Raydium creation fee):`,
  `  deposit ${tokenWhole} ${state.token.symbol} + ${quoteWhole} ACRUX from ${launcher.publicKey.toBase58()}`,
  `  opening price: ${(Number(quoteWhole) / Number(tokenWhole)).toExponential(4)} ACRUX per ${state.token.symbol}`,
  `Then lock 100% of the LP forever (Raydium Burn & Earn); fee key to keeper ${keeper.publicKey.toBase58()}.`,
].join('\n'))

const raydium = await raydiumFor(launcher)
const mintInfo = (mint: string, decimals: number) => ({ address: mint, decimals, programId: TOKEN_PROGRAM_ID.toBase58() })

const created = await raydium.cpmm.createPool({
  programId: RAY.cpmmProgram,
  poolFeeAccount: RAY.cpmmPoolFeeAccount,
  mintA: mintInfo(state.token.mint, state.token.decimals),
  mintB: mintInfo(state.quote.mint, state.quote.decimals),
  mintAAmount: tokenAmt,
  mintBAmount: quoteAmt,
  startTime: new BN(0),
  feeConfig: FEE_CONFIG as any,
  associatedOnly: false,
  ownerInfo: { useSOLBalance: true },
  txVersion,
})
const { txId: createTx } = await created.execute({ sendAndConfirm: true })
const poolId = created.extInfo.address.poolId.toBase58()
const lpMint = created.extInfo.address.lpMint.toBase58()
console.log('pool', poolId, 'lp mint', lpMint, '|', createTx)

// Lock every LP token the launcher received.
const lpAta = getAssociatedTokenAddressSync(new PublicKey(lpMint), launcher.publicKey)
const lpAmount = (await getAccount(conn, lpAta)).amount
const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId)
const locked = await raydium.cpmm.lockLp({
  programId: RAY.lockProgram,
  authProgram: RAY.lockAuth,
  poolInfo,
  poolKeys,
  lpAmount: new BN(lpAmount.toString()),
  withMetadata: true,
  feeNftOwner: keeper.publicKey,
  txVersion,
})
const { txId: lockTx } = await locked.execute({ sendAndConfirm: true })
const nftMint = locked.extInfo.nftMint.toBase58()
const left = (await getAccount(conn, lpAta)).amount
console.log(`locked ${fmt(lpAmount, 9)} LP (left with launcher: ${left}) | fee key NFT ${nftMint} -> keeper | ${lockTx}`)
if (left !== 0n) throw new Error('some LP was not locked')

state.pool = { id: poolId, lpMint, mintA: poolInfo.mintA.address, mintB: poolInfo.mintB.address }
state.lock = { nftMint, lpLocked: lpAmount.toString(), owner: keeper.publicKey.toBase58() }
saveState(state)
