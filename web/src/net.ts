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
  /** Receives AcruxHub's 0.1% swap fee. Absent = no fee on this network. */
  feeRecipient?: PublicKey
}

export const NETWORKS: Record<Network['id'], Network> = {
  acrux: {
    id: 'acrux',
    name: 'Acrux Net',
    rpc: 'https://rpc.acrux.computer',
    gateway: new AcruxGateway('https://rpc.acrux.computer', 'https://api.acrux.computer'),
    explorerNative: 'ACRUX',
    feeRecipient: new PublicKey('AcXRKoSUCGACXU2ygruLFYMx26KdotYX9KHRcsNC2oBd'),
  },
  local: {
    id: 'local',
    name: 'Local (dev)',
    rpc: 'http://127.0.0.1:8999',
    explorerNative: 'SOL',
  },
}

/**
 * Tokens the faucet hands out on Acrux Net. These are only the last known mints:
 * every Acrux Net restart can mint new ones, so `refreshDemoTokens` replaces them
 * with the live set from the gateway's getDemoPool on load.
 */
export const KNOWN_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  '713QqmE1xGXS8vACKxfxyr5YvtitXymtiR45E3egsdss': { symbol: 'AXA', name: 'Acrux Demo A', decimals: 6 },
  '28TKYtoixNcHeNRuJ4C69tYP4yEXDGA6wBE4crB1j3Td': { symbol: 'AXB', name: 'Acrux Demo B', decimals: 6 },
}

/** Loads the live demo-token mints; returns true if anything changed. */
export async function refreshDemoTokens(n: Network): Promise<boolean> {
  if (!n.gateway) return false
  try {
    const pool = await n.gateway.call<{ mints: { address: string; symbol: string; name: string; decimals: number }[] }>('getDemoPool', {})
    const live = Object.fromEntries(pool.mints.map(m => [m.address, { symbol: m.symbol, name: m.name, decimals: m.decimals }]))
    const same = Object.keys(live).length === Object.keys(KNOWN_TOKENS).length && Object.keys(live).every(k => KNOWN_TOKENS[k])
    if (same) return false
    for (const k of Object.keys(KNOWN_TOKENS)) delete KNOWN_TOKENS[k]
    Object.assign(KNOWN_TOKENS, live)
    return true
  } catch {
    return false // keep the last known set
  }
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

/**
 * Acrux switches gas from test ACRUX to real ACRUX bridged from Solana at this slot
 * (announced by @AcruxComputer for about 22:00 UTC on Nov 20). The faucet closes then.
 */
export const GAS_SWITCH_SLOT = 4_752_000
export const GAS_SWITCH_TIME = 'about 22:00 UTC on Nov 20'

/**
 * New coin launches are paused while the launchpad moves from pricing in the
 * faucet's AXB to real ACRUX. Existing coins keep trading. Set to null to reopen.
 */
export const LAUNCHES_PAUSED: string | null =
  'New launches are paused while the launchpad moves from pricing in AXB (the faucet\'s demo token) to real ACRUX. Coins already launched keep trading. Back soon.'
