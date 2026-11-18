import test from 'node:test'
import assert from 'node:assert/strict'
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import { ammProgram, poolAddresses, swapOut, depositQuote, withdrawQuote, MIN_LIQUIDITY } from '../sdk/src/programs.ts'
import { CHAIN_B_RPC, waitForChain, providerFor, newUser, newMint, giveTokens, balance, expectError } from './helpers.ts'

test('AMM: create, add, swap both ways, guards, remove', async () => {
  const conn = await waitForChain(CHAIN_B_RPC)
  const admin = await newUser(conn, 20)
  const trader = await newUser(conn)
  const x = await newMint(conn, admin)
  const y = await newMint(conn, admin)
  const p = poolAddresses(x, y, 30)
  const amm = ammProgram(providerFor(conn, admin))
  const ammT = ammProgram(providerFor(conn, trader))

  const adminA = await giveTokens(conn, admin, p.mintA, admin.publicKey, 10_000_000_000n)
  const adminB = await giveTokens(conn, admin, p.mintB, admin.publicKey, 10_000_000_000n)
  const traderA = await giveTokens(conn, admin, p.mintA, trader.publicKey, 1_000_000_000n)
  const traderB = getAssociatedTokenAddressSync(p.mintB, trader.publicKey)

  // Unsorted mints are rejected.
  await expectError(
    amm.methods.createPool(30).accountsPartial({ payer: admin.publicKey, mintA: p.mintB, mintB: p.mintA }).rpc(),
    'MintOrder',
  )
  await amm.methods.createPool(30).accountsPartial({ payer: admin.publicKey, mintA: p.mintA, mintB: p.mintB }).rpc()
  const pool = await amm.account.pool.fetch(p.pool)
  assert.equal(pool.feeBps, 30)
  assert.ok(pool.vaultA.equals(p.vaultA) && pool.lpMint.equals(p.lpMint))

  // First deposit: 1,000 A : 2,000 B (6 dp).
  const addAccounts = { payer: admin.publicKey, owner: admin.publicKey, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint, ownerA: adminA, ownerB: adminB }
  const first = depositQuote(0n, 0n, 0n, 1_000_000_000n, 2_000_000_000n)
  await amm.methods.addLiquidity(new BN(1_000_000_000), new BN(2_000_000_000), new BN(first.lp.toString())).accountsPartial(addAccounts).rpc()
  const adminLp = getAssociatedTokenAddressSync(p.lpMint, admin.publicKey)
  assert.equal(await balance(conn, adminLp), first.lp)

  // Second deposit at ratio: off-ratio max_b is trimmed.
  const second = depositQuote(1_000_000_000n, 2_000_000_000n, first.lp, 100_000_000n, 900_000_000n)
  await amm.methods.addLiquidity(new BN(100_000_000), new BN(900_000_000), new BN(second.lp.toString())).accountsPartial(addAccounts).rpc()
  assert.equal(await balance(conn, p.vaultA), 1_000_000_000n + second.amountA)
  assert.equal(await balance(conn, p.vaultB), 2_000_000_000n + second.amountB)

  const slot = await conn.getSlot()
  const swapAccounts = { user: trader.publicKey, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, userA: traderA, userB: traderB }

  // A -> B with exact expected output (output account created by the swap).
  const ra = await balance(conn, p.vaultA)
  const rb = await balance(conn, p.vaultB)
  const expect = swapOut(50_000_000n, ra, rb, 30)
  await ammT.methods.swap(new BN(50_000_000), new BN(expect.toString()), true, new BN(slot + 1000)).accountsPartial(swapAccounts).rpc()
  assert.equal(await balance(conn, traderB), expect)
  assert.equal(await balance(conn, traderA), 1_000_000_000n - 50_000_000n)

  // Slippage guard: asking for one unit more than possible fails.
  const ra2 = await balance(conn, p.vaultA)
  const rb2 = await balance(conn, p.vaultB)
  const back = swapOut(expect, rb2, ra2, 30)
  await expectError(
    ammT.methods.swap(new BN(expect.toString()), new BN((back + 1n).toString()), false, new BN(slot + 1000)).accountsPartial(swapAccounts).rpc(),
    'Slippage',
  )
  // Deadline guard.
  await expectError(
    ammT.methods.swap(new BN(1_000_000), new BN(1), true, new BN(1)).accountsPartial(swapAccounts).rpc(),
    'Expired',
  )
  // B -> A round trip loses exactly the fees (never profits).
  await ammT.methods.swap(new BN(expect.toString()), new BN(back.toString()), false, new BN(slot + 1000)).accountsPartial(swapAccounts).rpc()
  const finalA = await balance(conn, traderA)
  assert.equal(finalA, 1_000_000_000n - 50_000_000n + back)
  assert.ok(finalA < 1_000_000_000n)

  const counters = await amm.account.pool.fetch(p.pool)
  assert.equal(counters.swapCount.toNumber(), 2)

  // Remove all of admin's LP: gets pro-rata reserves, locked minimum stays.
  const lp = await balance(conn, adminLp)
  const supply = (await getMint(conn, p.lpMint)).supply
  const va = await balance(conn, p.vaultA)
  const vb = await balance(conn, p.vaultB)
  const w = withdrawQuote(va, vb, supply, lp)
  const beforeA = await balance(conn, adminA)
  await amm.methods
    .removeLiquidity(new BN(lp.toString()), new BN(w.amountA.toString()), new BN(w.amountB.toString()))
    .accountsPartial({ owner: admin.publicKey, pool: p.pool, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint, ownerA: adminA, ownerB: adminB, ownerLp: adminLp })
    .rpc()
  assert.equal((await balance(conn, adminA)) - beforeA, w.amountA)
  assert.equal((await getMint(conn, p.lpMint)).supply, 0n)
  assert.ok((await balance(conn, p.vaultA)) > 0n, 'locked minimum keeps reserves')
  assert.ok(MIN_LIQUIDITY > 0n)
})
