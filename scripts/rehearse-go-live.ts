// Rehearses tonight's go-live on a local chain, with the launchpad binary that is
// live on Acrux right now, using the same scripts we'll run for real.
// Driven by scripts/rehearse-go-live.sh:
//   phase 1 (the LIVE v1 program): init like Acrux's config, launch an "old" coin, trade it.
//   [the .sh extends the program account and upgrades it in place]
//   phase 2 (the upgrade): the old coin still reads and trades; the site detects the
//   upgrade by size; set_quote, pause/unpause and tiers through the real admin scripts;
//   $HUB launches with its metadata, a holder trades at a discount, $HUB graduates to
//   a real Raydium pool, and hub-buyback.ts buys back + burns and adds locked liquidity.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import * as anchor from '@coral-xyz/anchor'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, createWrappedNativeAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import liveV1 from '../web/src/idl-launchpad-live-v1.json' with { type: 'json' }
import {
  launchpadProgram, launchConfig, launchAddress, curveBuy, stateOf, graduateRaydiumAccounts, LAUNCHPAD_ID, BN,
  holderStatus, discountedFeeBps, decodeCpmmPool,
} from '../sdk/src/index.ts'
import { providerFor, devWallet, fund, newUser, newMint, giveTokens, balance, waitForChain } from '../tests/helpers.ts'

const RPC = 'http://127.0.0.1:8899'
const phase = process.argv[2]
const STATE = '.tmp/rehearsal.json'
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const programData = PublicKey.findProgramAddressSync([LAUNCHPAD_ID.toBytes()], LOADER)[0]
const AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2') // Raydium 0.25% tier, cloned
const HUB_URI = 'https://xbj4dqltluuvxcew.public.blob.vercel-storage.com/metadata/0d4e01cf3e0d0e7834529086d5694d673ef244588b7edfc7cd77dac8f1e90631.json'
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/local-treasury.json', 'utf8'))))
const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })
const ok = (m: string) => console.log(`  ✔ ${m}`)

const conn = await waitForChain(RPC)
const script = (file: string, args: string[], key = 'keys/dev-wallet.json') =>
  execFileSync(process.execPath, ['--import', 'tsx', `scripts/${file}`, ...args], { env: { ...process.env, RPC, KEY: key }, encoding: 'utf8' })

if (phase === '1') {
  console.log('Phase 1: the live v1 launchpad')
  await fund(conn, devWallet.publicKey, 100)
  const v1 = new anchor.Program(liveV1 as anchor.Idl, providerFor(conn, devWallet))
  // The same curve Acrux runs today, read from Acrux; fees go to a local stand-in treasury.
  const live = new anchor.Program(liveV1 as anchor.Idl, new anchor.AnchorProvider(new Connection('https://rpc.acrux.computer'), new anchor.Wallet(Keypair.generate()), {}))
  const real: any = live.coder.accounts.decode('config', (await live.provider.connection.getAccountInfo(launchConfig()))!.data)
  const axb = await newMint(conn, devWallet, (await getMint(live.provider.connection, real.quoteMint)).decimals) // stands in for AXB
  const params = { ...real.params, feeRecipient: treasury.publicKey }
  await v1.methods.initialize(params).accountsPartial({ admin: devWallet.publicKey, quoteMint: axb, program: LAUNCHPAD_ID, programData }).rpc()
  ok(`initialized v1 with Acrux's params (fee ${params.feeBps / 100}%, graduates at ${params.graduationQuote.toString()} raw)`)

  const mint = Keypair.generate()
  await v1.methods.createLaunch('Old Coin', 'OLD', 'https://example.invalid/old.json')
    .accountsPartial({ creator: devWallet.publicKey, config: launchConfig(), mint: mint.publicKey, quoteMint: axb }).signers([mint]).rpc()
  const key = launchAddress(mint.publicKey)
  const l: any = await v1.account.launch.fetch(key)
  const buyerQuote = await giveTokens(conn, devWallet, axb, devWallet.publicKey, 1_000_000_000_000n)
  const feeAta = (await getOrCreateAssociatedTokenAccount(conn, devWallet, axb, treasury.publicKey)).address
  const amt = BigInt(l.graduationQuote.toString()) / 20n
  await v1.methods.buy(new BN(amt.toString()), new BN(1)).accountsPartial({
    user: devWallet.publicKey, launch: key, mint: mint.publicKey, quoteMint: axb, curveTokens: l.curveTokens, curveQuote: l.curveQuote,
    userTokens: getAssociatedTokenAddressSync(mint.publicKey, devWallet.publicKey), userQuote: buyerQuote, feeQuote: feeAta,
  }).rpc()
  ok('v1: launched OLD and bought it')
  writeFileSync(STATE, JSON.stringify({ axb: axb.toBase58(), old: mint.publicKey.toBase58() }))
} else if (phase === '2') {
  console.log('Phase 2: after the in-place upgrade')
  const st = JSON.parse(readFileSync(STATE, 'utf8'))
  const axb = new PublicKey(st.axb), oldMint = new PublicKey(st.old)
  const lp = launchpadProgram(providerFor(conn, devWallet))

  // The site's detection (web/src/launchpad.ts) now sees the upgraded build.
  const space = (await conn.getAccountInfo(programData))!.data.length
  const { UPGRADED_BYTES } = { UPGRADED_BYTES: 633_168 }
  assert.ok(space - 45 >= UPGRADED_BYTES, `program data ${space - 45} >= ${UPGRADED_BYTES}`)
  ok(`site detects the upgrade (program data ${space - 45} bytes)`)

  // Old state survives: config and the v1 coin decode with the new IDL and still trade.
  const cfg: any = await lp.account.config.fetch(launchConfig())
  assert.ok(cfg.quoteMint.equals(axb))
  const oldKey = launchAddress(oldMint)
  const ol: any = await lp.account.launch.fetch(oldKey)
  const feeAxb = getAssociatedTokenAddressSync(axb, treasury.publicKey)
  const q0 = curveBuy(stateOf(ol), BigInt(ol.graduationQuote.toString()) / 20n)!
  await lp.methods.buy(new BN((BigInt(ol.graduationQuote.toString()) / 20n).toString()), new BN(q0.tokensOut.toString())).accountsPartial({
    user: devWallet.publicKey, launch: oldKey, mint: oldMint, quoteMint: axb, curveTokens: ol.curveTokens, curveQuote: ol.curveQuote,
    userTokens: getAssociatedTokenAddressSync(oldMint, devWallet.publicKey), userQuote: getAssociatedTokenAddressSync(axb, devWallet.publicKey),
    feeQuote: feeAxb, holderTokens: null,
  }).rpc()
  ok('the v1 coin still decodes and trades after the upgrade')

  // The real scripts: switch the quote to wrapped ACRUX (the native mint here), pause, unpause.
  console.log(script('acrux-launchpad-set-quote.ts', [NATIVE_MINT.toBase58(), '--yes']).trim().split('\n').map(x => '    ' + x).join('\n'))
  assert.ok(((await lp.account.config.fetch(launchConfig())) as any).quoteMint.equals(NATIVE_MINT))
  ok('set_quote via scripts/acrux-launchpad-set-quote.ts')
  script('acrux-launchpad-admin.ts', ['pause', '--yes'])
  script('acrux-launchpad-admin.ts', ['unpause', '--yes'])
  ok('pause + unpause via scripts/acrux-launchpad-admin.ts')

  // $HUB launches first, with its prepared metadata, in the new quote.
  const hub = Keypair.generate()
  const creator = await newUser(conn, 50)
  await launchpadProgram(providerFor(conn, creator)).methods.createLaunch('AcruxHub', 'HUB', HUB_URI)
    .accountsPartial({ creator: creator.publicKey, config: launchConfig(), mint: hub.publicKey, quoteMint: NATIVE_MINT, quotePair: null })
    .signers([hub]).rpc()
  const hubKey = launchAddress(hub.publicKey)
  let hl: any = await lp.account.launch.fetch(hubKey)
  assert.equal(hl.uri, HUB_URI)
  ok('$HUB launched in wrapped ACRUX with its metadata')

  // A buyer gets HUB; tiers go on through the real admin script.
  const feeNative = (await getOrCreateAssociatedTokenAccount(conn, devWallet, NATIVE_MINT, treasury.publicKey, true)).address
  const whale = await newUser(conn, 200)
  const whaleQuote = await createWrappedNativeAccount(conn, whale, whale.publicKey, 150_000_000_000)
  const hubTrade = (u: Keypair, uq: PublicKey, holderTokens: PublicKey | null) => ({
    user: u.publicKey, launch: hubKey, mint: hub.publicKey, quoteMint: NATIVE_MINT, curveTokens: hl.curveTokens, curveQuote: hl.curveQuote,
    userTokens: getAssociatedTokenAddressSync(hub.publicKey, u.publicKey), userQuote: uq, feeQuote: feeNative, holderTokens,
  })
  const firstBuy = BigInt(hl.graduationQuote.toString()) / 4n
  await launchpadProgram(providerFor(conn, whale)).methods.buy(new BN(firstBuy.toString()), new BN(1)).accountsPartial(hubTrade(whale, whaleQuote, null)).rpc()
  const whaleHub = await balance(conn, getAssociatedTokenAddressSync(hub.publicKey, whale.publicKey))
  console.log(script('acrux-launchpad-admin.ts', ['tiers', hub.publicKey.toBase58(), '--tiers', '1000000:25,5000000:50,10000000:75', '--yes']).trim().split('\n').map(x => '    ' + x).join('\n'))
  const hs = await holderStatus(conn, lp, whale.publicKey)
  assert.ok(hs.discountBps > 0, 'whale qualifies for a tier')
  ok(`tiers set via the admin script; a holder of ${(Number(whaleHub) / 1e6).toLocaleString()} HUB gets ${hs.discountBps / 100}% off`)

  // That holder pays the discounted fee, on chain, finishing the curve.
  hl = await lp.account.launch.fetch(hubKey)
  const s = stateOf(hl)
  const big = curveBuy({ ...s, feeBps: discountedFeeBps(s.feeBps, hs.discountBps) }, 100_000_000_000n)!
  assert.ok(big.completes)
  const feeBefore = await balance(conn, feeNative)
  await launchpadProgram(providerFor(conn, whale)).methods.buy(new BN('100000000000'), new BN(big.tokensOut.toString()))
    .accountsPartial(hubTrade(whale, whaleQuote, hs.account)).rpc()
  assert.equal((await balance(conn, feeNative)) - feeBefore, big.fee)
  ok(`discounted fee charged on chain (${big.fee} vs ${curveBuy(s, 100_000_000_000n)!.fee} at full price); curve complete`)

  // $HUB graduates into a real Raydium pool.
  hl = await lp.account.launch.fetch(hubKey)
  const g = graduateRaydiumAccounts(hl, NATIVE_MINT, AMM_CONFIG)
  const cranker = await newUser(conn, 20)
  await launchpadProgram(providerFor(conn, cranker)).methods.graduateRaydium().accountsPartial({ payer: cranker.publicKey, ...g }).preInstructions([cu]).rpc()
  assert.equal(((await lp.account.launch.fetch(hubKey)) as any).graduated, true)
  ok('$HUB graduated into a Raydium CPMM pool (LP burned)')

  // Fees to holders: the treasury buys back + burns HUB and adds locked liquidity.
  await fund(conn, treasury.publicKey, 5)
  const supplyBefore = (await getMint(conn, hub.publicKey)).supply
  const pool = decodeCpmmPool(g.poolState, (await conn.getAccountInfo(g.poolState))!.data as Buffer)
  const lpBefore = pool.lpSupply
  const dry = script('hub-buyback.ts', [hub.publicKey.toBase58(), NATIVE_MINT.toBase58()], 'keys/local-treasury.json')
  console.log(dry.trim().split('\n').map(x => '    ' + x).join('\n'))
  const run = script('hub-buyback.ts', [hub.publicKey.toBase58(), NATIVE_MINT.toBase58(), '--yes'], 'keys/local-treasury.json')
  console.log(run.trim().split('\n').map(x => '    ' + x).join('\n'))
  const supplyAfter = (await getMint(conn, hub.publicKey)).supply
  const poolAfter = decodeCpmmPool(g.poolState, (await conn.getAccountInfo(g.poolState))!.data as Buffer)
  assert.ok(supplyAfter < supplyBefore, 'bought-back HUB was burned')
  assert.ok(poolAfter.lpSupply > lpBefore, 'liquidity was added')
  assert.equal(await balance(conn, getAssociatedTokenAddressSync(pool.lpMint, treasury.publicKey)), 0n, 'the treasury kept no LP (burned)')
  ok(`buyback burned ${(Number(supplyBefore - supplyAfter) / 1e6).toLocaleString()} HUB; pool LP grew ${lpBefore} -> ${poolAfter.lpSupply}, treasury LP burned`)
  console.log('\nRehearsal passed.')
} else {
  throw new Error('phase 1 or 2')
}
