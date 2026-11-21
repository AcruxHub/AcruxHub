// POST /api/solana: a small Solana mainnet RPC for the Bridge page. The public
// endpoint refuses browser origins, so the page asks this function instead. Only the
// reads the bridge needs are forwarded, plus sendTransaction for already-signed
// transactions that call Acrux's bridge program (the in-app wallet signs bridge
// deposits itself, inside Telegram and the phone apps). Nothing here holds a key.
import type { VercelRequest, VercelResponse } from '@vercel/node'

const UPSTREAM = 'https://api.mainnet-beta.solana.com'
const READS = new Set(['getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash', 'getSignatureStatuses'])
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost'])
// Acrux's bridge program on Solana (EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5), as raw bytes.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const decode58 = (s: string) => {
  let n = 0n
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c))
  const hex = n.toString(16).padStart(64, '0')
  return Buffer.from(hex, 'hex')
}
const BRIDGE = decode58('EDm6HxGArNEgGfWRZwvj42f4euc9oPQWVUwUbkK3PEe5')
// Opening an ACRUX token account on Solana (so a payout from the bridge has somewhere to
// land) is the other thing the page sends: the Associated Token program plus the ACRUX mint.
const ATA_PROGRAM = decode58('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const ACRUX_MINT = decode58('7Evw4uxTxLGGEFEvXLUNYyc1J7PnFk9EYwTUFagARUX')
// A Jupiter swap (the Bridge page's "swap SOL for ACRUX" step): Jupiter's v6 program id.
const JUPITER = decode58('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')

/** A signed transaction we're willing to relay: small, and it either names the bridge
 * program, is a Jupiter swap, or opens an ACRUX token account. */
function isBridgeTx(params: unknown): boolean {
  if (!Array.isArray(params) || typeof params[0] !== 'string') return false
  const opts = params[1] as any
  if (opts?.encoding !== 'base64') return false // web3.js sends base64
  const raw = Buffer.from(params[0], 'base64')
  if (raw.length < 100 || raw.length > 1232) return false
  return raw.indexOf(BRIDGE) !== -1 || raw.indexOf(JUPITER) !== -1 || (raw.indexOf(ATA_PROGRAM) !== -1 && raw.indexOf(ACRUX_MINT) !== -1)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin ?? '')
  if (APP_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'POST')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
  }
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  // web3.js sends single requests; refuse batches and anything not on the list.
  const ok = body && !Array.isArray(body) && (READS.has(body.method) || (body.method === 'sendTransaction' && isBridgeTx(body.params)))
  if (!ok) return res.status(400).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed here' } })
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params ?? [] }) })
  res.status(r.status).setHeader('content-type', 'application/json').send(await r.text())
}
