// Graduation into a Raydium CPMM pool, against Raydium's real program cloned from
// mainnet. Needs a fresh `scripts/raydium-localnet.sh start` (with the launchpad
// built) on :8899. Quote is the native mint, as wrapped ACRUX is on Acrux Net.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, createWrappedNativeAccount, createTransferInstruction, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import {
  launchpadProgram, launchConfig, launchAddress, curveBuy, stateOf, graduateAccounts, graduateRaydiumAccounts, LAUNCHPAD_ID,
} from '../sdk/src/programs.ts'
import { cpmmSwapInstruction, cpmmSwapOut, decodeCpmmConfig, decodeCpmmConfigExtra, decodeCpmmPool, RAYDIUM_CPMM_CREATE_FEE_RECEIVER } from '../sdk/src/raydium.ts'
import { waitForChain, providerFor, devWallet, fund, newUser, balance, expectError } from './helpers.ts'

const RPC = process.env.RAYDIUM_RPC ?? 'http://127.0.0.1:8899'
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const programData = PublicKey.findProgramAddressSync([LAUNCHPAD_ID.toBytes()], LOADER)[0]
/** Raydium CPMM fee tier index 0 (0.25%), cloned from mainnet by the script. */
const AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })

test('Launchpad: graduate into a Raydium CPMM pool with the LP burned', async () => {
  const conn = await waitForChain(RPC)
  await fund(conn, devWallet.publicKey, 50)
  const lp = launchpadProgram(providerFor(conn, devWallet))
  const quoteMint = NATIVE_MINT
  const feeRecipient = Keypair.generate().publicKey
  const feeAta = (await getOrCreateAssociatedTokenAccount(conn, devWallet, quoteMint, feeRecipient)).address

  const params = {
    feeBps: 100,
    feeRecipient,
    totalSupply: new BN('1000000000000000'),
    curveSupply: new BN('800000000000000'),
    virtualQuote: new BN('30000000000'),
    virtualTokens: new BN('1073000000000000'),
    graduationQuote: new BN('20000000000'),
  }
  await lp.methods.initialize(params).accountsPartial({ admin: devWallet.publicKey, quoteMint, program: LAUNCHPAD_ID, programData }).rpc()

  const creator = await newUser(conn)
  const mint = Keypair.generate()
  await launchpadProgram(providerFor(conn, creator)).methods.createLaunch('Ray Rocket', 'RRKT', 'https://example.invalid/rrkt.json')
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint })
    .signers([mint]).rpc()
  const launchKey = launchAddress(mint.publicKey)
  let launch = await lp.account.launch.fetch(launchKey)
  const g = graduateRaydiumAccounts(launch, quoteMint, AMM_CONFIG)

  const buyer = await newUser(conn, 100)
  const lpB = launchpadProgram(providerFor(conn, buyer))
  const buyerQuote = await createWrappedNativeAccount(conn, buyer, buyer.publicKey, 80_000_000_000)
  const buyerTokens = getAssociatedTokenAddressSync(mint.publicKey, buyer.publicKey)
  const trade = { user: buyer.publicKey, launch: launchKey, mint: mint.publicKey, quoteMint, curveTokens: launch.curveTokens, curveQuote: launch.curveQuote, userTokens: buyerTokens, userQuote: buyerQuote, feeQuote: feeAta }

  // Not before the curve completes.
  await lpB.methods.buy(new BN('5000000000'), new BN(1)).accountsPartial(trade).rpc()
  await expectError(lpB.methods.graduateRaydium().accountsPartial({ payer: buyer.publicKey, ...g }).preInstructions([cu]).rpc(), 'NotComplete')

  // Complete it.
  launch = await lp.account.launch.fetch(launchKey)
  const big = curveBuy(stateOf(launch), 50_000_000_000n)!
  assert.ok(big.completes)
  await lpB.methods.buy(new BN('50000000000'), new BN(big.tokensOut.toString())).accountsPartial(trade).rpc()
  launch = await lp.account.launch.fetch(launchKey)
  assert.equal(launch.complete, true)
  const s = stateOf(launch)
  const heldTokens = await balance(conn, launch.curveTokens)
  const poolTokens = (s.realQuote * s.virtualTokens) / s.virtualQuote
  assert.ok(poolTokens < heldTokens)

  // A fee tier that is not a Raydium AmmConfig is refused.
  const cranker = await newUser(conn)
  const lpK = launchpadProgram(providerFor(conn, cranker))
  await expectError(
    lpK.methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...graduateRaydiumAccounts(launch, quoteMint, launchConfig()) }).preInstructions([cu]).rpc(),
    'BadFeeTier',
  )

  // Anyone graduates.
  const cfgInfo = (await conn.getAccountInfo(AMM_CONFIG))!
  const createPoolFee = decodeCpmmConfigExtra(cfgInfo.data as Buffer).createPoolFee
  const feeReceiverBefore = BigInt(await conn.getBalance(RAYDIUM_CPMM_CREATE_FEE_RECEIVER))
  const crankerBefore = BigInt(await conn.getBalance(cranker.publicKey))
  const sig = await lpK.methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...g }).preInstructions([cu]).rpc()

  launch = await lp.account.launch.fetch(launchKey)
  assert.equal(launch.graduated, true)
  assert.ok(launch.pool.equals(g.poolState))
  assert.equal(await balance(conn, launch.curveTokens), 0n, 'leftover tokens burned')
  assert.equal(await balance(conn, launch.curveQuote), 0n)
  assert.equal((await getMint(conn, mint.publicKey)).supply, 1_000_000_000_000_000n - (heldTokens - poolTokens))

  // The LP is burned: liquidity locked forever.
  const pool = decodeCpmmPool(g.poolState, (await conn.getAccountInfo(g.poolState))!.data as Buffer)
  assert.ok(pool.config.equals(AMM_CONFIG))
  assert.ok(pool.lpSupply > 0n)
  assert.equal((await getMint(conn, g.lpMint)).supply, 0n, 'all LP burned')
  // The graduator is left with nothing: its token accounts are closed and its lamports refunded.
  for (const a of [g.graduator, g.graduatorTokens, g.graduatorQuote, g.graduatorLp]) assert.equal(await conn.getAccountInfo(a), null)

  // The pool opens at the curve's final price.
  const tokenIs0 = pool.mintA.equals(mint.publicKey)
  const [tokVault, quoteVault] = tokenIs0 ? [pool.vaultA, pool.vaultB] : [pool.vaultB, pool.vaultA]
  assert.equal(await balance(conn, quoteVault), BigInt(params.graduationQuote.toString()))
  assert.equal(await balance(conn, tokVault), poolTokens)
  const curvePrice = Number(s.virtualQuote) / Number(s.virtualTokens)
  const poolPrice = Number(await balance(conn, quoteVault)) / Number(await balance(conn, tokVault))
  assert.ok(Math.abs(poolPrice / curvePrice - 1) < 1e-6, `pool opens at curve price (${poolPrice} vs ${curvePrice})`)

  // The cranker paid exactly Raydium's fee, the rent of Raydium's pool accounts and
  // the tx fee; everything else came back.
  assert.equal(BigInt(await conn.getBalance(RAYDIUM_CPMM_CREATE_FEE_RECEIVER)) - feeReceiverBefore, createPoolFee)
  let poolRent = 0n
  for (const a of [g.poolState, g.lpMint, g.vault0, g.vault1, g.observation]) poolRent += BigInt((await conn.getAccountInfo(a))!.lamports)
  poolRent -= await balance(conn, quoteVault) // the native vault's lamports include the wrapped quote
  const meta = (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.meta!
  const txFee = BigInt(meta.fee)
  console.log(`graduate_raydium used ${meta.computeUnitsConsumed} compute units`)
  const spent = crankerBefore - BigInt(await conn.getBalance(cranker.publicKey))
  assert.equal(spent, createPoolFee + poolRent + txFee)
  console.log(`graduation cost the cranker ${spent} lamports: fee ${createPoolFee} + pool rent ${poolRent} + tx ${txFee}`)

  // Neither graduation can run again.
  await expectError(lpK.methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...g }).preInstructions([cu]).rpc(), 'NotComplete')
  await expectError(lpK.methods.graduate().accountsPartial({ payer: cranker.publicKey, ...graduateAccounts(launch, quoteMint) }).preInstructions([cu]).rpc(), 'NotComplete')

  // Swaps work both ways, paying exactly what the CPMM math says.
  const cfg = decodeCpmmConfig(AMM_CONFIG, cfgInfo.data as Buffer)
  for (let i = 0; i < 30; i++) {
    const t = await conn.getBlockTime(await conn.getSlot())
    if (t !== null && BigInt(t) > pool.openTime) break
    await new Promise(r => setTimeout(r, 500))
  }
  const swap = async (quoteToToken: boolean, amountIn: bigint) => {
    const p = decodeCpmmPool(g.poolState, (await conn.getAccountInfo(g.poolState))!.data as Buffer)
    const aToB = quoteToToken !== tokenIs0
    const [vIn, vOut, heldIn, heldOut] = aToB ? [p.vaultA, p.vaultB, p.heldFeesA, p.heldFeesB] : [p.vaultB, p.vaultA, p.heldFeesB, p.heldFeesA]
    const expected = cpmmSwapOut(amountIn, (await balance(conn, vIn)) - heldIn, (await balance(conn, vOut)) - heldOut, cfg, p, aToB)
    assert.ok(expected > 0n)
    const [userIn, userOut] = quoteToToken ? [buyerQuote, buyerTokens] : [buyerTokens, buyerQuote]
    const outBefore = await balance(conn, userOut)
    await sendAndConfirmTransaction(conn, new Transaction().add(
      cpmmSwapInstruction({ pool: p, payer: buyer.publicKey, aToB, userIn, userOut, amountIn, minOut: expected }),
    ), [buyer], { commitment: 'confirmed' })
    assert.equal((await balance(conn, userOut)) - outBefore, expected)
    return expected
  }
  const bought = await swap(true, 1_000_000_000n)
  await swap(false, bought / 2n)
})

/** Raydium CPMM fee tier index 2 (2% trade fee), cloned from mainnet by the script. */
const TIER_2PCT = new PublicKey('2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5')

test('Launchpad: graduate_raydium refuses a fee tier over 1% and cannot be blocked by dusting the graduator', async () => {
  const conn = await waitForChain(RPC)
  const quoteMint = NATIVE_MINT
  const cfgAcct = await launchpadProgram(providerFor(conn, devWallet)).account.config.fetch(launchConfig())
  const feeAta = getAssociatedTokenAddressSync(quoteMint, cfgAcct.params.feeRecipient)

  const creator = await newUser(conn)
  const mint = Keypair.generate()
  await launchpadProgram(providerFor(conn, creator)).methods.createLaunch('Dust Proof', 'DUST', 'https://example.invalid/dust.json')
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint })
    .signers([mint]).rpc()
  const launchKey = launchAddress(mint.publicKey)
  let launch = await launchpadProgram(providerFor(conn, devWallet)).account.launch.fetch(launchKey)

  // One buyer completes the curve.
  const buyer = await newUser(conn, 100)
  const lpB = launchpadProgram(providerFor(conn, buyer))
  const buyerQuote = await createWrappedNativeAccount(conn, buyer, buyer.publicKey, 80_000_000_000)
  const buyerTokens = getAssociatedTokenAddressSync(mint.publicKey, buyer.publicKey)
  const trade = { user: buyer.publicKey, launch: launchKey, mint: mint.publicKey, quoteMint, curveTokens: launch.curveTokens, curveQuote: launch.curveQuote, userTokens: buyerTokens, userQuote: buyerQuote, feeQuote: feeAta }
  const big = curveBuy(stateOf(launch), 50_000_000_000n)!
  assert.ok(big.completes)
  await lpB.methods.buy(new BN('50000000000'), new BN(big.tokensOut.toString())).accountsPartial(trade).rpc()
  launch = await lpB.account.launch.fetch(launchKey)
  assert.equal(launch.complete, true)

  // A griefer pre-creates the graduator's token account and dusts it with 1 unit.
  const g = graduateRaydiumAccounts(launch, quoteMint, AMM_CONFIG)
  const dusted = await getOrCreateAssociatedTokenAccount(conn, buyer, mint.publicKey, g.graduator, true)
  assert.ok(dusted.address.equals(g.graduatorTokens))
  await sendAndConfirmTransaction(conn, new Transaction().add(createTransferInstruction(buyerTokens, g.graduatorTokens, buyer.publicKey, 1n)), [buyer], { commitment: 'confirmed' })

  const cranker = await newUser(conn)
  const lpK = launchpadProgram(providerFor(conn, cranker))
  // A real Raydium tier, but its 2% trade fee is over the 1% cap.
  assert.equal(decodeCpmmConfig(TIER_2PCT, (await conn.getAccountInfo(TIER_2PCT))!.data as Buffer).tradeFeeRate, 20_000n)
  await expectError(
    lpK.methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...graduateRaydiumAccounts(launch, quoteMint, TIER_2PCT) }).preInstructions([cu]).rpc(),
    'BadFeeTier',
  )

  // Graduation still goes through on an allowed tier.
  await lpK.methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...g }).preInstructions([cu]).rpc()
  launch = await lpK.account.launch.fetch(launchKey)
  assert.equal(launch.graduated, true)
  assert.equal((await getMint(conn, g.lpMint)).supply, 0n, 'all LP burned')
  // The dusted account keeps exactly its dust; the rest are closed and the graduator is empty.
  assert.equal(await balance(conn, g.graduatorTokens), 1n)
  for (const a of [g.graduatorQuote, g.graduatorLp]) assert.equal(await conn.getAccountInfo(a), null)
  assert.equal(await conn.getBalance(g.graduator), 0)
})
