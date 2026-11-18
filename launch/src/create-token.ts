// Step 1: create the token. Fixed supply minted once to the launcher, then the
// mint and freeze authorities are revoked in the same transaction, so nobody can
// ever mint more or freeze holders. On `local` it also creates a stand-in ACRUX.
//
//   NETWORK=local node --import tsx launch/src/create-token.ts "Name" TICKER 1000000000
import { Transaction, Keypair, sendAndConfirmTransaction, SystemProgram } from '@solana/web3.js'
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, AuthorityType, createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMint,
  createMint, mintTo, getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token'
import { NETWORK, conn, wallet, loadState, saveState, requireYes, ACRUX_MAINNET } from './common.ts'

const [name = 'Test Token', symbol = 'TEST', supplyWhole = '1000000000'] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const DECIMALS = 6
const supply = BigInt(supplyWhole) * 10n ** BigInt(DECIMALS)
const launcher = wallet('launcher')

if (NETWORK === 'local') {
  const bal = await conn.getBalance(launcher.publicKey)
  if (bal < 20e9) await conn.confirmTransaction(await conn.requestAirdrop(launcher.publicKey, 50e9), 'confirmed')
}
requireYes(`Create ${name} ($${symbol}), supply ${supplyWhole}, ${DECIMALS} decimals, minted to ${launcher.publicKey.toBase58()}, then revoke mint + freeze authority.`)

const mint = Keypair.generate()
const ata = getAssociatedTokenAddressSync(mint.publicKey, launcher.publicKey)
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: launcher.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE,
    lamports: await getMinimumBalanceForRentExemptMint(conn), programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMint2Instruction(mint.publicKey, DECIMALS, launcher.publicKey, launcher.publicKey),
  createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, ata, launcher.publicKey, mint.publicKey),
  createMintToInstruction(mint.publicKey, ata, launcher.publicKey, supply),
  createSetAuthorityInstruction(mint.publicKey, launcher.publicKey, AuthorityType.MintTokens, null),
  createSetAuthorityInstruction(mint.publicKey, launcher.publicKey, AuthorityType.FreezeAccount, null),
)
const sig = await sendAndConfirmTransaction(conn, tx, [launcher, mint], { commitment: 'confirmed' })
const info = await getMint(conn, mint.publicKey)
if (info.mintAuthority !== null || info.freezeAuthority !== null || info.supply !== supply) throw new Error('mint not as expected')
console.log(`token ${symbol} ${mint.publicKey.toBase58()} supply ${supplyWhole}, mint+freeze revoked | ${sig}`)

const state = loadState()
state.token = { mint: mint.publicKey.toBase58(), decimals: DECIMALS, supply: supply.toString(), name, symbol }

if (NETWORK === 'local') {
  // Stand-in for ACRUX (6 decimals like the real one), given to the launcher and a trader.
  const acrux = await createMint(conn, launcher, launcher.publicKey, null, 6)
  for (const who of [launcher, wallet('trader')]) {
    if (who !== launcher) await conn.confirmTransaction(await conn.requestAirdrop(who.publicKey, 20e9), 'confirmed')
    const a = await getOrCreateAssociatedTokenAccount(conn, launcher, acrux, who.publicKey)
    await mintTo(conn, launcher, acrux, a.address, launcher, 50_000_000n * 10n ** 6n)
  }
  state.quote = { mint: acrux.toBase58(), decimals: 6 }
  console.log('local stand-in ACRUX', acrux.toBase58())
} else {
  state.quote = { mint: ACRUX_MAINNET.toBase58(), decimals: 6 }
}
saveState(state)
