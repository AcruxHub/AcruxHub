import { readFileSync } from 'node:fs'
import * as anchor from '@coral-xyz/anchor'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token'

export const CHAIN_A_RPC = process.env.CHAIN_A_RPC ?? 'http://127.0.0.1:8899'
export const CHAIN_B_RPC = process.env.CHAIN_B_RPC ?? 'http://127.0.0.1:8999'

export const devWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('../keys/dev-wallet.json', import.meta.url), 'utf8'))))

export async function waitForChain(rpc: string, timeoutMs = 90_000) {
  const conn = new Connection(rpc, 'confirmed')
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      await conn.getSlot()
      return conn
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  throw new Error(`chain at ${rpc} not up`)
}

export function providerFor(conn: Connection, kp: Keypair) {
  return new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: 'confirmed' })
}

export async function fund(conn: Connection, to: PublicKey, sol = 10) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  const bh = await conn.getLatestBlockhash()
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
}

export async function newUser(conn: Connection, sol = 10) {
  const kp = Keypair.generate()
  await fund(conn, kp.publicKey, sol)
  return kp
}

export async function newMint(conn: Connection, payer: Keypair, decimals = 6) {
  return createMint(conn, payer, payer.publicKey, null, decimals)
}

export async function giveTokens(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, true)
  await mintTo(conn, payer, mint, ata.address, payer, amount)
  return ata.address
}

export async function balance(conn: Connection, ata: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(conn, ata)).amount
  } catch {
    return 0n
  }
}

/** Asserts a promise rejects with an Anchor error whose name or message contains `needle`. */
export async function expectError(p: Promise<unknown>, needle: string) {
  try {
    await p
  } catch (e: any) {
    const text = `${e?.error?.errorCode?.code ?? ''} ${e?.message ?? ''} ${(e?.logs ?? e?.transactionLogs ?? []).join('\n')}`
    if (!text.includes(needle)) throw new Error(`expected error containing "${needle}", got: ${text.slice(0, 600)}`)
    return
  }
  throw new Error(`expected error containing "${needle}", but it succeeded`)
}

export { sendAndConfirmTransaction, Transaction }
