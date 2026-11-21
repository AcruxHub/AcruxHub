// GET /api/price: ACRUX in US dollars, for showing market caps and prices in USD.
// ACRUX trades on Solana (mint 7Evw4ux…), so its dollar price comes from Solana's
// markets: Jupiter's price API first, DexScreener's ACRUX pairs as the fallback.
// Cached for a minute per instance; the response also carries where it came from.
import type { VercelRequest, VercelResponse } from '@vercel/node'

const ACRUX_SOLANA = '7Evw4uxTxLGGEFEvXLUNYyc1J7PnFk9EYwTUFagARUX'
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost'])
let cache: { at: number; body: { acruxUsd: number; source: string; at: number } } | null = null

async function jupiter(): Promise<number | null> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ACRUX_SOLANA}`, { signal: AbortSignal.timeout(5000) })
  const j: any = await r.json()
  const p = Number(j?.[ACRUX_SOLANA]?.usdPrice)
  return p > 0 && isFinite(p) ? p : null
}

async function dexscreener(): Promise<number | null> {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${ACRUX_SOLANA}`, { signal: AbortSignal.timeout(5000) })
  const pairs: any[] = await r.json()
  // The deepest pair where ACRUX is the base token.
  const best = (Array.isArray(pairs) ? pairs : [])
    .filter(p => p?.baseToken?.address === ACRUX_SOLANA && Number(p?.priceUsd) > 0)
    .sort((a, b) => Number(b?.liquidity?.usd ?? 0) - Number(a?.liquidity?.usd ?? 0))[0]
  return best ? Number(best.priceUsd) : null
}

/** ACRUX in USD, or null when neither source answers. Shared with the bot. */
export async function acruxUsd(): Promise<{ acruxUsd: number; source: string; at: number } | null> {
  if (cache && Date.now() - cache.at < 60_000) return cache.body
  for (const [source, get] of [['jupiter', jupiter], ['dexscreener', dexscreener]] as const) {
    try {
      const p = await get()
      if (p) { cache = { at: Date.now(), body: { acruxUsd: p, source, at: Date.now() } }; return cache.body }
    } catch { /* try the next one */ }
  }
  return cache?.body ?? null // a stale price beats none
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers.origin ?? '')
  if (APP_ORIGINS.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  const body = await acruxUsd()
  if (!body) return res.status(503).json({ error: 'no price right now' })
  return res.status(200).json(body)
}
