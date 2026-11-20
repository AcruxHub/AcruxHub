// Wrapped ACRUX on a local chain (:8999, scripts/localnet.sh with wacrux built).
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getMint, createTransferInstruction } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import {
  wacruxProgram, wacruxMint, wacruxVault, wrapInstruction, unwrapInstruction,
} from '../sdk/src/programs.ts'
import { CHAIN_B_RPC, waitForChain, providerFor, devWallet, fund, newUser, balance, expectError } from './helpers.ts'

test('wACRUX: wrap and unwrap 1:1, fully backed, nobody can take what is not theirs', async () => {
  const conn = await waitForChain(CHAIN_B_RPC)
  await fund(conn, devWallet.publicKey, 20)
  const w = wacruxProgram(providerFor(conn, devWallet))
  await w.methods.initialize().accountsPartial({ payer: devWallet.publicKey }).rpc()
  await expectError(w.methods.initialize().accountsPartial({ payer: devWallet.publicKey }).rpc(), 'already in use')
  const mint = await getMint(conn, wacruxMint())
  assert.equal(mint.decimals, 9)
  assert.ok(mint.mintAuthority!.equals(wacruxVault()), 'only the vault can mint')
  assert.equal(mint.freezeAuthority, null, 'nobody can freeze')

  const alice = await newUser(conn, 10)
  const wa = wacruxProgram(providerFor(conn, alice))
  const aliceTokens = getAssociatedTokenAddressSync(wacruxMint(), alice.publicKey)
  const vaultRent = BigInt(await conn.getMinimumBalanceForRentExemption((await conn.getAccountInfo(wacruxVault()))!.data.length))
  const backing = async () => BigInt(await conn.getBalance(wacruxVault())) - vaultRent

  // Wrap 3 ACRUX: 3 wACRUX minted, vault holds exactly 3 more.
  const before = BigInt(await conn.getBalance(alice.publicKey))
  await sendAndConfirmTransaction(conn, new Transaction().add(await wrapInstruction(wa, alice.publicKey, 3n * BigInt(LAMPORTS_PER_SOL))), [alice])
  assert.equal(await balance(conn, aliceTokens), 3_000_000_000n)
  assert.equal(await backing(), 3_000_000_000n)
  assert.equal((await getMint(conn, wacruxMint())).supply, 3_000_000_000n)
  assert.ok(before - BigInt(await conn.getBalance(alice.publicKey)) >= 3_000_000_000n)

  // Unwrap 1: 1 ACRUX back, still fully backed.
  const mid = BigInt(await conn.getBalance(alice.publicKey))
  await sendAndConfirmTransaction(conn, new Transaction().add(await unwrapInstruction(wa, alice.publicKey, 1_000_000_000n)), [alice])
  assert.equal(await balance(conn, aliceTokens), 2_000_000_000n)
  assert.equal(await backing(), 2_000_000_000n)
  assert.equal((await getMint(conn, wacruxMint())).supply, 2_000_000_000n)
  assert.ok(BigInt(await conn.getBalance(alice.publicKey)) - mid > 999_000_000n, 'got the ACRUX back (minus the tx fee)')

  // Can't unwrap more than you hold, or zero.
  await expectError(wa.methods.unwrap(new BN('2000000001')).accountsPartial({ user: alice.publicKey, userTokens: aliceTokens }).rpc(), 'insufficient funds')
  await expectError(wa.methods.unwrap(new BN(0)).accountsPartial({ user: alice.publicKey, userTokens: aliceTokens }).rpc(), 'ZeroAmount')

  // Bob can't unwrap Alice's wACRUX.
  const bob = await newUser(conn, 2)
  const wb = wacruxProgram(providerFor(conn, bob))
  await expectError(wb.methods.unwrap(new BN(1)).accountsPartial({ user: bob.publicKey, userTokens: aliceTokens }).rpc(), 'ConstraintTokenOwner')

  // wACRUX moves like any token; whoever holds it can unwrap it.
  await sendAndConfirmTransaction(conn, new Transaction().add(
    await wrapInstruction(wb, bob.publicKey, 1n), // creates Bob's account
    createTransferInstruction(aliceTokens, getAssociatedTokenAddressSync(wacruxMint(), bob.publicKey), alice.publicKey, 500_000_000n),
  ), [bob, alice])
  await sendAndConfirmTransaction(conn, new Transaction().add(await unwrapInstruction(wb, bob.publicKey, 500_000_001n)), [bob])
  assert.equal(await backing(), 1_500_000_000n)
  assert.equal((await getMint(conn, wacruxMint())).supply, 1_500_000_000n)

  // Everyone out: the vault drains to exactly its rent, never below.
  await sendAndConfirmTransaction(conn, new Transaction().add(await unwrapInstruction(wa, alice.publicKey, 1_500_000_000n)), [alice])
  assert.equal(await backing(), 0n)
  assert.equal((await getMint(conn, wacruxMint())).supply, 0n)
  void Keypair
})
