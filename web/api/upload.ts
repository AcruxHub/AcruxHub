// POST /api/upload: stores a coin's image and metadata JSON in Vercel Blob and
// returns the metadata URL that the launch stores on chain as its `uri`.
//
// Guards: images only (checked by magic bytes, not by the client's claim), 1 MB max,
// strict text lengths, social links normalised to https URLs. Files are named by
// their SHA-256, so the same upload twice is one file and nothing can be overwritten
// with different content.

import { put } from '@vercel/blob'
import { createHash } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const MAX_IMAGE = 1_000_000

const IMAGE_TYPES: { ext: string; type: string; test: (b: Buffer) => boolean }[] = [
  { ext: 'png', type: 'image/png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', type: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', test: b => b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', type: 'image/webp', test: b => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
]

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Accepts a handle or URL and returns a canonical https URL on the expected host, or ''. */
function social(v: unknown, kind: 'x' | 'telegram' | 'website'): string {
  const s = clean(v, 200)
  if (!s) return ''
  if (kind === 'website') {
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''
    } catch {
      return ''
    }
  }
  const handle = s.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x\.com|twitter\.com|t\.me|telegram\.me)\//i, '').split(/[/?#]/)[0]
  if (!/^[A-Za-z0-9_]{2,64}$/.test(handle)) return ''
  return kind === 'x' ? `https://x.com/${handle}` : `https://t.me/${handle}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}

  const name = clean(body.name, 32)
  const symbol = clean(body.symbol, 10).toUpperCase()
  const description = clean(body.description, 500)
  if (!name || !symbol) return res.status(400).json({ error: 'Name and ticker are required.' })
  if (!/^[A-Z0-9$]{1,10}$/.test(symbol)) return res.status(400).json({ error: 'Ticker: letters and numbers only.' })

  const match = typeof body.image === 'string' ? body.image.match(/^data:[^;]+;base64,([A-Za-z0-9+/=]+)$/) : null
  if (!match) return res.status(400).json({ error: 'Add an image.' })
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length > MAX_IMAGE) return res.status(413).json({ error: 'Image must be 1 MB or smaller.' })
  const kind = IMAGE_TYPES.find(t => t.test(bytes))
  if (!kind) return res.status(415).json({ error: 'Image must be PNG, JPG, GIF or WebP.' })

  const imageHash = createHash('sha256').update(bytes).digest('hex')
  const image = await put(`images/${imageHash}.${kind.ext}`, bytes, {
    access: 'public', contentType: kind.type, addRandomSuffix: false, allowOverwrite: true,
  })

  const links = {
    x: social(body.x, 'x'),
    telegram: social(body.telegram, 'telegram'),
    website: social(body.website, 'website'),
  }
  // Metaplex-standard fields (image, external_url, properties.files) plus the
  // `extensions` that explorers and DEX UIs read for socials, and our own `links`.
  const metadata = {
    name,
    symbol,
    description,
    image: image.url,
    ...(links.website ? { external_url: links.website } : {}),
    properties: { files: [{ uri: image.url, type: kind.type }], category: 'image' },
    extensions: {
      ...(links.website ? { website: links.website } : {}),
      ...(links.x ? { twitter: links.x } : {}),
      ...(links.telegram ? { telegram: links.telegram } : {}),
    },
    links,
  }
  const json = JSON.stringify(metadata)
  const metaHash = createHash('sha256').update(json).digest('hex')
  const meta = await put(`metadata/${metaHash}.json`, json, {
    access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true,
  })
  return res.status(200).json({ uri: meta.url, image: image.url, metadata })
}
