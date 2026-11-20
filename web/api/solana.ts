// POST /api/solana: a read-only Solana mainnet RPC for the Bridge page. The public
// endpoint refuses browser origins, so the page asks this function instead. Only the
// few reads the bridge needs are forwarded; sending is done by the user's wallet.
import type { VercelRequest, VercelResponse } from '@vercel/node'

const UPSTREAM = 'https://api.mainnet-beta.solana.com'
const ALLOWED = new Set(['getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash', 'getSignatureStatuses'])
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost'])

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
  if (!body || Array.isArray(body) || !ALLOWED.has(body.method)) {
    return res.status(400).json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed here' } })
  }
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params ?? [] }) })
  res.status(r.status).setHeader('content-type', 'application/json').send(await r.text())
}
