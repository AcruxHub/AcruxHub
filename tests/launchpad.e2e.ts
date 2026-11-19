import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import {
  launchpadProgram, ammProgram, launchConfig, launchAddress, curveBuy, curveSell, stateOf, graduateAccounts, LAUNCHPAD_ID,
} from '../sdk/src/programs.ts'
import { CHAIN_B_RPC, waitForChain, providerFor, devWallet, fund, newUser, newMint, giveTokens, balance, expectError } from './helpers.ts'

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const programData = PublicKey.findProgramAddressSync([LAUNCHPAD_ID.toBytes()], LOADER)[0]

test('Launchpad: init, launch, buy, sell, complete, graduate into a locked AMM pool', async () => {
  const conn = await waitForChain(CHAIN_B_RPC)
  await fund(conn, devWallet.publicKey, 50)
  const lp = launchpadProgram(providerFor(conn, devWallet))
  const quoteMint = await newMint(conn, devWallet, 9) // stands in for wrapped ACRUX
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

  // Only the upgrade authority may initialize.
  const stranger = await newUser(conn)
  await expectError(
    launchpadProgram(providerFor(conn, stranger)).methods.initialize(params)
      .accountsPartial({ admin: stranger.publicKey, quoteMint, program: LAUNCHPAD_ID, programData }).rpc(),
    'Unauthorized',
  )
  // Bad params are rejected.
  await expectError(
    lp.methods.initialize({ ...params, curveSupply: new BN(1) })
      .accountsPartial({ admin: devWallet.publicKey, quoteMint, program: LAUNCHPAD_ID, programData }).rpc(),
    'BadConfig',
  )
  await lp.methods.initialize(params).accountsPartial({ admin: devWallet.publicKey, quoteMint, program: LAUNCHPAD_ID, programData }).rpc()

  // Creator launches a token.
  const creator = await newUser(conn)
  const lpC = launchpadProgram(providerFor(conn, creator))
  const mint = Keypair.generate()
  await lpC.methods.createLaunch('Test Rocket', 'RKT', 'https://example.invalid/rkt.json')
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint })
    .signers([mint]).rpc()
  const launchKey = launchAddress(mint.publicKey)
  let launch = await lp.account.launch.fetch(launchKey)
  assert.equal(launch.symbol, 'RKT')
  const tokenMint = await getMint(conn, mint.publicKey)
  assert.equal(tokenMint.mintAuthority, null, 'supply is fixed')
  assert.equal(tokenMint.supply, 1_000_000_000_000_000n)
  assert.equal(await balance(conn, launch.curveTokens), 1_000_000_000_000_000n, 'creator got nothing for free')

  // Buyer buys 5 quote.
  const buyer = await newUser(conn)
  const lpB = launchpadProgram(providerFor(conn, buyer))
  const buyerQuote = await giveTokens(conn, devWallet, quoteMint, buyer.publicKey, 100_000_000_000n)
  const buyerTokens = getAssociatedTokenAddressSync(mint.publicKey, buyer.publicKey)
  const tradeAccounts = { user: buyer.publicKey, launch: launchKey, mint: mint.publicKey, quoteMint, curveTokens: launch.curveTokens, curveQuote: launch.curveQuote, userTokens: buyerTokens, userQuote: buyerQuote, feeQuote: feeAta }

  const q1 = curveBuy(stateOf(launch), 5_000_000_000n)!
  await expectError(lpB.methods.buy(new BN('5000000000'), new BN((q1.tokensOut + 1n).toString())).accountsPartial(tradeAccounts).rpc(), 'Slippage')
  await lpB.methods.buy(new BN('5000000000'), new BN(q1.tokensOut.toString())).accountsPartial(tradeAccounts).rpc()
  assert.equal(await balance(conn, buyerTokens), q1.tokensOut)
  assert.equal(await balance(conn, feeAta), q1.fee)
  assert.equal(await balance(conn, launch.curveQuote), q1.quoteToCurve)

  // Sell half back at the exact quoted price.
  launch = await lp.account.launch.fetch(launchKey)
  const half = q1.tokensOut / 2n
  const s1 = curveSell(stateOf(launch), half)!
  const before = await balance(conn, buyerQuote)
  await lpB.methods.sell(new BN(half.toString()), new BN(s1.quoteOut.toString())).accountsPartial(tradeAccounts).rpc()
  assert.equal((await balance(conn, buyerQuote)) - before, s1.quoteOut)

  // Graduation before completion is refused.
  launch = await lp.account.launch.fetch(launchKey)
  const g = graduateAccounts(launch, quoteMint)
  await expectError(lpB.methods.graduate().accountsPartial({ payer: buyer.publicKey, ...g }).rpc(), 'NotComplete')

  // A big buy is clipped at the threshold and completes the curve.
  const big = curveBuy(stateOf(launch), 50_000_000_000n)!
  assert.ok(big.completes)
  const spentBefore = await balance(conn, buyerQuote)
  await lpB.methods.buy(new BN('50000000000'), new BN(big.tokensOut.toString())).accountsPartial(tradeAccounts).rpc()
  assert.equal(spentBefore - (await balance(conn, buyerQuote)), big.quoteToCurve + big.fee, 'only paid for what it got')
  launch = await lp.account.launch.fetch(launchKey)
  assert.equal(launch.complete, true)
  assert.equal(launch.realQuote.toString(), params.graduationQuote.toString())
  await expectError(lpB.methods.buy(new BN(1_000_000), new BN(1)).accountsPartial(tradeAccounts).rpc(), 'Complete')

  // Anyone graduates.
  const cranker = await newUser(conn)
  await launchpadProgram(providerFor(conn, cranker)).methods.graduate()
    .accountsPartial({ payer: cranker.publicKey, ...g }).preInstructions([
      // graduation does two CPIs that create five accounts
      (await import('@solana/web3.js')).ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ]).rpc()
  launch = await lp.account.launch.fetch(launchKey)
  assert.equal(launch.graduated, true)
  assert.ok(launch.pool.equals(g.pool))
  assert.equal((await getMint(conn, g.lpMint)).supply, 0n, 'all LP burned: liquidity locked forever')
  assert.equal(await balance(conn, launch.curveTokens), 0n, 'leftover tokens burned')
  assert.equal(await balance(conn, launch.curveQuote), 0n)

  // The pool trades, at the curve's final price.
  const amm = ammProgram(providerFor(conn, buyer))
  const pool = await amm.account.pool.fetch(g.pool)
  const tokenIsA = pool.mintA.equals(mint.publicKey)
  const reserveTok = await balance(conn, tokenIsA ? g.vaultA : g.vaultB)
  const reserveQuote = await balance(conn, tokenIsA ? g.vaultB : g.vaultA)
  assert.equal(reserveQuote, BigInt(params.graduationQuote.toString()))
  const curvePrice = Number(launch.virtualQuote) / Number(launch.virtualTokens)
  const poolPrice = Number(reserveQuote) / Number(reserveTok)
  assert.ok(Math.abs(poolPrice / curvePrice - 1) < 1e-6, `pool opens at curve price (${poolPrice} vs ${curvePrice})`)
  const slot = await conn.getSlot()
  await amm.methods.swap(new BN(1_000_000_000), new BN(1), !tokenIsA, new BN(slot + 500))
    .accountsPartial({
      user: buyer.publicKey, pool: g.pool, mintA: pool.mintA, mintB: pool.mintB, vaultA: g.vaultA, vaultB: g.vaultB,
      userA: getAssociatedTokenAddressSync(pool.mintA, buyer.publicKey), userB: getAssociatedTokenAddressSync(pool.mintB, buyer.publicKey),
    }).rpc()
})

test('Launchpad: set_quote moves new launches to a new quote; old launches keep theirs', async () => {
  const conn = await waitForChain(CHAIN_B_RPC)
  const lp = launchpadProgram(providerFor(conn, devWallet))
  const cfg = await lp.account.config.fetch(launchConfig())
  const oldQuote = cfg.quoteMint as PublicKey
  const feeRecipient = cfg.params.feeRecipient as PublicKey
  const { ComputeBudgetProgram } = await import('@solana/web3.js')

  // A launch created under the old quote, partly bought.
  const creator = await newUser(conn)
  const lpC = launchpadProgram(providerFor(conn, creator))
  const oldMint = Keypair.generate()
  await lpC.methods.createLaunch('Old Quote', 'OLDQ', 'https://example.invalid/old.json')
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: oldMint.publicKey, quoteMint: oldQuote })
    .signers([oldMint]).rpc()
  const oldKey = launchAddress(oldMint.publicKey)
  let oldLaunch = await lp.account.launch.fetch(oldKey)

  // The new quote: 6 decimals, so the curve parameters are rescaled with it.
  const newQuote = await newMint(conn, devWallet, 6)
  const newParams = {
    ...cfg.params,
    virtualQuote: new BN('30000000'),
    graduationQuote: new BN('20000000'),
  }

  // Only the admin may switch.
  const stranger = await newUser(conn)
  await expectError(
    launchpadProgram(providerFor(conn, stranger)).methods.setQuote(newParams)
      .accountsPartial({ admin: stranger.publicKey, config: launchConfig(), quoteMint: newQuote }).rpc(),
    'Unauthorized',
  )
  // Bad params are rejected.
  await expectError(
    lp.methods.setQuote({ ...newParams, graduationQuote: new BN(0) })
      .accountsPartial({ admin: devWallet.publicKey, config: launchConfig(), quoteMint: newQuote }).rpc(),
    'BadConfig',
  )
  await lp.methods.setQuote(newParams).accountsPartial({ admin: devWallet.publicKey, config: launchConfig(), quoteMint: newQuote }).rpc()
  const after = await lp.account.config.fetch(launchConfig())
  assert.ok((after.quoteMint as PublicKey).equals(newQuote))
  assert.equal(after.params.graduationQuote.toString(), '20000000')
  assert.equal(after.launchCount.toString(), cfg.launchCount.add(new BN(1)).toString(), 'launch count kept')

  // New launches use the new quote; creating one with the old quote is refused.
  const newMintKp = Keypair.generate()
  await expectError(
    lpC.methods.createLaunch('Wrong', 'WRNG', 'https://example.invalid/w.json')
      .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: newMintKp.publicKey, quoteMint: oldQuote })
      .signers([newMintKp]).rpc(),
    'ConstraintAddress',
  )
  await lpC.methods.createLaunch('New Quote', 'NEWQ', 'https://example.invalid/new.json')
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: newMintKp.publicKey, quoteMint: newQuote })
    .signers([newMintKp]).rpc()
  const newKey = launchAddress(newMintKp.publicKey)
  const newLaunch = await lp.account.launch.fetch(newKey)
  assert.equal(newLaunch.graduationQuote.toString(), '20000000', 'new launch takes the new parameters')

  const buyer = await newUser(conn)
  const lpB = launchpadProgram(providerFor(conn, buyer))
  const feeOld = (await getOrCreateAssociatedTokenAccount(conn, devWallet, oldQuote, feeRecipient)).address
  const feeNew = (await getOrCreateAssociatedTokenAccount(conn, devWallet, newQuote, feeRecipient)).address
  const buyerOld = await giveTokens(conn, devWallet, oldQuote, buyer.publicKey, 100_000_000_000n)
  const buyerNew = await giveTokens(conn, devWallet, newQuote, buyer.publicKey, 100_000_000n)
  const oldTrade = {
    user: buyer.publicKey, launch: oldKey, mint: oldMint.publicKey, quoteMint: oldQuote, curveTokens: oldLaunch.curveTokens, curveQuote: oldLaunch.curveQuote,
    userTokens: getAssociatedTokenAddressSync(oldMint.publicKey, buyer.publicKey), userQuote: buyerOld, feeQuote: feeOld,
  }

  // The old launch still trades in its own quote...
  const q = curveBuy(stateOf(oldLaunch), 1_000_000_000n)!
  await lpB.methods.buy(new BN('1000000000'), new BN(q.tokensOut.toString())).accountsPartial(oldTrade).rpc()
  assert.equal(await balance(conn, oldTrade.userTokens), q.tokensOut)
  // ...and can't be traded in the new one (its curve account holds the old quote).
  await expectError(
    lpB.methods.buy(new BN('1000000'), new BN(1)).accountsPartial({ ...oldTrade, quoteMint: newQuote, userQuote: buyerNew, feeQuote: feeNew }).rpc(),
    'ConstraintTokenMint',
  )

  // The new launch trades in the new quote.
  const qn = curveBuy(stateOf(newLaunch), 1_000_000n)!
  await lpB.methods.buy(new BN('1000000'), new BN(qn.tokensOut.toString())).accountsPartial({
    user: buyer.publicKey, launch: newKey, mint: newMintKp.publicKey, quoteMint: newQuote, curveTokens: newLaunch.curveTokens, curveQuote: newLaunch.curveQuote,
    userTokens: getAssociatedTokenAddressSync(newMintKp.publicKey, buyer.publicKey), userQuote: buyerNew, feeQuote: feeNew,
  }).rpc()
  assert.equal(await balance(conn, newLaunch.curveQuote), qn.quoteToCurve)

  // The old launch completes and graduates in its own quote after the switch.
  oldLaunch = await lp.account.launch.fetch(oldKey)
  const big = curveBuy(stateOf(oldLaunch), 50_000_000_000n)!
  assert.ok(big.completes)
  await lpB.methods.buy(new BN('50000000000'), new BN(big.tokensOut.toString())).accountsPartial(oldTrade).rpc()
  oldLaunch = await lp.account.launch.fetch(oldKey)
  const g = graduateAccounts(oldLaunch, oldQuote)
  await lpB.methods.graduate().accountsPartial({ payer: buyer.publicKey, ...g })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc()
  oldLaunch = await lp.account.launch.fetch(oldKey)
  assert.equal(oldLaunch.graduated, true)
  const pool = await ammProgram(providerFor(conn, buyer)).account.pool.fetch(g.pool)
  assert.ok([pool.mintA, pool.mintB].some((m: PublicKey) => m.equals(oldQuote)), 'graduated pool pairs with the old quote')
})
