import { Connection, PublicKey } from '@solana/web3.js'
import { AcruxGateway } from '@acruxhub/sdk'

export type Network = {
  id: 'acrux' | 'local'
  name: string
  rpc: string
  /** Acrux-native gateway (threshold sends, slot/window data). Absent on a plain SVM chain. */
  gateway?: AcruxGateway
  /** Quote token for the launchpad on this network. */
  explorerNative: string
}

export const NETWORKS: Record<Network['id'], Network> = {
  acrux: {
    id: 'acrux',
    name: 'Acrux Net',
    rpc: 'https://rpc.acrux.computer',
    gateway: new AcruxGateway('https://rpc.acrux.computer', 'https://api.acrux.computer'),
    explorerNative: 'ACRUX',
  },
  local: {
    id: 'local',
    name: 'Local (dev)',
    rpc: 'http://127.0.0.1:8999',
    explorerNative: 'SOL',
  },
}

/** Tokens the faucet hands out on Acrux Net (live mints from getDemoPool; they differ from the repo genesis file). */
export const KNOWN_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  '713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss': { symbol: 'AXA', name: 'Acrux Demo A', decimals: 6 },
  '28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td': { symbol: 'AXB', name: 'Acrux Demo B', decimals: 6 },
}

export const connectionFor = (n: Network) => new Connection(n.rpc, 'confirmed')

export function short(k: PublicKey | string, n = 4) {
  const s = typeof k === 'string' ? k : k.toBase58()
  return `${s.slice(0, n)}…${s.slice(-n)}`
}

export function fmt(raw: bigint | number | string, decimals: number, max = 6) {
  const v = BigInt(raw.toString())
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, max).replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`
}

export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim()
  if (!/^\d*(\.\d*)?$/.test(t) || t === '' || t === '.') return null
  const [w, f = ''] = t.split('.')
  if (f.length > decimals) return null
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}
