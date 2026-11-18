// A bridge guardian: watches one chain's Outbound records and approves (then
// executes) the matching payload on the other chain. Run one process per guardian
// key, on separate machines, with separate RPC providers.

import { Connection, Keypair, PublicKey, type Commitment } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import * as anchor from '@coral-xyz/anchor'
import {
  bridgeProgram, bridgeConfig, bridgeRoute, bridgeCustody, approvalAddress, consumedAddress, payloadArg, allAccounts,
  type Payload,
} from '../../sdk/src/programs.ts'

export type Side = { conn: Connection; chainId: number }
export type Log = (msg: string) => void

const provider = (conn: Connection, kp: Keypair) => new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' })

async function exists(conn: Connection, key: PublicKey) {
  return (await conn.getAccountInfo(key, 'confirmed')) !== null
}

/**
 * One pass from `src` to `dst`: approve every unconsumed transfer this guardian
 * has not approved yet, and execute any that have reached the threshold.
 * `srcCommitment` should be 'finalized' in production so a reorged send is never approved.
 */
export async function relayOnce(src: Side, dst: Side, guardian: Keypair, log: Log = () => {}, srcCommitment: Commitment = 'finalized') {
  const srcBridge = bridgeProgram(provider(src.conn, guardian))
  const dstBridge = bridgeProgram(provider(dst.conn, guardian))
  const srcConfig = await srcBridge.account.config.fetch(bridgeConfig(), srcCommitment)
  if (srcConfig.chainId !== src.chainId) throw new Error(`source chain id mismatch: ${srcConfig.chainId} != ${src.chainId}`)
  const dstConfig = await dstBridge.account.config.fetch(bridgeConfig())
  if (dstConfig.chainId !== dst.chainId) throw new Error(`dest chain id mismatch: ${dstConfig.chainId} != ${dst.chainId}`)
  const index = dstConfig.guardians.findIndex(g => g.equals(guardian.publicKey))
  if (index < 0) throw new Error(`${guardian.publicKey.toBase58()} is not a guardian on chain ${dst.chainId}`)
  if (dstConfig.paused) {
    log(`chain ${dst.chainId} is paused; skipping`)
    return { approved: 0, executed: 0 }
  }

  // Read the outbound records at the source's safe commitment.
  const srcAtCommitment = bridgeProgram(new anchor.AnchorProvider(src.conn, new anchor.Wallet(guardian), { commitment: srcCommitment }))
  const outbound = await allAccounts<any>(srcAtCommitment, 'Outbound', { commitment: srcCommitment })
  let approved = 0
  let executed = 0

  for (const { account: o } of outbound.sort((a, b) => a.account.nonce.cmp(b.account.nonce))) {
    if (o.destChain !== dst.chainId) continue
    const payload: Payload = {
      sourceChain: o.sourceChain,
      nonce: BigInt(o.nonce.toString()),
      destChain: o.destChain,
      destMint: o.destMint,
      recipient: o.recipient,
      amount: BigInt(o.amount.toString()),
    }
    if (await exists(dst.conn, consumedAddress(payload.sourceChain, payload.nonce))) continue

    const approval = approvalAddress(payload)
    let record = await dstBridge.account.approval.fetchNullable(approval)
    const mine = record && record.guardianSet === dstConfig.guardianSet && (record.signers & (1 << index)) !== 0
    if (!mine) {
      await dstBridge.methods.approve(payloadArg(payload)).accountsPartial({ guardian: guardian.publicKey, approval }).rpc()
      approved++
      log(`approved ${src.chainId}->${dst.chainId} nonce ${payload.nonce} amount ${payload.amount}`)
      record = await dstBridge.account.approval.fetch(approval)
    }

    const count = popcount(record!.signers)
    if (record!.guardianSet === dstConfig.guardianSet && count >= dstConfig.threshold) {
      const route = await dstBridge.account.route.fetch(bridgeRoute(payload.destMint))
      try {
        await dstBridge.methods.execute()
          .accountsPartial({
            payer: guardian.publicKey,
            approval,
            consumed: consumedAddress(payload.sourceChain, payload.nonce),
            route: bridgeRoute(payload.destMint),
            mint: payload.destMint,
            custody: route.native ? bridgeCustody(payload.destMint) : null,
            recipient: payload.recipient,
            recipientTokens: getAssociatedTokenAddressSync(payload.destMint, payload.recipient, true),
          })
          .rpc()
        executed++
        log(`executed ${src.chainId}->${dst.chainId} nonce ${payload.nonce}`)
      } catch (e: any) {
        // Another guardian may have executed first; anything else is worth surfacing.
        if (await exists(dst.conn, consumedAddress(payload.sourceChain, payload.nonce))) continue
        log(`execute failed for nonce ${payload.nonce}: ${e?.error?.errorCode?.code ?? e?.message}`)
      }
    }
  }
  return { approved, executed }
}

const popcount = (n: number) => n.toString(2).split('').filter(c => c === '1').length
