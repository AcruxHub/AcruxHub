// Token locks on a local chain (:8999, scripts/localnet.sh with locker built).
import test from 'node:test'
import assert from 'node:assert/strict'
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import { lockerProgram, lockAddress, loadLocks, lockInstruction, unlockInstruction, extendInstruction } from '../sdk/src/programs.ts'
import { CHAIN_B_RPC, waitForChain, providerFor, devWallet, fund, newUser, newMint, giveTokens, balance, expectError } from './helpers.ts'

const now = async (conn: any) => (await conn.getBlockTime(await conn.getSlot('confirmed'))) as number

test('Locks: nothing leaves before the date, only later extensions, owner gets it back after', async () => {
  const conn = await waitForChain(CHAIN_B_RPC)
  await fund(conn, devWallet.publicKey, 10)
  const mint = await newMint(conn, devWallet, 6)
  const alice = await newUser(conn, 5)
  const la = lockerProgram(providerFor(conn, alice))
  const aliceTokens = await giveTokens(conn, devWallet, mint, alice.publicKey, 1_000_000_000n)

  // Bad dates are refused.
  const t0 = await now(conn)
  await expectError(sendAndConfirmTransaction(conn, new Transaction().add(await lockInstruction(la, alice.publicKey, mint, 9n, 1n, t0 - 10)), [alice]), 'UnlockInPast')
  await expectError(sendAndConfirmTransaction(conn, new Transaction().add(await lockInstruction(la, alice.publicKey, mint, 9n, 1n, t0 + 11 * 365 * 86400)), [alice]), 'TooLong')

  // Lock 600 tokens for ~8 seconds, and 100 more in a second lock.
  const until = (await now(conn)) + 8
  await sendAndConfirmTransaction(conn, new Transaction().add(
    await lockInstruction(la, alice.publicKey, mint, 1n, 600_000_000n, until),
    await lockInstruction(la, alice.publicKey, mint, 2n, 100_000_000n, until + 3600),
  ), [alice])
  assert.equal(await balance(conn, aliceTokens), 300_000_000n)
  const lock1 = lockAddress(alice.publicKey, mint, 1n)
  assert.equal(await balance(conn, getAssociatedTokenAddressSync(mint, lock1, true)), 600_000_000n)
  const listed = await loadLocks(conn, la, { mint })
  assert.equal(listed.length, 2)
  assert.equal(listed[0].amount + listed[1].amount, 700_000_000n)

  // Still locked: nobody gets it out, not even the owner.
  const row = listed.find(l => l.id === 1n)!
  await expectError(sendAndConfirmTransaction(conn, new Transaction().add(await unlockInstruction(la, row)), [alice]), 'StillLocked')
  // Only later, and only by the owner.
  await expectError(sendAndConfirmTransaction(conn, new Transaction().add(await extendInstruction(la, row, until - 1)), [alice]), 'NotLater')
  const bob = await newUser(conn, 2)
  const lb = lockerProgram(providerFor(conn, bob))
  await expectError(lb.methods.extend(new BN(until + 5)).accountsPartial({ owner: bob.publicKey, lock: lock1 }).rpc(), 'NotOwner')
  await expectError(lb.methods.unlock().accountsPartial({ owner: bob.publicKey, lock: lock1, mint }).rpc(), 'NotOwner')
  await sendAndConfirmTransaction(conn, new Transaction().add(await extendInstruction(la, row, until + 2)), [alice])
  assert.equal((await loadLocks(conn, la, { mint })).find(l => l.id === 1n)!.unlockTs, until + 2)

  // After the date: all back to the owner, accounts closed.
  while ((await now(conn)) < until + 3) await new Promise(r => setTimeout(r, 1000))
  await sendAndConfirmTransaction(conn, new Transaction().add(await unlockInstruction(la, row)), [alice])
  assert.equal(await balance(conn, aliceTokens), 900_000_000n)
  assert.equal(await conn.getAccountInfo(lock1), null, 'lock closed')
  assert.equal(await conn.getAccountInfo(getAssociatedTokenAddressSync(mint, lock1, true)), null, 'vault closed')
  // The other lock is untouched.
  assert.equal((await loadLocks(conn, la, { mint })).length, 1)
})
