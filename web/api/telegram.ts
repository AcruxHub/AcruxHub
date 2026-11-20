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

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? ''
const BOT = process.env.TELEGRAM_BOT_USERNAME ?? 'AcruxHubBot'
const GROUP = process.env.TELEGRAM_GROUP_ID ?? ''
const SITE = 'https://acruxhub.com'
const RPC = 'https://rpc.acrux.computer'
const WRAPPED_ACRUX = 'So11111111111111111111111111111111111111112'
const AXB = '28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td'
const LAUNCHPAD = '3qCdE6gNWinKpPX71JZk8DGe2AYsYaVg6v8WB7N3SKrd'
// Launch account discriminator (sdk/src/idl/acruxhub_launchpad.json).
const LAUNCH_DISC = Buffer.from([144, 51, 51, 163, 206, 85, 213, 38])

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
    ? { text, web_app: { url: `${SITE}/#${route}` } }
    : { text, url: `https://t.me/${BOT}?startapp=${encodeURIComponent(route.replace(/\//g, '_'))}` }
}

// ---------------------------------------------------------------- chain data
type Coin = { mint: string; name: string; symbol: string; uri: string; price: number; mcap: number; progress: number; raised: number; target: number; quote: string; graduated: boolean; complete: boolean }

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
    mint: pk(40), curveQuote: pk(104),
    virtualQuote: u64(208), virtualTokens: u64(216), realQuote: u64(224), graduationQuote: u64(240),
    complete: d[250] === 1, graduated: d[251] === 1,
    name: str(), symbol: str(), uri: str(),
  }
}

let cache: { at: number; coins: Coin[] } | null = null
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
  const out = launches.map((l, i) => {
    const qd = decs.get(qMints[i]) ?? 6
    const vq = Number(l.virtualQuote) / 10 ** qd, vt = Number(l.virtualTokens) / 1e6
    const price = vt > 0 ? vq / vt : 0
    const target = Number(l.graduationQuote) / 10 ** qd, raised = Number(l.realQuote) / 10 ** qd
    return {
      mint: l.mint, name: l.name, symbol: l.symbol, uri: l.uri, price, mcap: price * 1e9,
      progress: target > 0 ? Math.min(1, raised / target) : 0, raised, target,
      quote: qMints[i] === WRAPPED_ACRUX ? 'ACRUX' : qMints[i] === AXB ? 'AXB' : qMints[i].slice(0, 4),
      graduated: l.graduated, complete: l.complete,
    }
  })
  cache = { at: Date.now(), coins: out }
  return out
}

function fmtPrice(p: number) {
  if (!isFinite(p) || p <= 0) return '0'
  if (p >= 0.001) return p.toPrecision(4)
  const zeros = Math.ceil(-Math.log10(p)) - 1
  const sub = '₀₁₂₃₄₅₆₇₈₉'
  return `0.0${String(zeros).split('').map(d => sub[+d]).join('')}${Math.round(p * 10 ** (zeros + 4)).toString().replace(/0+$/, '')}`
}
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K` : n.toFixed(2))
const bar = (p: number) => '▰'.repeat(Math.round(p * 10)) + '▱'.repeat(10 - Math.round(p * 10))

function coinCard(c: Coin, privateChat: boolean) {
  const status = c.graduated ? '🎓 Graduated, trading on its pool' : c.complete ? '✅ Curve full, ready to graduate' : `${bar(c.progress)} ${(c.progress * 100).toFixed(1)}%`
  const text = [
    `<b>${esc(c.name)}</b> $${esc(c.symbol)}`,
    `<code>${c.mint}</code>`,
    '',
    `Price  ${fmtPrice(c.price)} ${c.quote}`,
    `MC     ${compact(c.mcap)} ${c.quote}`,
    c.graduated ? status : `Curve  ${status}\nRaised ${c.raised.toFixed(2)} / ${c.target} ${c.quote}`,
  ].join('\n')
  const buttons = c.graduated
    ? [[action('🔁 Swap', `Swap/${c.mint}`, privateChat), action('📈 Chart', `Launch/${c.mint}`, privateChat)]]
    : [[action('🟢 Buy', `Launch/${c.mint}`, privateChat), action('🔴 Sell', `Launch/${c.mint}`, privateChat)]]
  return { text, reply_markup: { inline_keyboard: buttons } }
}

function findCoin(all: Coin[], q: string) {
  const s = q.trim().replace(/^\$/, '')
  return all.find(c => c.mint === s) ?? all.find(c => c.symbol.toLowerCase() === s.toLowerCase())
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
  '/coins  top coins on the launchpad',
  '/coin &lt;CA or ticker&gt;  one coin',
  '/launch  launch a coin',
  '/swap  swap any token',
  '/bridge  bring ACRUX over from Solana',
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
    return tg('sendMessage', {
      chat_id: chat, text: HELP, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[action('🚀 Open AcruxHub', 'Launch', priv)], [action('➕ Launch a coin', 'Launch/new', priv), action('🌉 Bridge', 'Bridge', priv)]] },
    })
  }
  // In a group or channel the bot was added to, /chatid tells the owner its id (for TELEGRAM_GROUP_ID).
  if (cmd === '/chatid' && !priv) return tg('sendMessage', { chat_id: chat, text: `Chat id: ${chat}` })
  if (cmd === '/help') return tg('sendMessage', { chat_id: chat, text: HELP, parse_mode: 'HTML' })
  if (cmd === '/launch') return tg('sendMessage', { chat_id: chat, text: 'Launch a coin: fixed supply, no presale, liquidity locked forever at graduation.', reply_markup: { inline_keyboard: [[action('➕ Launch a coin', 'Launch/new', priv)]] } })
  if (cmd === '/bridge') return tg('sendMessage', { chat_id: chat, text: 'Bring ACRUX over from Solana. On Acrux it\'s your gas.', reply_markup: { inline_keyboard: [[action('🌉 Open the bridge', 'Bridge', priv)]] } })
  if (cmd === '/swap') return tg('sendMessage', { chat_id: chat, text: 'Swap at the best price across AcruxHub and Raydium pools.', reply_markup: { inline_keyboard: [[action('🔁 Swap', arg ? `Swap/${arg}` : 'Swap', priv)]] } })
  if (cmd === '/coins') {
    const all = await coins()
    const live = all.filter(c => !c.graduated && !c.complete).sort((a, b) => b.progress - a.progress).slice(0, 5)
    const grads = all.filter(c => c.graduated).sort((a, b) => b.mcap - a.mcap).slice(0, 5)
    const line = (c: Coin) => `• <b>$${esc(c.symbol)}</b> ${fmtPrice(c.price)} ${c.quote} · MC ${compact(c.mcap)}${c.graduated ? '' : ` · ${(c.progress * 100).toFixed(0)}%`}`
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
  // A pasted CA, anywhere: show the coin if it's one of ours.
  const ca = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/)?.[0]
  if (ca) {
    const c = (await coins()).find(x => x.mint === ca)
    if (c) return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', reply_to_message_id: m.message_id, ...coinCard(c, priv) })
  }
  if (priv && text && !text.startsWith('/')) {
    const c = findCoin(await coins(), text)
    if (c) return tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', ...coinCard(c, priv) })
  }
}

async function onCallback(q: any) {
  const data: string = q.data ?? ''
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
 * GET /api/telegram?op=setup|status with header x-setup-secret = the webhook secret.
 * setup points the webhook here and sets the command menu and the Mini App menu button.
 */
async function setup(op: string, host: string) {
  if (op === 'status') return { me: await tg('getMe', {}), webhook: await tg('getWebhookInfo', {}) }
  if (op === 'setup') {
    return {
      webhook: await tg('setWebhook', { url: `https://${host}/api/telegram`, secret_token: SECRET, allowed_updates: ['message', 'callback_query', 'my_chat_member'], drop_pending_updates: true }),
      commands: await tg('setMyCommands', { commands: [
        { command: 'coins', description: 'Top coins on the launchpad' },
        { command: 'coin', description: 'Look up a coin by ticker or CA' },
        { command: 'launch', description: 'Launch a coin' },
        { command: 'swap', description: 'Swap any token' },
        { command: 'bridge', description: 'Bring ACRUX over from Solana' },
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
