// Coin metadata (image, description, links) referenced by a launch's on-chain `uri`.
import { useEffect, useState } from 'react'

export type CoinMeta = {
  name?: string
  symbol?: string
  description?: string
  image?: string
  links?: { x?: string; telegram?: string; website?: string }
}

const cache = new Map<string, Promise<CoinMeta | null>>()

/** Only http(s) URLs ever reach an href or src, so a launch can't inject javascript: links. */
export function safeUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u) return null
  try {
    const url = new URL(u)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export function loadMeta(uri: string): Promise<CoinMeta | null> {
  const url = safeUrl(uri)
  if (!url) return Promise.resolve(null)
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then(j => (j && typeof j === 'object' ? (j as CoinMeta) : null))
        .catch(() => null),
    )
  }
  return cache.get(url)!
}

export function useMeta(uri: string | undefined): CoinMeta | null {
  const [meta, setMeta] = useState<CoinMeta | null>(null)
  useEffect(() => {
    let live = true
    setMeta(null)
    if (uri) loadMeta(uri).then(m => live && setMeta(m))
    return () => { live = false }
  }, [uri])
  return meta
}

/** Uploads the image + details through our /api/upload and returns the metadata URI. */
export async function uploadCoin(input: {
  name: string; symbol: string; description: string; image: string; x: string; telegram: string; website: string
}): Promise<{ uri: string; image: string }> {
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`)
  return body
}

/** Reads a File as a data: URL, refusing anything over 1 MB before it's sent. */
export function readImage(file: File): Promise<string> {
  if (file.size > 1_000_000) return Promise.reject(new Error('Image must be 1 MB or smaller.'))
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return Promise.reject(new Error('Image must be PNG, JPG, GIF or WebP.'))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('Could not read the image.'))
    r.readAsDataURL(file)
  })
}
