// POST /api/telegram: the AcruxHub Telegram bot's webhook.
//
// The bot never holds anyone's keys. It looks things up (coins, prices, curve
// progress) and every action button opens AcruxHub as a Telegram Mini App, where
// the user's own wallet signs: its key lives in their phone's Keychain/Keystore
// (Telegram SecureStorage), never on this server.
//
// It is also the community's portal: /start verify (the portal channel's button)
// asks a quick human check and answers with a one-time invite to the group.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (Telegram sends it back in a
// header, so only Telegram can call this), TELEGRAM_BOT_USERNAME, TELEGRAM_GROUP_ID.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { put, head } from '@vercel/blob'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
const BOT = process.env.TELEGRAM_BOT_USERNAME ?? 'AcruxHubAppBot'
const GROUP = process.env.TELEGRAM_GROUP_ID ?? ''
const SITE = 'https://acruxhub.com'
const RPC = 'https://rpc.acrux.computer'
// Our wrapped ACRUX (programs/wacrux): coins are priced in it, shown as ACRUX.
const WRAPPED_ACRUX = '8wkvan326WoFWuQzpezYqjiyR93KZAWJdA9GNqxkMxxT'
// SPL Token's standard wrapped-native mint: ACRUX 1:1 on Acrux from slot 6,480,000.
const NATIVE_ACRUX = 'So11111111111111111111111111111111111111112'
// Pre-switch demo tokens (worth nothing): coins priced in them are left out.
const DEMO = new Set(['28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td', '713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss'])
// Launched by us, never traded, replaced by a later launch.
const HIDDEN = new Set(['99ysnj1KnpG6mpEZa1kjN8JCkjDZifpjWL6r4gUPKYjN'])
const AXB = '28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td'
const LAUNCHPAD = '3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
// AcruxHub's own coin, and the official links the group's keyword replies give out.
const HUB = 'AuVCwgJQRQP1EA655JLDP86uD7r6qEcQZRti4Htp5Uvp'
const LINKS = { x: 'https://x.com/AcruxHub', site: SITE, tg: 'https://t.me/AcruxHubPortal', github: 'https://github.com/AcruxHub/AcruxHub', docs: `${SITE}/#Docs` }
// Launch account discriminator (sdk/src/idl/acruxhub_launchpad.json).
const LAUNCH_DISC = Buffer.from([144, 51, 51, 163, 206, 85, 213, 38])
// Token locks (programs/locker): TokenLock = disc, owner, mint (40), id, amount (u64 at 80), ...
const LOCKER = '12Bt6QsAA2Xh2Zo6fzUoeuYqsstpvPfZSeUbt3mwMBzh'
const LOCK_DISC = Buffer.from([73, 228, 144, 241, 154, 44, 93, 238])

// ---------------------------------------------------------------- Telegram API
async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!j.ok) console.error(`telegram ${method} failed`, j.description)
  return j.result
}
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)

/**
 * An action button. In a private chat it opens the Mini App right there
 * (web_app); groups don't allow web_app buttons, so there it's a t.me link that
 * opens the same Mini App via the bot.
 */
function action(text: string, route: string, privateChat: boolean) {
  return privateChat
    ? { text, web_app: { url: `${SITE}/?r=${encodeURIComponent(route.replace(/\//g, '_'))}` } }
    : { text, url: `https://t.me/${BOT}?startapp=${encodeURIComponent(route.replace(/\//g, '_'))}` }
}

// ---------------------------------------------------------------- chain data
// ACRUX in US dollars: Jupiter's price API, DexScreener as the fallback (same as /api/price).
const ACRUX_SOLANA = '7Evw4uxTxLGGEFEvXLUNYyc1J7PnFk9EYwTUFagARUX'
let usdCache: { at: number; p: number | null } | null = null
async function acruxUsd(): Promise<number | null> {
  if (usdCache && Date.now() - usdCache.at < 60_000) return usdCache.p
  let p: number | null = null
  try {
    const j: any = await (await fetch('https://lite-api.jup.ag/price/v3?ids=' + ACRUX_SOLANA, { signal: AbortSignal.timeout(4000) })).json()
    p = Number(j?.[ACRUX_SOLANA]?.usdPrice) > 0 ? Number(j[ACRUX_SOLANA].usdPrice) : null
  } catch { /* fall back */ }
  if (!p) {
    try {
      const pairs: any[] = await (await fetch('https://api.dexscreener.com/tokens/v1/solana/' + ACRUX_SOLANA, { signal: AbortSignal.timeout(4000) })).json()
      const best = pairs
        .filter(x => x?.baseToken?.address === ACRUX_SOLANA && Number(x?.priceUsd) > 0)
        .sort((a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))[0]
      p = best ? Number(best.priceUsd) : null
    } catch { /* no price */ }
  }
  usdCache = { at: Date.now(), p: p ?? usdCache?.p ?? null }
  return usdCache.p
}
/** Dollars, short: $1.23M, $555.2K, $12.34, $0.000809. */
const usd = (n: number) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K'
  : n >= 1 ? '$' + n.toFixed(2)
  : '$' + n.toPrecision(3))

type Coin = { usdRate?: number | null; mint: string; name: string; symbol: string; uri: string; price: number; mcap: number; fdv: number; progress: number; raised: number; target: number; quote: string; graduated: boolean; complete: boolean }

// Plain JSON-RPC and a hand decoder: Solana's JS libraries don't load in Vercel's
// function runtime (rpc-websockets requires an ESM-only uuid), and this only reads.
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j: any = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes: Uint8Array) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'))
  let out = ''
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}

/** Decodes a Launch account (field order from the IDL). Null if it isn't one. */
function decodeLaunch(d: Buffer) {
  if (d.length < 270 || !d.subarray(0, 8).equals(LAUNCH_DISC)) return null
  const pk = (o: number) => b58(d.subarray(o, o + 32))
  const u64 = (o: number) => d.readBigUInt64LE(o)
  let o = 261
  const str = () => { const n = d.readUInt32LE(o); const v = d.subarray(o + 4, o + 4 + n).toString('utf8'); o += 4 + n; return v }
  return {
    mint: pk(40), curveQuote: pk(104), pool: pk(136),
    virtualQuote: u64(208), virtualTokens: u64(216), realQuote: u64(224), graduationQuote: u64(240),
    complete: d[250] === 1, graduated: d[251] === 1,
    name: str(), symbol: str(), uri: str(),
  }
}

let cache: { at: number; coins: Coin[] } | null = null
/** Test coins (launched against the demo tokens) and retired launches: never shown. */
const hiddenCoins = new Set<string>()
async function coins(): Promise<Coin[]> {
  if (cache && Date.now() - cache.at < 20_000) return cache.coins
  // Acrux's getProgramAccounts ignores filters: read everything and keep the launches.
  const raw = await rpc<any[]>('getProgramAccounts', [LAUNCHPAD, { encoding: 'base64' }])
  const launches = raw.map(r => decodeLaunch(Buffer.from(r.account.data[0], 'base64'))).filter(x => x !== null)
  // Each curve's quote token, from its curve_quote token account (mint at offset 0).
  const many = async (keys: string[]) => (await rpc<any>('getMultipleAccounts', [keys, { encoding: 'base64' }])).value as any[]
  const qMints = (await many(launches.map(l => l.curveQuote))).map(a => (a ? b58(Buffer.from(a.data[0], 'base64').subarray(0, 32)) : AXB))
  const uniq = [...new Set(qMints)]
  const decs = new Map<string, number>()
  ;(await many(uniq)).forEach((a, i) => decs.set(uniq[i], a ? Buffer.from(a.data[0], 'base64')[44] : 6))
  const out: Coin[] = launches.map((l, i) => {
    const qd = decs.get(qMints[i]) ?? 6
    const vq = Number(l.virtualQuote) / 10 ** qd, vt = Number(l.virtualTokens) / 1e6
    const price = vt > 0 ? vq / vt : 0
    const target = Number(l.graduationQuote) / 10 ** qd, raised = Number(l.realQuote) / 10 ** qd
    return {
      mint: l.mint, name: l.name, symbol: l.symbol, uri: l.uri, price, mcap: price * 1e9, fdv: price * 1e9,
      progress: target > 0 ? Math.min(1, raised / target) : 0, raised, target,
      quote: qMints[i] === WRAPPED_ACRUX ? 'ACRUX' : qMints[i] === AXB ? 'AXB' : qMints[i].slice(0, 4),
      graduated: l.graduated, complete: l.complete,
    }
  })
  const real = out.filter((c, i) => !DEMO.has(qMints[i]) && !HIDDEN.has(c.mint))
  out.forEach((c, i) => { if (DEMO.has(qMints[i]) || HIDDEN.has(c.mint)) hiddenCoins.add(c.mint) })
  // Graduated coins trade in their Raydium pool: price them from its vaults.
  const grads = real.filter(c => c.graduated)
  const gi = grads.map(c => launches[out.indexOf(c)].pool)
  const pools = gi.length ? await many(gi) : []
  const vaults: string[] = []
  const meta = pools.map(p => {
    if (!p) return null
    const d = Buffer.from(p.data[0], 'base64')
    if (d.length !== 637) return null
    const a = b58(d.subarray(72, 104)), b = b58(d.subarray(104, 136)), mA = b58(d.subarray(168, 200))
    vaults.push(a, b)
    return { a, b, tokenIsA: mA !== WRAPPED_ACRUX && !DEMO.has(mA), decA: d[331], decB: d[332] }
  })
  const vb = vaults.length ? await many(vaults) : []
  // Graduation burns the unsold tokens, so use each mint's real supply (u64 at offset 36).
  const supplies = grads.length ? (await many(grads.map(c => c.mint))).map(a => (a ? Number(Buffer.from(a.data[0], 'base64').readBigUInt64LE(36)) / 1e6 : 1e9)) : []
  const amt = (acc: any) => (acc ? Number(Buffer.from(acc.data[0], 'base64').readBigUInt64LE(64)) : 0)
  meta.forEach((m, i) => {
    if (!m) return
    const va = amt(vb[vaults.indexOf(m.a)]) / 10 ** m.decA, vbb = amt(vb[vaults.indexOf(m.b)]) / 10 ** m.decB
    const [tok, quote] = m.tokenIsA ? [va, vbb] : [vbb, va]
    if (tok > 0) { grads[i].price = quote / tok; grads[i].mcap = grads[i].fdv = grads[i].price * supplies[i] }
  })
  // Market cap counts only the supply outside token locks (circulating), as CoinGecko and
  // DexScreener do; the whole supply at the same price is the FDV.
  const locked = await lockedByMint().catch(() => new Map<string, number>())
  for (const c of real) {
    const supply = c.price > 0 ? c.fdv / c.price : 0
    const l = Math.min(locked.get(c.mint) ?? 0, supply)
    if (l > 0) c.mcap = c.price * (supply - l)
  }
  const rate = await acruxUsd()
  for (const c of real) c.usdRate = c.quote === 'ACRUX' ? rate : null
  cache = { at: Date.now(), coins: real }
  return real
}

/** Tokens (whole units, 6 decimals) in token locks, per mint. */
async function lockedByMint() {
  const raw = await rpc<any[]>('getProgramAccounts', [LOCKER, { encoding: 'base64' }])
  const out = new Map<string, number>()
  for (const r of raw) {
    const d = Buffer.from(r.account.data[0], 'base64')
    if (d.length < 88 || !d.subarray(0, 8).equals(LOCK_DISC)) continue
    const mint = b58(d.subarray(40, 72))
    out.set(mint, (out.get(mint) ?? 0) + Number(d.readBigUInt64LE(80)) / 1e6)
  }
  return out
}

function fmtPrice(p: number) {
  if (!isFinite(p) || p <= 0) return '0'
  if (p >= 0.001) return p.toPrecision(4)
  const zeros = Math.ceil(-Math.log10(p)) - 1
  const sub = '₀₁₂₃₄₅₆₇₈₉'
  return `0.0${String(zeros).split('').map(d => sub[+d]).join('')}${Math.round(p * 10 ** (zeros + 4)).toString().replace(/0+$/, '')}`
}
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(n > 0 && n < 1 ? 4 : 2))
const bar = (p: number) => '▰'.repeat(Math.round(p * 10)) + '▱'.repeat(10 - Math.round(p * 10))

const BRIDGE_HELP = [
  'Bridge ACRUX from Solana to Acrux right here, 1:1, usually under a minute.',
  '',
  'Your bot wallet has the same address on Solana and Acrux. Send your ACRUX plus about 0.01 SOL to that address on Solana (from Phantom or an exchange), then tap Bridge. Or import your Phantom wallet\'s key and bridge straight from it.',
  '',
  'Going back? Open the bridge and switch to Acrux → Solana: it\'s paid out on Solana, usually in about a minute.',
].join('\n')

/** One-tap buy sizes, in ACRUX. */
const BUY_PRESETS = [1_000, 10_000, 100_000]

function coinCard(c: Coin, privateChat: boolean) {
  const status = c.graduated ? '🎓 Graduated, trading on its pool' : c.complete ? '✅ Curve full, ready to graduate' : `${bar(c.progress)} ${(c.progress * 100).toFixed(1)}%`
  const text = [
    `<b>${esc(c.name)}</b> $${esc(c.symbol)}`,
    `<code>${c.mint}</code>`,
    '',
    c.usdRate ? `Price  ${fmtPrice(c.price)} ${c.quote} (≈ ${usd(c.price * c.usdRate)})` : `Price  ${fmtPrice(c.price)} ${c.quote}`,
    c.usdRate ? `MC     <b>${usd(c.mcap * c.usdRate)}</b> (${compact(c.mcap)} ${c.quote})` : `MC     ${compact(c.mcap)} ${c.quote}`,
    ...(c.fdv > c.mcap * 1.001 ? [c.usdRate ? `FDV    ${usd(c.fdv * c.usdRate)} (incl. locked tokens)` : `FDV    ${compact(c.fdv)} ${c.quote} (incl. locked tokens)`] : []),
    c.graduated ? status : `Curve  ${status}\nRaised ${c.raised.toFixed(2)} / ${c.target} ${c.quote}`,
  ].join('\n')
  // Graduated coins trade on Swap (best pool); coins on the curve trade on their page.
  const trade = (preset: string) => (c.graduated ? `Swap/${c.mint}/${preset}` : `Launch/${c.mint}/${preset}`)
  const buttons = [
    BUY_PRESETS.map(n => action(`🟢 Buy ${compact(n).replace('.00', '')}`, trade(`buy/${n}`), privateChat)),
    [action('🔴 Sell', trade('sell'), privateChat), action('📈 Chart', `Launch/${c.mint}`, privateChat), action('💼 Wallet', 'Wallet', privateChat)],
  ]
  return { text, reply_markup: { inline_keyboard: buttons } }
}

function findCoin(all: Coin[], q: string) {
  const s = q.trim().replace(/^\$/, '')
  return all.find(c => c.mint === s) ?? all.find(c => c.symbol.toLowerCase() === s.toLowerCase())
}

// ---------------------------------------------------------------- wallets
// The Mini App tells us each user's wallet ADDRESS (public; never the key), signed by
// Telegram (initData), so /wallet can show their balances in chat. Stored in Blob under
// an unguessable name derived from the user id with our secret.
const walletPath = (uid: number) => `tg-wallets/${createHmac('sha256', SECRET).update(`wallet:${uid}`).digest('hex').slice(0, 32)}.json`
const isAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)

/** Telegram's Mini App initData check: returns the signed user id, or null. */
function verifyInitData(initData: string): number | null {
  const p = new URLSearchParams(initData)
  const hash = p.get('hash')
  if (!hash) return null
  p.delete('hash')
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n')
  const key = createHmac('sha256', 'WebAppData').update(TOKEN).digest()
  const want = createHmac('sha256', key).update(check).digest('hex')
  if (want.length !== hash.length || !timingSafeEqual(Buffer.from(want), Buffer.from(hash))) return null
  if (Date.now() / 1000 - Number(p.get('auth_date') ?? 0) > 86_400) return null
  try { return Number(JSON.parse(p.get('user') ?? '{}').id) || null } catch { return null }
}

async function linkedWallet(uid: number): Promise<string | null> {
  try {
    const meta = await head(walletPath(uid))
    const j: any = await (await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' })).json()
    return isAddress(j?.address ?? '') ? j.address : null
  } catch { return null }
}

async function link(body: any) {
  const uid = verifyInitData(String(body?.initData ?? ''))
  const address = String(body?.address ?? '')
  if (!uid || !isAddress(address)) return { ok: false }
  if ((await linkedWallet(uid)) === address) return { ok: true }
  await put(walletPath(uid), JSON.stringify({ address }), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 })
  await tg('sendMessage', { chat_id: uid, parse_mode: 'HTML', text: `✅ Wallet linked: <code>${address}</code>\n\nSend /wallet any time to see your balances here. Only the address is saved: your key stays on your phone.` })
  return { ok: true }
}

async function linkEndpoint(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin ?? '')
  if (['capacitor://localhost', 'https://localhost'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  return res.status(200).json(await link(body).catch(e => { console.error('link failed', e); return { ok: false } }))
}

type Bal = { mint: string; label: string; amount: number; value: number | null }
async function balances(address: string): Promise<{ native: number; tokens: Bal[]; total: number; rate: number | null }> {
  const [lamports, accts, all] = await Promise.all([
    rpc<any>('getBalance', [address]).then(r => Number(r?.value ?? r)),
    rpc<any>('getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]).then(r => (r?.value ?? []) as any[]).catch(() => [] as any[]),
    coins().catch(() => [] as Coin[]),
  ])
  const byMint = new Map(all.map(c => [c.mint, c]))
  const sums = new Map<string, number>()
  for (const a of accts) {
    const i = a.account.data.parsed.info
    sums.set(i.mint, (sums.get(i.mint) ?? 0) + Number(i.tokenAmount.uiAmountString ?? i.tokenAmount.uiAmount ?? 0))
  }
  const tokens: Bal[] = [...sums.entries()].filter(([m, v]) => v > 0 && !DEMO.has(m) && !hiddenCoins.has(m)).map(([mint, amount]) => {
    if (mint === WRAPPED_ACRUX || mint === NATIVE_ACRUX) return { mint, label: 'Wrapped ACRUX', amount, value: amount }
    const c = byMint.get(mint)
    return { mint, label: c ? '$' + c.symbol : `${mint.slice(0, 4)}…${mint.slice(-4)}`, amount, value: c && c.quote === 'ACRUX' ? amount * c.price : null }
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  const native = lamports / 1e9
  return { native, tokens, total: native + tokens.reduce((s, t) => s + (t.value ?? 0), 0), rate: await acruxUsd() }
}

async function walletCard(address: string, mine: boolean, privateChat: boolean) {
  const b = await balances(address)
  const n = (v: number) => (v >= 1e6 ? compact(v) : v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 6 : 2 }))
  const lines = [
    `💼 <b>${mine ? 'Your wallet' : 'Wallet'}</b>`,
    `<code>${address}</code>`,
    '',
    b.rate ? `<b>≈ ${usd(b.total * b.rate)}</b> total (${n(b.total)} ACRUX)` : `<b>≈ ${n(b.total)} ACRUX</b> total`,
    '',
    `ACRUX  ${n(b.native)}`,
    ...b.tokens.slice(0, 15).map(t => `${esc(t.label)}  ${n(t.amount)}${t.value != null && t.mint !== WRAPPED_ACRUX && t.mint !== NATIVE_ACRUX ? `  (≈ ${n(t.value)} ACRUX)` : ''}`),
    ...(b.tokens.length > 15 ? [`…and ${b.tokens.length - 15} more`] : []),
  ]
  const kb = mine && privateChat
    ? [
        [action('↑ Send', 'Wallet/send', true), action('↓ Receive', 'Wallet/receive', true), action('⇄ Swap', 'Swap', true)],
        [action('🌉 Bridge from Solana', 'Bridge', true), action('💼 Open wallet', 'Wallet', true)],
        [{ text: '🔄 Refresh', callback_data: 'w:refresh' }],
      ]
    : [[{ text: '🔎 View on AcruxHub', url: `${SITE}/#Explorer/${address}` }]]
  return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
}

/** /wallet, /balance, /send, /receive and the /ca-style keyword commands. undefined = not one of these. */
async function walletCommands(m: any, cmd: string, arg: string, priv: boolean) {
  const chat = m.chat.id
  if (cmd === '/wallet' || cmd === '/balance' || cmd === '/bal') {
    if (arg && isAddress(arg)) return tg('sendMessage', { chat_id: chat, reply_to_message_id: m.message_id, ...(await walletCard(arg, false, priv)) })
    // Your own wallet only in a DM: balances don't belong in a group chat.
    if (!priv) {
      return tg('sendMessage', {
        chat_id: chat, reply_to_message_id: m.message_id,
        text: 'DM me /wallet to see your own balances privately, or send /balance <address> here.',
        reply_markup: { inline_keyboard: [[{ text: '💼 Open in DM', url: `https://t.me/${BOT}?start=wallet` }]] },
      })
    }
    const mine = await linkedWallet(m.from.id)
    if (!mine) {
      return tg('sendMessage', {
        chat_id: chat,
        text: 'Open your wallet once and I\'ll remember its address (only the address: your key never leaves your phone). After that, /wallet shows your balances right here.',
        reply_markup: { inline_keyboard: [[action('💼 Open wallet', 'Wallet', true)]] },
      })
    }
    return tg('sendMessage', { chat_id: chat, ...(await walletCard(mine, true, true)) })
  }
  if (cmd === '/send') return tg('sendMessage', { chat_id: chat, text: 'Send ACRUX or any token from your wallet.', reply_markup: { inline_keyboard: [[action('↑ Send', 'Wallet/send', priv)]] } })
  if (cmd === '/receive' || cmd === '/deposit') {
    const mine = priv ? await linkedWallet(m.from.id) : null
    return tg('sendMessage', {
      chat_id: chat, parse_mode: 'HTML',
      text: mine ? `Your Acrux address (the same for every token):\n<code>${mine}</code>\n\nComing from Solana? Use /bridge.` : 'Open your wallet to see your address.',
      reply_markup: { inline_keyboard: [[action('↓ Receive', 'Wallet/receive', priv)]] },
    })
  }
  if (cmd.startsWith('/') && !['/start', '/coin', '/coins', '/price', '/swap', '/launch', '/bridge', '/help', '/chatid'].includes(cmd)) {
    const k = await keyword(cmd.slice(1), priv)
    if (k) return tg('sendMessage', { chat_id: chat, reply_to_message_id: m.message_id, ...k })
  }
  return undefined
}

async function refreshWallet(q: any) {
  const mine = await linkedWallet(q.from.id)
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: mine ? 'Updated' : 'Open your wallet first' })
  if (mine) return tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, ...(await walletCard(mine, true, true)) })
}

// ---------------------------------------------------------------- keyword replies
// Typing one of these on its own (as in most coin groups) gets the official answer.
async function keyword(word: string, privateChat: boolean): Promise<Record<string, unknown> | null> {
  const w = word.toLowerCase().replace(/^[/!$]/, '').replace(/@\w+$/, '').replace(/[?!.\s]+$/, '').trim()
  const hub = async () => (await coins()).find(x => x.mint === HUB)
  if (['ca', 'contract', 'contract address', 'hub ca', 'token address'].includes(w)) {
    const c = await hub()
    const head = `<b>$HUB contract address</b> (tap to copy)\n<code>${HUB}</code>`
    if (!c) return { parse_mode: 'HTML', text: head }
    const card = coinCard(c, privateChat)
    return { parse_mode: 'HTML', reply_markup: card.reply_markup, text: `${head}\n\n${card.text}` }
  }
  if (['x', 'twitter', 'twiter', 'x account'].includes(w)) return { text: `𝕏 Follow AcruxHub: ${LINKS.x}` }
  if (['web', 'website', 'site', 'app', 'dapp', 'url'].includes(w)) {
    return { text: `🌐 ${LINKS.site}\nLaunch, trade, lock and bridge on Acrux.`, reply_markup: { inline_keyboard: [[action('🚀 Open AcruxHub', 'Launch', privateChat)]] } }
  }
  if (['tg', 'telegram', 'portal'].includes(w)) return { text: `💬 ${LINKS.tg}` }
  if (['bot', 'the bot', 'tg bot', 'telegram bot', 'trading bot', 'how to trade', 'how do i trade', 'how to send', 'how do i send'].includes(w)) {
    return {
      parse_mode: 'HTML',
      text: [
        `🤖 <b>The AcruxHub bot: @${BOT}</b>`,
        '',
        'Your Acrux wallet inside Telegram:',
        '• Bridge ACRUX from Solana',
        '• Buy & sell in one tap',
        '• Send and receive ACRUX, HUB or any Acrux token',
        '• /wallet shows your balances (Acrux tokens don\'t show in Phantom, so check them here)',
        '',
        '🔐 Your key stays on your phone. The bot never sees it.',
      ].join('\n'),
      reply_markup: { inline_keyboard: [[{ text: '🤖 Open the bot', url: `https://t.me/${BOT}?start=go` }]] },
    }
  }
  if (['links', 'socials', 'social', 'official'].includes(w)) {
    return {
      parse_mode: 'HTML', disable_web_page_preview: true,
      text: ['<b>AcruxHub official links</b>', '', `🌐 ${LINKS.site}`, `𝕏 ${LINKS.x}`, `💬 ${LINKS.tg}`, `📖 ${LINKS.docs}`, '', `$HUB CA: <code>${HUB}</code>`].join('\n'),
    }
  }
  if (['chart', 'price', 'mc', 'mcap', 'market cap'].includes(w)) {
    const c = await hub()
    return c ? { parse_mode: 'HTML', ...coinCard(c, privateChat) } : null
  }
  if (['how to buy', 'how do i buy', 'htb'].includes(w)) {
    return {
      parse_mode: 'HTML',
      text: [
        '<b>How to buy $HUB</b>',
        '1. Get ACRUX on Acrux: bridge it from Solana (acruxhub.com, Bridge).',
        '2. Open acruxhub.com, Swap (or tap Buy below).',
        `3. Paste the CA <code>${HUB}</code> and swap ACRUX for $HUB.`,
        '',
        `Or DM me and do it all inside Telegram, bridge included, with a wallet that stays on your phone: @${BOT}`,
      ].join('\n'),
      reply_markup: { inline_keyboard: [[action('🟢 Buy $HUB', `Swap/${HUB}`, privateChat), action('🌉 Bridge', 'Bridge', privateChat)]] },
    }
  }
  if (['how to bridge', 'bridge'].includes(w)) return { text: BRIDGE_HELP, reply_markup: { inline_keyboard: [[action('🌉 Open the bridge', 'Bridge', privateChat)]] } }
  if (['docs', 'whitepaper', 'wp'].includes(w)) return { text: `📖 ${LINKS.docs}` }
  if (['github', 'source code'].includes(w)) return { text: `💻 ${LINKS.github}` }
  if (['locked', 'lock', 'is it locked', 'liquidity'].includes(w)) {
    return { text: `🔒 The dev's $HUB is locked on chain until Nov 2028, and graduation burned all the LP. Check it yourself: ${SITE}/#Locks/${HUB}` }
  }
  return null
}

// ---------------------------------------------------------------- portal check
// Stateless: each button carries whether it's the right answer, signed so it
// can't be forged, plus a timestamp so old challenges expire.
const ICONS = ['⭐', '🚀', '🌙', '💎', '🔥', '🪐', '⚡', '🍀']
const mac = (s: string) => createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 16)

function challenge(uid: number) {
  const ts = Math.floor(Date.now() / 1000)
  const pick = [...ICONS].sort(() => Math.random() - 0.5).slice(0, 4)
  const answer = Math.floor(Math.random() * 4)
  return {
    text: `Welcome to AcruxHub 👋\n\nTap the ${pick[answer]} to prove you're human and get your invite.`,
    reply_markup: { inline_keyboard: [pick.map((icon, i) => {
      const ok = i === answer ? 1 : 0
      return { text: icon, callback_data: `v:${ts}:${i}:${ok}:${mac(`${uid}:${ts}:${i}:${ok}`)}` }
    })] },
  }
}

function checkAnswer(uid: number, data: string): 'ok' | 'wrong' | 'expired' | 'bad' {
  const [, ts, i, ok, m] = data.split(':')
  const want = mac(`${uid}:${ts}:${i}:${ok}`)
  if (!m || m.length !== want.length || !timingSafeEqual(Buffer.from(m), Buffer.from(want))) return 'bad'
  if (Date.now() / 1000 - Number(ts) > 300) return 'expired'
  return ok === '1' ? 'ok' : 'wrong'
}

// ---------------------------------------------------------------- handlers
const HELP = [
  '<b>AcruxHub</b>: launch and trade coins on Acrux.',
  '',
  'Paste any coin address (CA) and I\'ll show it.',
  '/wallet  your balances (send, receive, swap)',
  '/balance &lt;address&gt;  any wallet\'s balances',
  '/coins  top coins on the launchpad',
  '/coin &lt;CA or ticker&gt;  one coin',
  '/launch  launch a coin',
  '/swap  swap any token',
  '/bridge  bring ACRUX over from Solana',
  '/links  official links and the $HUB CA',
  '',
  'Trades open AcruxHub inside Telegram. Your wallet key stays in your phone\'s secure storage: the bot never sees it.',
].join('\n')

async function onMessage(m: any) {
  const chat = m.chat.id
  const priv = m.chat.type === 'private'
  const text: string = (m.text ?? '').trim()
  const [cmdRaw, ...rest] = text.split(/\s+/)
  const cmd = cmdRaw.toLowerCase().replace(new RegExp(`@${BOT.toLowerCase()}$`), '')
  const arg = rest.join(' ')

  if (cmd === '/start') {
    if (arg === 'verify' && priv) return tg('sendMessage', { chat_id: chat, ...challenge(m.from.id) })
    if (arg === 'wallet' && priv) return walletCommands(m, '/wallet', '', true)
    return tg('sendMessage', {
      chat_id: chat, text: HELP, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [action('💼 My wallet', 'Wallet', priv), action('🚀 Coins', 'Launch', priv)],
        // Send/Receive up front: tokens on Acrux don't show in Phantom, so this is where people move them.
        [action('↑ Send', 'Wallet/send', priv), action('↓ Receive', 'Wallet/receive', priv)],
        [action('⇄ Swap', 'Swap', priv), action('🌉 Bridge', 'Bridge', priv)],
        [action('➕ Launch a coin', 'Launch/new', priv), action('🔒 Locks', 'Locks', priv)],
      ] },
    })
  }
  // In a group or channel the bot was added to, /chatid tells the owner its id (for TELEGRAM_GROUP_ID).
  if (cmd === '/chatid' && !priv) return tg('sendMessage', { chat_id: chat, text: `Chat id: ${chat}` })
  if (cmd === '/help') return tg('sendMessage', { chat_id: chat, text: HELP, parse_mode: 'HTML' })
  const extra = await walletCommands(m, cmd, arg, priv)
  if (extra !== undefined) return extra
  if (cmd === '/launch') return tg('sendMessage', { chat_id: chat, text: 'Launch a coin: fixed supply, no presale, liquidity locked forever at graduation.', reply_markup: { inline_keyboard: [[action('➕ Launch a coin', 'Launch/new', priv)]] } })
  if (cmd === '/bridge') return tg('sendMessage', { chat_id: chat, text: BRIDGE_HELP, reply_markup: { inline_keyboard: [[action('🌉 Open the bridge', 'Bridge', priv)]] } })
  if (cmd === '/swap') return tg('sendMessage', { chat_id: chat, text: 'Swap at the best price across AcruxHub and Raydium pools.', reply_markup: { inline_keyboard: [[action('🔁 Swap', arg ? `Swap/${arg}` : 'Swap', priv)]] } })
  if (cmd === '/coins') {
    const all = await coins()
    const live = all.filter(c => !c.graduated && !c.complete).sort((a, b) => b.progress - a.progress).slice(0, 5)
    const grads = all.filter(c => c.graduated).sort((a, b) => b.mcap - a.mcap).slice(0, 5)
    const line = (c: Coin) => `• <b>$${esc(c.symbol)}</b> ${fmtPrice(c.price)} ${c.quote} · MC ${c.usdRate ? usd(c.mcap * c.usdRate) : compact(c.mcap) + ' ' + c.quote}${c.graduated ? '' : ` · ${(c.progress * 100).toFixed(0)}%`}`
    const body = [
      '<b>On the curve</b>', ...(live.length ? live.map(line) : ['none yet']),
      '', '<b>Graduated</b>', ...(grads.length ? grads.map(line) : ['none yet']),
      '', 'Send a ticker or CA for details.',
    ].join('\n')
    return tg('sendMessage', { chat_id: chat, text: body, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[action('🚀 Open AcruxHub', 'Launch', priv)]] } })
  }
  if (cmd === '/coin' || cmd === '/price') {
    const c = arg ? findCoin(await coins(), arg) : undefined
    if (!c) return tg('sendMessage', { chat_id: chat, text: arg ? 'No coin found for that.' : 'Send /coin with a ticker or CA.' })
    return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', ...coinCard(c, priv) })
  }
  // A keyword on its own ("ca", "x", "web", "chart"...): the official answer.
  if (text && text.length <= 24 && !text.startsWith('/')) {
    const k = await keyword(text, priv)
    if (k) return tg('sendMessage', { chat_id: chat, reply_to_message_id: m.message_id, ...k })
  }
  // A pasted address: a coin card if it's one of ours, else (in a DM) that wallet's balances.
  const ca = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/)?.[0]
  if (ca) {
    const c = (await coins()).find(x => x.mint === ca)
    if (c) return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', reply_to_message_id: m.message_id, ...coinCard(c, priv) })
    if (priv && text.trim() === ca) return tg('sendMessage', { chat_id: chat, ...(await walletCard(ca, false, priv)) })
  }
  if (priv && text && !text.startsWith('/')) {
    const c = findCoin(await coins(), text)
    if (c) return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', ...coinCard(c, priv) })
  }
}

async function onCallback(q: any) {
  const data: string = q.data ?? ''
  if (data === 'w:refresh') return refreshWallet(q)
  if (!data.startsWith('v:')) return tg('answerCallbackQuery', { callback_query_id: q.id })
  const r = checkAnswer(q.from.id, data)
  const chat = q.message.chat.id
  if (r === 'ok') {
    if (!GROUP) {
      await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Verified! The community opens soon.' })
      return
    }
    const link = await tg('createChatInviteLink', { chat_id: GROUP, member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 600, name: `verified ${q.from.id}` })
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Verified ✅' })
    return tg('editMessageText', {
      chat_id: chat, message_id: q.message.message_id,
      text: 'Verified ✅ Here\'s your invite. It works once and expires in 10 minutes.',
      reply_markup: link?.invite_link ? { inline_keyboard: [[{ text: '👉 Join AcruxHub', url: link.invite_link }]] } : undefined,
    })
  }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: r === 'expired' ? 'That one expired, try this one.' : 'Not quite, try again.' })
  return tg('editMessageText', { chat_id: chat, message_id: q.message.message_id, ...challenge(q.from.id) })
}

/**
 * One-time setup and status, run from Vercel (some networks can't reach the Bot API):
 * GET /api/telegram?op=setup|status|portal with header x-setup-secret = the webhook secret.
 * setup points the webhook here and sets the command menu and the Mini App menu button.
 */
async function setup(op: string, host: string) {
  if (op === 'status') return { me: await tg('getMe', {}), webhook: await tg('getWebhookInfo', {}) }
  if (op === 'portal') {
    // The portal channel's pinned post: only a bot can put a button on a channel post.
    const sent = await tg('sendPhoto', {
      chat_id: '@AcruxHubPortal',
      photo: 'https://xbj4dqltluuvxcew.public.blob.vercel-storage.com/images/59f6bc5dc5d62d07c5a9daebd0650b81e15c16ea78ee8967cad4e658a1ff5528.png',
      caption: [
        '<b>Welcome to AcruxHub</b>',
        'The launchpad and DEX on Acrux.',
        '',
        'Tap below to verify you\'re human and get your invite to the community.',
        '',
        '🌐 acruxhub.com · 𝕏 @AcruxHub',
        '⚠️ Admins will never DM you first or ask for your keys or seed phrase.',
      ].join('\n'),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '✅ Tap to verify', url: `https://t.me/${BOT}?start=verify` }]] },
    })
    if (sent?.message_id) await tg('pinChatMessage', { chat_id: '@AcruxHubPortal', message_id: sent.message_id, disable_notification: true })
    return { posted: sent?.message_id ?? null }
  }
  if (op === 'setup') {
    // Before switching to the webhook, read the updates queued so far: they include
    // the bot being added to the community group, which gives the group's id.
    const ups: any[] = (await tg('getUpdates', { allowed_updates: ['my_chat_member', 'message'] })) ?? []
    const chats = new Map<number, string>()
    for (const u of ups) {
      const c = u.my_chat_member?.chat ?? u.message?.chat
      if (c && c.type !== 'private') chats.set(c.id, `${c.type} ${c.title}`)
    }
    return {
      chats: Object.fromEntries(chats),
      webhook: await tg('setWebhook', { url: `https://${host}/api/telegram`, secret_token: SECRET, allowed_updates: ['message', 'callback_query', 'my_chat_member'], drop_pending_updates: true }),
      commands: await tg('setMyCommands', { commands: [
        { command: 'wallet', description: 'Your balances: send, receive, swap' },
        { command: 'coins', description: 'Top coins on the launchpad' },
        { command: 'coin', description: 'Look up a coin by ticker or CA' },
        { command: 'launch', description: 'Launch a coin' },
        { command: 'swap', description: 'Swap any token' },
        { command: 'bridge', description: 'Bring ACRUX over from Solana' },
        { command: 'send', description: 'Send ACRUX or any token' },
        { command: 'balance', description: 'Balances of any address' },
        { command: 'ca', description: 'The $HUB contract address' },
        { command: 'links', description: 'Official links' },
        { command: 'help', description: 'What the bot does' },
      ] }),
      menu: await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'AcruxHub', web_app: { url: SITE } } }),
      description: await tg('setMyDescription', { description: 'Launch, trade and bridge coins on Acrux. Trades open AcruxHub right inside Telegram, and your wallet key stays in your phone\'s secure storage: this bot never sees it.' }),
      short: await tg('setMyShortDescription', { short_description: 'Launch, trade and bridge on Acrux. Your keys stay on your phone.' }),
    }
  }
  return { error: 'unknown op' }
}

/** Groups and channels the bot was added to, remembered from my_chat_member updates (logged). */
function logChat(u: any) {
  const c = u.my_chat_member?.chat
  if (c) console.log(`bot membership: ${c.type} "${c.title}" id ${c.id} -> ${u.my_chat_member.new_chat_member?.status}`)
}

// ---------------------------------------------------------------- buy bot
// GET /api/telegram?op=buys posts every new HUB buy in its pool to the group. It is
// safe to call any time (it only posts swaps it hasn't posted before): the site calls
// it right after a swap, and a GitHub Actions cron calls it every few minutes for
// trades made anywhere else. The last pool signature it saw is kept in Blob.
const HUB_POOL = 'CuJgjmm8Nk1muXywivaG4oPzPdgxvsAfEi6gRyHiPkwd'
const HUB_POOL_AUTHORITY = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL'
const FEE_WALLET = '2sxQXf69KQuw4LiBy8QcDzK4r6w7jQDDkbP39Ltcm69X'
const BUYBOT_STATE = 'buybot/hub.json'
type BuyState = { last: string | null; seen: string[] }

async function readBuyState(): Promise<BuyState> {
  try {
    const meta = await head(BUYBOT_STATE)
    const j: any = await (await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' })).json()
    return { last: j?.last ?? null, seen: Array.isArray(j?.seen) ? j.seen : [] }
  } catch { return { last: null, seen: [] } }
}
async function writeBuyState(st: BuyState) {
  await put(BUYBOT_STATE, JSON.stringify(st), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 })
}

/** A swap's effect on the pool's two vaults, from the transaction's token balances. */
async function poolSwap(sig: string) {
  const tx: any = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
  if (!tx || tx.meta?.err) return null
  const delta = (mint: string) => {
    const pick = (xs: any[]) => xs?.find(b => b.owner === HUB_POOL_AUTHORITY && b.mint === mint)
    const pre = pick(tx.meta.preTokenBalances), post = pick(tx.meta.postTokenBalances)
    if (!post) return null
    const d = post.uiTokenAmount.decimals
    const a = BigInt(post.uiTokenAmount.amount), b = BigInt(pre?.uiTokenAmount.amount ?? '0')
    return { change: Number(a - b) / 10 ** d, after: Number(a) / 10 ** d }
  }
  const hub = delta(HUB), acrux = delta(WRAPPED_ACRUX)
  if (!hub || !acrux) return null
  const keys = tx.transaction.message.accountKeys
  const buyer = typeof keys[0] === 'string' ? keys[0] : keys[0].pubkey
  return { sig, buyer, hub, acrux, time: tx.blockTime as number | null }
}

const amount = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x >= 100 ? 0 : 2 })

async function buyCheck() {
  const st = await readBuyState()
  const sigs = await rpc<any[]>('getSignaturesForAddress', [HUB_POOL, st.last ? { limit: 25, until: st.last } : { limit: 1 }])
  if (!sigs.length) return { posted: 0 }
  const newest = sigs[0].signature
  // First run: remember where we are, post nothing (no flood of old buys).
  if (!st.last) { await writeBuyState({ last: newest, seen: [] }); return { posted: 0, started: newest } }
  const fresh = sigs.filter(x => !x.err && !st.seen.includes(x.signature)).reverse()
  // Save first, so a second caller right behind this one doesn't post the same buys.
  await writeBuyState({ last: newest, seen: [...st.seen, ...fresh.map(x => x.signature)].slice(-60) })
  if (!fresh.length) return { posted: 0 }
  const [swaps, c] = await Promise.all([Promise.all(fresh.map(x => poolSwap(x.signature).catch(() => null))), coins().then(cs => cs.find(x => x.mint === HUB)).catch(() => undefined)])
  let posted = 0
  for (const sw of swaps) {
    // A buy takes HUB out of the pool and puts ACRUX in. (Liquidity adds put both in.)
    if (!sw || sw.hub.change >= 0 || sw.acrux.change <= 0) continue
    const got = -sw.hub.change, paid = sw.acrux.change
    const price = sw.hub.after > 0 ? sw.acrux.after / sw.hub.after : 0
    const rate = c?.usdRate ?? null
    const circulating = c && c.price > 0 ? c.mcap / c.price : 0
    const mcap = price * circulating
    const dots = Math.max(1, Math.min(30, Math.ceil(rate ? paid * rate : paid / 4000)))
    const buyback = sw.buyer === FEE_WALLET
    const text = [
      buyback ? '🔥 <b>HUB Buyback!</b> (platform fees)' : '🟢 <b>HUB Buy!</b>',
      (buyback ? '🔥' : '🟢').repeat(dots),
      '',
      `💸 <b>${amount(paid)} ACRUX</b>${rate ? ` (${usd(paid * rate)})` : ''}`,
      `🪙 <b>${amount(got)} HUB</b>`,
      `👤 <a href="${SITE}/#Explorer/${sw.buyer}">${sw.buyer.slice(0, 4)}…${sw.buyer.slice(-4)}</a> · <a href="${SITE}/#Explorer/${sw.sig}">Tx</a>`,
      rate ? `📊 MC <b>${usd(mcap * rate)}</b> · Price ${usd(price * rate)}` : `📊 MC ${compact(mcap)} ACRUX · Price ${fmtPrice(price)} ACRUX`,
    ].join('\n')
    await tg('sendMessage', {
      chat_id: GROUP, parse_mode: 'HTML', disable_web_page_preview: true, text,
      reply_markup: { inline_keyboard: [[action('🟢 Buy HUB', `Swap/${HUB}`, false), action('📈 Chart', `Launch/${HUB}`, false)]] },
    })
    posted++
  }
  return { posted }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // The Mini App reporting its wallet address (checked against Telegram's signature).
  if (req.query.op === 'link') return linkEndpoint(req, res)
  // The buy bot: public and idempotent (only posts buys it hasn't posted yet).
  if (req.query.op === 'buys') {
    if (!GROUP) return res.status(503).json({ error: 'no group' })
    try { return res.status(200).json(await buyCheck()) } catch (e: any) { console.error('buybot failed', e); return res.status(500).json({ error: String(e?.message ?? e) }) }
  }
  if (req.method === 'GET' && req.query.op) {
    const got = String(req.headers['x-setup-secret'] ?? '')
    if (!SECRET || got.length !== SECRET.length || !timingSafeEqual(Buffer.from(got), Buffer.from(SECRET))) return res.status(401).end()
    return res.status(200).json(await setup(String(req.query.op), String(req.headers.host)))
  }
  if (req.method !== 'POST') return res.status(405).end()
  const got = String(req.headers['x-telegram-bot-api-secret-token'] ?? '')
  if (!SECRET || got.length !== SECRET.length || !timingSafeEqual(Buffer.from(got), Buffer.from(SECRET))) return res.status(401).end()
  const u = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  try {
    logChat(u)
    if (u.message) await onMessage(u.message)
    else if (u.callback_query) await onCallback(u.callback_query)
  } catch (e) {
    console.error('telegram update failed', e)
  }
  // Always 200: a non-200 makes Telegram retry the same update.
  return res.status(200).end()
}
