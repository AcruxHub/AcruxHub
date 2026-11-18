import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { BN } from '@coral-xyz/anchor'
import {
  bridgeProgram, bridgeConfig, bridgeRoute, bridgeCustody, wrappedMint, outboundAddress, approvalAddress, consumedAddress,
  payloadArg, CHAIN, BRIDGE_ID, type Payload,
} from '../sdk/src/programs.ts'
import { relayOnce } from '../relayer/src/guardian.ts'
import { CHAIN_A_RPC, CHAIN_B_RPC, waitForChain, providerFor, devWallet, fund, newUser, newMint, giveTokens, balance, expectError } from './helpers.ts'

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const programData = PublicKey.findProgramAddressSync([BRIDGE_ID.toBytes()], LOADER)[0]
const CAP = new BN('1000000000000') // 1,000,000 tokens (6 dp) per 24h

async function init(conn: Connection, chainId: number, guardians: PublicKey[]) {
  await fund(conn, devWallet.publicKey, 20)
  const b = bridgeProgram(providerFor(conn, devWallet))
  if (await b.account.config.fetchNullable(bridgeConfig())) {
    await b.methods.setGuardians(guardians, 2).accountsPartial({ admin: devWallet.publicKey }).rpc()
    await b.methods.unpause().accountsPartial({ admin: devWallet.publicKey }).rpc()
  } else {
    await b.methods.initialize(chainId, guardians, 2).accountsPartial({ admin: devWallet.publicKey, program: BRIDGE_ID, programData }).rpc()
  }
  return b
}

async function nextNonce(conn: Connection) {
  return (await bridgeProgram(providerFor(conn, devWallet)).account.config.fetch(bridgeConfig())).nextNonce
}

test('Bridge: Solana -> Acrux -> Solana with 2-of-3 guardians, caps, pause, replay', async () => {
  const A = await waitForChain(CHAIN_A_RPC) // "Solana"
  const B = await waitForChain(CHAIN_B_RPC) // "Acrux"
  const guardians = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
  for (const g of guardians) { await fund(A, g.publicKey, 5); await fund(B, g.publicKey, 5) }
  const keys = guardians.map(g => g.publicKey)

  // Guardian rules are enforced at init.
  const bA = bridgeProgram(providerFor(A, devWallet))
  await fund(A, devWallet.publicKey, 20)
  if (!(await bA.account.config.fetchNullable(bridgeConfig()))) {
    await expectError(
      bA.methods.initialize(CHAIN.solana, keys, 1).accountsPartial({ admin: devWallet.publicKey, program: BRIDGE_ID, programData }).rpc(),
      'BadGuardians',
    )
  }
  await init(A, CHAIN.solana, keys)
  const bB = await init(B, CHAIN.acrux, keys)

  // Token X is native to A; its wrapped form lives on B.
  const x = await newMint(A, devWallet, 6)
  const wx = wrappedMint(CHAIN.solana, x)
  await bA.methods.registerNative(CHAIN.acrux, wx, CAP).accountsPartial({ admin: devWallet.publicKey, mint: x }).rpc()
  await bB.methods.registerWrapped(CHAIN.solana, x, 6, CAP).accountsPartial({ admin: devWallet.publicKey }).rpc()
  assert.equal((await getMint(B, wx)).decimals, 6)

  // User bridges 250 X from A to B.
  const user = await newUser(A)
  await fund(B, user.publicKey, 2)
  const userX = await giveTokens(A, devWallet, x, user.publicKey, 1_000_000_000n)
  const uA = bridgeProgram(providerFor(A, user))
  const nonceA = await nextNonce(A)
  await uA.methods.send(new BN(250_000_000), user.publicKey)
    .accountsPartial({ user: user.publicKey, mint: x, userTokens: userX, custody: bridgeCustody(x), outbound: outboundAddress(BigInt(nonceA.toString())) })
    .rpc()
  assert.equal(await balance(A, bridgeCustody(x)), 250_000_000n, 'locked in custody')

  const payload: Payload = { sourceChain: CHAIN.solana, nonce: BigInt(nonceA.toString()), destChain: CHAIN.acrux, destMint: wx, recipient: user.publicKey, amount: 250_000_000n }

  // An outsider cannot approve, and cannot forge a payload.
  const outsider = await newUser(B)
  await expectError(
    bridgeProgram(providerFor(B, outsider)).methods.approve(payloadArg(payload)).accountsPartial({ guardian: outsider.publicKey, approval: approvalAddress(payload) }).rpc(),
    'Unauthorized',
  )

  // One guardian is not enough.
  const AtoB = (g: Keypair) => relayOnce({ conn: A, chainId: CHAIN.solana }, { conn: B, chainId: CHAIN.acrux }, g, () => {}, 'confirmed')
  const BtoA = (g: Keypair) => relayOnce({ conn: B, chainId: CHAIN.acrux }, { conn: A, chainId: CHAIN.solana }, g, () => {}, 'confirmed')
  const r1 = await AtoB(guardians[0])
  assert.equal(r1.executed, 0)
  const userWx = getAssociatedTokenAddressSync(wx, user.publicKey)
  await expectError(
    bridgeProgram(providerFor(B, outsider)).methods.execute().accountsPartial({
      payer: outsider.publicKey, approval: approvalAddress(payload), consumed: consumedAddress(CHAIN.solana, payload.nonce),
      route: bridgeRoute(wx), mint: wx, custody: null, recipient: user.publicKey, recipientTokens: userWx,
    }).rpc(),
    'NotEnoughApprovals',
  )

  // A lying guardian approving an inflated payload doesn't touch the honest one.
  const forged = { ...payload, amount: 999_000_000n }
  await bridgeProgram(providerFor(B, guardians[2])).methods.approve(payloadArg(forged)).accountsPartial({ guardian: guardians[2].publicKey, approval: approvalAddress(forged) }).rpc()

  // Second honest guardian: approved and executed.
  const r2 = await AtoB(guardians[1])
  assert.equal(r2.executed, 1)
  assert.equal(await balance(B, userWx), 250_000_000n, 'wrapped minted 1:1')

  // Replay of the same nonce, even with a different payload at quorum, is impossible.
  await bridgeProgram(providerFor(B, guardians[0])).methods.approve(payloadArg(forged)).accountsPartial({ guardian: guardians[0].publicKey, approval: approvalAddress(forged) }).rpc()
  await expectError(
    bridgeProgram(providerFor(B, outsider)).methods.execute().accountsPartial({
      payer: outsider.publicKey, approval: approvalAddress(forged), consumed: consumedAddress(CHAIN.solana, payload.nonce),
      route: bridgeRoute(wx), mint: wx, custody: null, recipient: user.publicKey, recipientTokens: userWx,
    }).rpc(),
    'already in use',
  )
  assert.equal(await balance(B, userWx), 250_000_000n)

  // Back: burn 100 wrapped on B, release 100 X on A.
  const uB = bridgeProgram(providerFor(B, user))
  const nonceB = await nextNonce(B)
  await uB.methods.send(new BN(100_000_000), user.publicKey)
    .accountsPartial({ user: user.publicKey, mint: wx, userTokens: userWx, custody: null, outbound: outboundAddress(BigInt(nonceB.toString())) })
    .rpc()
  assert.equal(await balance(B, userWx), 150_000_000n, 'burned')
  const xBefore = await balance(A, userX)
  await BtoA(guardians[0])
  await BtoA(guardians[2])
  assert.equal((await balance(A, userX)) - xBefore, 100_000_000n, 'released from custody')
  assert.equal(await balance(A, bridgeCustody(x)), 150_000_000n)
  assert.equal((await getMint(B, wx)).supply, 150_000_000n, 'wrapped supply == custody')

  // Daily cap: lower it below the next transfer; execution is refused until raised.
  await bB.methods.setCap(new BN(10_000_000)).accountsPartial({ admin: devWallet.publicKey, route: bridgeRoute(wx) }).rpc()
  const n3 = await nextNonce(A)
  await uA.methods.send(new BN(50_000_000), user.publicKey)
    .accountsPartial({ user: user.publicKey, mint: x, userTokens: userX, custody: bridgeCustody(x), outbound: outboundAddress(BigInt(n3.toString())) })
    .rpc()
  await AtoB(guardians[0])
  const capped = await AtoB(guardians[1])
  assert.equal(capped.executed, 0, 'cap blocks execution')
  assert.equal(await balance(B, userWx), 150_000_000n)
  await bB.methods.setCap(CAP).accountsPartial({ admin: devWallet.publicKey, route: bridgeRoute(wx) }).rpc()
  const after = await AtoB(guardians[2])
  assert.equal(after.executed, 1, 'executes once the cap allows it')
  assert.equal(await balance(B, userWx), 200_000_000n)

  // Any guardian can pause; then sends fail; only the admin unpauses.
  await bridgeProgram(providerFor(A, guardians[1])).methods.pause().accountsPartial({ signer: guardians[1].publicKey }).rpc()
  const n4 = await nextNonce(A)
  await expectError(
    uA.methods.send(new BN(1_000_000), user.publicKey)
      .accountsPartial({ user: user.publicKey, mint: x, userTokens: userX, custody: bridgeCustody(x), outbound: outboundAddress(BigInt(n4.toString())) })
      .rpc(),
    'Paused',
  )
  await expectError(bridgeProgram(providerFor(A, guardians[1])).methods.unpause().accountsPartial({ admin: guardians[1].publicKey }).rpc(), 'Unauthorized')
  await bA.methods.unpause().accountsPartial({ admin: devWallet.publicKey }).rpc()

  // Rotating the guardian set voids pending approvals.
  const n5 = await nextNonce(A)
  await uA.methods.send(new BN(5_000_000), user.publicKey)
    .accountsPartial({ user: user.publicKey, mint: x, userTokens: userX, custody: bridgeCustody(x), outbound: outboundAddress(BigInt(n5.toString())) })
    .rpc()
  await AtoB(guardians[0])
  const fresh = [guardians[0], Keypair.generate(), Keypair.generate()]
  await fund(B, fresh[1].publicKey, 2)
  await bB.methods.setGuardians(fresh.map(g => g.publicKey), 2).accountsPartial({ admin: devWallet.publicKey }).rpc()
  const p5: Payload = { sourceChain: CHAIN.solana, nonce: BigInt(n5.toString()), destChain: CHAIN.acrux, destMint: wx, recipient: user.publicKey, amount: 5_000_000n }
  await expectError(
    bridgeProgram(providerFor(B, outsider)).methods.execute().accountsPartial({
      payer: outsider.publicKey, approval: approvalAddress(p5), consumed: consumedAddress(CHAIN.solana, p5.nonce),
      route: bridgeRoute(wx), mint: wx, custody: null, recipient: user.publicKey, recipientTokens: userWx,
    }).rpc(),
    'StaleApprovals',
  )
  // The new set re-approves and it goes through.
  await AtoB(fresh[0])
  const done = await AtoB(fresh[1])
  assert.equal(done.executed, 1)
  assert.equal(await balance(B, userWx), 205_000_000n)
})
