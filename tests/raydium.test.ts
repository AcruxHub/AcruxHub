// Checks our dependency-free Raydium CPMM reader and quote math against
// Raydium's own SDK (@raydium-io/raydium-sdk-v2): the same account bytes must
// decode to the same fields, and every quote must match theirs to the unit.

import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Keypair } from '@solana/web3.js'
import { CurveCalculator, CpmmPoolInfoLayout, CpmmConfigInfoLayout } from '@raydium-io/raydium-sdk-v2'
import { sha256 } from '@noble/hashes/sha256'
import { cpmmSwapOut, decodeCpmmPool, decodeCpmmConfig, platformFee, cpmmSwapInstruction, RAYDIUM_CPMM_AUTHORITY } from '../sdk/src/raydium.ts'

const disc = (name: string) => Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8))
const key = () => Keypair.generate().publicKey
let seed = 42
const rand = (max: bigint) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  let v = 0n
  for (let i = 0; i < 4; i++) v = (v << 31n) | BigInt((seed = (seed * 1103515245 + 12345) & 0x7fffffff))
  return v % max
}

test('pool and config decode like Raydium SDK layouts', () => {
  const fields = {
    configId: key(), poolCreator: key(), vaultA: key(), vaultB: key(), mintLp: key(), mintA: key(), mintB: key(),
    mintProgramA: key(), mintProgramB: key(), observationId: key(),
    bump: 254, status: 4, lpDecimals: 9, mintDecimalA: 6, mintDecimalB: 9,
    lpAmount: new BN('123456789012'), protocolFeesMintA: new BN(11), protocolFeesMintB: new BN(12),
    fundFeesMintA: new BN(21), fundFeesMintB: new BN(22), openTime: new BN(1700000000), epoch: new BN(7),
    feeOn: 2, enableCreatorFee: true, creatorFeesMintA: new BN(31), creatorFeesMintB: new BN(32),
  } as any
  const buf = Buffer.alloc(CpmmPoolInfoLayout.span)
  CpmmPoolInfoLayout.encode({ ...fields, '': [], ...{} } as any, buf)
  disc('PoolState').copy(buf, 0)
  const p = decodeCpmmPool(key(), buf)
  assert.equal(buf.length, 637)
  assert.ok(p.config.equals(fields.configId) && p.vaultA.equals(fields.vaultA) && p.vaultB.equals(fields.vaultB))
  assert.ok(p.mintA.equals(fields.mintA) && p.mintB.equals(fields.mintB) && p.lpMint.equals(fields.mintLp))
  assert.ok(p.programA.equals(fields.mintProgramA) && p.programB.equals(fields.mintProgramB) && p.observation.equals(fields.observationId))
  assert.deepEqual([p.status, p.decimalsA, p.decimalsB, p.creatorFeeOn, p.enableCreatorFee], [4, 6, 9, 2, true])
  assert.equal(p.lpSupply, 123456789012n)
  assert.equal(p.heldFeesA, 11n + 21n + 31n)
  assert.equal(p.heldFeesB, 12n + 22n + 32n)
  assert.equal(p.openTime, 1700000000n)

  const cfgBuf = Buffer.alloc(CpmmConfigInfoLayout.span)
  CpmmConfigInfoLayout.encode({
    bump: 1, disableCreatePool: false, index: 3, tradeFeeRate: new BN(2500), protocolFeeRate: new BN(120000),
    fundFeeRate: new BN(40000), createPoolFee: new BN(150000000), protocolOwner: key(), fundOwner: key(),
    creatorFeeRate: new BN(500), creatorFeeShareRate: new BN(0),
  } as any, cfgBuf)
  disc('AmmConfig').copy(cfgBuf, 0)
  const c = decodeCpmmConfig(key(), cfgBuf)
  assert.equal(cfgBuf.length, 236)
  assert.deepEqual([c.index, c.tradeFeeRate, c.protocolFeeRate, c.fundFeeRate, c.creatorFeeRate], [3, 2500n, 120000n, 40000n, 500n])
})

test('swap quotes match Raydium SDK CurveCalculator exactly', () => {
  const rates = [100n, 2500n, 10000n, 40000n]
  let n = 0
  for (const tradeFeeRate of rates) for (const creatorFeeRate of [0n, 500n, 10000n]) for (const creatorFeeOn of [0, 1, 2]) for (const aToB of [true, false]) {
    for (let i = 0; i < 40; i++) {
      const rIn = 1n + rand(10n ** 15n), rOut = 1n + rand(10n ** 15n), amt = 1n + rand(i % 2 ? 10n ** 6n : 10n ** 14n)
      const enableCreatorFee = creatorFeeRate > 0n
      const ours = cpmmSwapOut(amt, rIn, rOut, { tradeFeeRate, creatorFeeRate }, { enableCreatorFee, creatorFeeOn }, aToB)
      // How the program decides the creator fee side (same rule as our keeper's quote).
      const onInput = creatorFeeOn === 0 || (creatorFeeOn === 1) === aToB
      const theirs = CurveCalculator.swapBaseInput(new BN(amt.toString()), new BN(rIn.toString()), new BN(rOut.toString()),
        new BN(tradeFeeRate.toString()), new BN(creatorFeeRate.toString()), new BN(0), new BN(0), onInput)
      const t = BigInt(theirs.outputAmount.toString())
      assert.equal(ours, t < 0n ? 0n : t, `amt ${amt} rIn ${rIn} rOut ${rOut} fee ${tradeFeeRate}/${creatorFeeRate} on ${creatorFeeOn} aToB ${aToB}`)
      n++
    }
  }
  assert.ok(n > 1000)
})

test('platform fee: 0.1%, rounded up, never more than the input', () => {
  assert.deepEqual(platformFee(1_000_000n), { fee: 1000n, net: 999_000n })
  assert.deepEqual(platformFee(1_000_001n), { fee: 1001n, net: 999_000n })
  assert.deepEqual(platformFee(1n), { fee: 1n, net: 0n })
  assert.deepEqual(platformFee(0n), { fee: 0n, net: 0n })
  assert.deepEqual(platformFee(5000n, 0), { fee: 0n, net: 5000n })
})

test('swap instruction has the account order of Raydium SDK makeSwapCpmmBaseInInstruction', async () => {
  const { makeSwapCpmmBaseInInstruction } = await import('@raydium-io/raydium-sdk-v2')
  const pool = {
    address: key(), config: key(), vaultA: key(), vaultB: key(), lpMint: key(), mintA: key(), mintB: key(),
    programA: key(), programB: key(), observation: key(),
  } as any
  const payer = key(), userIn = key(), userOut = key()
  for (const aToB of [true, false]) {
    const ours = cpmmSwapInstruction({ pool, payer, aToB, userIn, userOut, amountIn: 777n, minOut: 555n })
    const [vIn, vOut, pIn, pOut, mIn, mOut] = aToB
      ? [pool.vaultA, pool.vaultB, pool.programA, pool.programB, pool.mintA, pool.mintB]
      : [pool.vaultB, pool.vaultA, pool.programB, pool.programA, pool.mintB, pool.mintA]
    const theirs = makeSwapCpmmBaseInInstruction(ours.programId, payer, RAYDIUM_CPMM_AUTHORITY, pool.config, pool.address,
      userIn, userOut, vIn, vOut, pIn, pOut, mIn, mOut, pool.observation, new BN(777), new BN(555))
    assert.deepEqual(ours.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), theirs.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]))
    assert.ok(ours.data.equals(theirs.data))
    assert.ok(ours.programId.equals(theirs.programId))
  }
})

test('pool addresses match Raydium SDK PDAs', async () => {
  const { getCpmmPdaPoolId, getPdaLpMint, getPdaVault, getPdaObservationId } = await import('@raydium-io/raydium-sdk-v2')
  const { cpmmPoolAddresses, RAYDIUM_CPMM_ID } = await import('../sdk/src/raydium.ts')
  for (let i = 0; i < 5; i++) {
    const cfg = key(), x = key(), y = key()
    const a = cpmmPoolAddresses(cfg, x, y)
    assert.ok(Buffer.compare(a.mint0.toBuffer(), a.mint1.toBuffer()) < 0)
    assert.ok(a.pool.equals(getCpmmPdaPoolId(RAYDIUM_CPMM_ID, cfg, a.mint0, a.mint1).publicKey))
    assert.ok(a.lpMint.equals(getPdaLpMint(RAYDIUM_CPMM_ID, a.pool).publicKey))
    assert.ok(a.vault0.equals(getPdaVault(RAYDIUM_CPMM_ID, a.pool, a.mint0).publicKey))
    assert.ok(a.vault1.equals(getPdaVault(RAYDIUM_CPMM_ID, a.pool, a.mint1).publicKey))
    assert.ok(a.observation.equals(getPdaObservationId(RAYDIUM_CPMM_ID, a.pool).publicKey))
  }
})

test('create, deposit and withdraw instructions match Raydium SDK', async () => {
  const sdk = await import('@raydium-io/raydium-sdk-v2')
  const r = await import('../sdk/src/raydium.ts')
  const keysOf = (ix: any) => ix.keys.map((k: any) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])
  const cfg = key(), creator = key(), u0 = key(), u1 = key(), uLp = key(), p0 = key(), p1 = key()
  const a = r.cpmmPoolAddresses(cfg, key(), key())
  const ours = r.cpmmInitializeInstruction({ creator, config: cfg, mint0: a.mint0, mint1: a.mint1, program0: p0, program1: p1, user0: u0, user1: u1, userLp: uLp, amount0: 11n, amount1: 22n, openTime: 33n })
  const theirs = sdk.makeCreateCpmmPoolInInstruction(r.RAYDIUM_CPMM_ID, creator, cfg, r.RAYDIUM_CPMM_AUTHORITY, a.pool, a.mint0, a.mint1, a.lpMint, u0, u1, uLp, a.vault0, a.vault1, r.RAYDIUM_CPMM_CREATE_FEE_RECEIVER, p0, p1, a.observation, new BN(11), new BN(22), new BN(33))
  // Raydium's SDK leaves the creator read-only and relies on it being the fee payer;
  // the program takes the creator as `mut` (it pays rent and the creation fee), so we mark it writable.
  const k = keysOf(theirs); k[0][2] = true
  assert.deepEqual(keysOf(ours), k)
  assert.ok(ours.data.equals(theirs.data))

  const pool = { address: a.pool, vaultA: a.vault0, vaultB: a.vault1, mintA: a.mint0, mintB: a.mint1, lpMint: a.lpMint } as any
  const owner = key()
  const dOurs = r.cpmmDepositInstruction({ pool, owner, userLp: uLp, user0: u0, user1: u1, lp: 5n, max0: 6n, max1: 7n })
  const dTheirs = sdk.makeDepositCpmmInInstruction(r.RAYDIUM_CPMM_ID, owner, r.RAYDIUM_CPMM_AUTHORITY, a.pool, uLp, u0, u1, a.vault0, a.vault1, a.mint0, a.mint1, a.lpMint, new BN(5), new BN(6), new BN(7))
  assert.deepEqual(keysOf(dOurs), keysOf(dTheirs))
  assert.ok(dOurs.data.equals(dTheirs.data))
  const wOurs = r.cpmmWithdrawInstruction({ pool, owner, userLp: uLp, user0: u0, user1: u1, lp: 5n, min0: 6n, min1: 7n })
  const wTheirs = sdk.makeWithdrawCpmmInInstruction(r.RAYDIUM_CPMM_ID, owner, r.RAYDIUM_CPMM_AUTHORITY, a.pool, uLp, u0, u1, a.vault0, a.vault1, a.mint0, a.mint1, a.lpMint, new BN(5), new BN(6), new BN(7))
  assert.deepEqual(keysOf(wOurs), keysOf(wTheirs))
  assert.ok(wOurs.data.equals(wTheirs.data))
})

test('LP <-> token math matches Raydium SDK in both rounding directions', async () => {
  const { RoundDirection } = await import('@raydium-io/raydium-sdk-v2')
  const { ConstantProductCurve } = await import('@raydium-io/raydium-sdk-v2') as any
  const { cpmmLpToTokens } = await import('../sdk/src/raydium.ts')
  for (let i = 0; i < 500; i++) {
    const supply = 1n + rand(10n ** 15n), r0 = 1n + rand(10n ** 15n), r1 = 1n + rand(10n ** 15n), lp = rand(supply)
    for (const up of [true, false]) {
      const ours = cpmmLpToTokens(lp, supply, r0, r1, up)
      const t = ConstantProductCurve.lpTokensToTradingTokens(new BN(lp.toString()), new BN(supply.toString()), new BN(r0.toString()), new BN(r1.toString()), up ? RoundDirection.Ceiling : RoundDirection.Floor)
      assert.deepEqual([ours.amount0, ours.amount1], [BigInt(t.tokenAmount0.toString()), BigInt(t.tokenAmount1.toString())])
    }
  }
})
