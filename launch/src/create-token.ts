// Step 1: create the token, in ONE transaction:
//   - the mint, with on-chain Metaplex metadata (name, symbol, link to image + details)
//   - the whole fixed supply minted to the launcher
//   - mint and freeze authority revoked, so nobody can mint more or freeze holders
// On `local` it also creates a stand-in ACRUX.
//
//   NETWORK=local node --import tsx launch/src/create-token.ts "Name" TICKER 1000000000 \
//     --image logo.png --description "What it is" --x @handle --telegram group --website https://site
//
// The image and details are uploaded through acruxhub.com/api/upload (content-addressed
// storage), or pass --uri <metadata json url> to use your own. Metadata is IMMUTABLE by
// default (holders can trust it won't change); pass --mutable to keep an update authority.
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { Transaction, Keypair, sendAndConfirmTransaction, SystemProgram } from '@solana/web3.js'
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, AuthorityType, createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMint,
  createMint, mintTo, getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token'
import { NETWORK, conn, wallet, loadState, saveState, requireYes, ACRUX_MAINNET } from './common.ts'
import { createMetadataIx, readMetadata, LIMITS } from './metadata.ts'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--yes' && args[i - 1] !== '--mutable'))
const [name = 'Test Token', symbol = 'TEST', supplyWhole = '1000000000'] = positional
const DECIMALS = 6
const supply = BigInt(supplyWhole) * 10n ** BigInt(DECIMALS)
const isMutable = args.includes('--mutable')
const UPLOAD_API = process.env.UPLOAD_API ?? 'https://acruxhub.com/api/upload'

if (Buffer.byteLength(name) > LIMITS.name) throw new Error(`name must be at most ${LIMITS.name} bytes`)
if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error('ticker: 1-10 capital letters or digits')

const launcher = wallet('launcher')
if (NETWORK === 'local') {
  const bal = await conn.getBalance(launcher.publicKey)
  if (bal < 20e9) await conn.confirmTransaction(await conn.requestAirdrop(launcher.publicKey, 50e9), 'confirmed')
}

// Metadata URI: given, or uploaded (image + details) through AcruxHub's storage.
let uri = flag('uri') ?? ''
if (!uri) {
  const imagePath = flag('image')
  if (!imagePath) throw new Error('pass --image <file> (PNG/JPG/GIF/WebP, max 1 MB) or --uri <metadata json url>')
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[extname(imagePath).toLowerCase()]
  if (!type) throw new Error('image must be .png, .jpg, .gif or .webp')
  const image = `data:${type};base64,${readFileSync(imagePath).toString('base64')}`
  const res = await fetch(UPLOAD_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, symbol, description: flag('description') ?? '', image, x: flag('x') ?? '', telegram: flag('telegram') ?? '', website: flag('website') ?? '' }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`upload failed: ${body.error ?? res.status}`)
  uri = body.uri
  console.log('uploaded image + details:', uri)
}
if (Buffer.byteLength(uri) > LIMITS.uri) throw new Error(`metadata uri over ${LIMITS.uri} bytes`)

requireYes([
  `Create ${name} ($${symbol}), supply ${supplyWhole}, ${DECIMALS} decimals, minted to ${launcher.publicKey.toBase58()}.`,
  `Metadata: ${uri} (${isMutable ? 'MUTABLE: launcher can change it' : 'immutable'}).`,
  'Then revoke mint + freeze authority in the same transaction.',
].join('\n'))

const mint = Keypair.generate()
const ata = getAssociatedTokenAddressSync(mint.publicKey, launcher.publicKey)
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: launcher.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE,
    lamports: await getMinimumBalanceForRentExemptMint(conn), programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMint2Instruction(mint.publicKey, DECIMALS, launcher.publicKey, launcher.publicKey),
  // Metadata needs the mint authority's signature, so it goes in before the revoke.
  createMetadataIx({ mint: mint.publicKey, mintAuthority: launcher.publicKey, payer: launcher.publicKey, updateAuthority: launcher.publicKey, name, symbol, uri, isMutable }),
  createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, ata, launcher.publicKey, mint.publicKey),
  createMintToInstruction(mint.publicKey, ata, launcher.publicKey, supply),
  createSetAuthorityInstruction(mint.publicKey, launcher.publicKey, AuthorityType.MintTokens, null),
  createSetAuthorityInstruction(mint.publicKey, launcher.publicKey, AuthorityType.FreezeAccount, null),
)
const sig = await sendAndConfirmTransaction(conn, tx, [launcher, mint], { commitment: 'confirmed' })

// Verify everything on chain before recording it.
const info = await getMint(conn, mint.publicKey)
if (info.mintAuthority !== null || info.freezeAuthority !== null || info.supply !== supply) throw new Error('mint not as expected')
const meta = await readMetadata(conn, mint.publicKey)
if (!meta || meta.name !== name || meta.symbol !== symbol || meta.uri !== uri || meta.isMutable !== isMutable) throw new Error(`metadata not as expected: ${JSON.stringify(meta)}`)
console.log(`token ${symbol} ${mint.publicKey.toBase58()} supply ${supplyWhole}, mint+freeze revoked, metadata ${meta.isMutable ? 'mutable' : 'immutable'} | ${sig}`)

const state = loadState()
state.token = { mint: mint.publicKey.toBase58(), decimals: DECIMALS, supply: supply.toString(), name, symbol }
state.token.uri = uri

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
