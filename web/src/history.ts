// Trade history for a launch, read from the chain: every buy and sell emits a
// `Traded` event with the curve's state after it, so the price after each trade is
// virtual_quote / virtual_tokens. Acrux's RPC has no getTokenLargestAccounts, so
// holders are reconstructed from curve trades (wallet transfers aren't seen).
import * as anchor from '@coral-xyz/anchor'
import type { Connection, PublicKey } from '@solana/web3.js'

export type Trade = {
  sig: string
  time: number
  buy: boolean
  user: string
  /** Quote paid (buy, fee included) or received (sell). Raw units. */
  quote: bigint
  tokens: bigint
  /** Price after the trade, quote raw per token raw. */
  price: number
  vq: number
  vt: number
}

export async function loadTrades(conn: Connection, program: anchor.Program<any>, launch: PublicKey, limit = 300): Promise<Trade[]> {
  const sigs = (await conn.getSignaturesForAddress(launch, { limit })).filter(s => !s.err)
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl))
  const out: Trade[] = []
  for (let i = 0; i < sigs.length; i += 10) {
    const chunk = sigs.slice(i, i + 10)
    const txs = await Promise.all(chunk.map(s => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)))
    txs.forEach((tx, j) => {
      const logs = tx?.meta?.logMessages
      if (!logs) return
      for (const ev of parser.parseLogs(logs)) {
        if (ev.name !== 'Traded' && ev.name !== 'traded') continue
        const d: any = ev.data
        if (d.launch.toBase58() !== launch.toBase58()) continue
        const vq = Number(d.virtual_quote ?? d.virtualQuote)
        const vt = Number(d.virtual_tokens ?? d.virtualTokens)
        out.push({
          sig: chunk[j].signature,
          time: tx!.blockTime ?? chunk[j].blockTime ?? 0,
          buy: d.buy,
          user: d.user.toBase58(),
          quote: BigInt(d.quote.toString()),
          tokens: BigInt(d.tokens.toString()),
          price: vt > 0 ? vq / vt : 0,
          vq,
          vt,
        })
      }
    })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** Net tokens bought on the curve per wallet, biggest first. */
export function holdersFromTrades(trades: Trade[]) {
  const net = new Map<string, bigint>()
  for (const t of trades) net.set(t.user, (net.get(t.user) ?? 0n) + (t.buy ? t.tokens : -t.tokens))
  return [...net.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
}

/** Seconds ago, short ("12s", "4m", "3h", "2d"). */
export function ago(t: number, now = Date.now() / 1000) {
  const s = Math.max(0, Math.floor(now - t))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Compact number: 1234 -> 1.23K, 5_600_000 -> 5.6M. */
export function compact(n: number) {
  if (!isFinite(n)) return '–'
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  if (a >= 1) return n.toFixed(2)
  if (a === 0) return '0'
  return n.toPrecision(3)
}

const SUB = '₀₁₂₃₄₅₆₇₈₉'
/**
 * Price for display. Tiny prices use the launchpad convention of counting the
 * zeros after the point: 0.00000007766 -> "0.0₇7766".
 */
export function fmtPrice(p: number) {
  if (!isFinite(p) || p <= 0) return '0'
  if (p >= 1) return p.toLocaleString('en-US', { maximumFractionDigits: 4 })
  if (p >= 0.001) return p.toPrecision(4)
  const zeros = Math.ceil(-Math.log10(p)) - 1
  // zeros = how many 0s follow the point before the first significant digit.
  const digits = Math.round(p * 10 ** (zeros + 4)).toString().replace(/0+$/, '')
  return `0.0${String(zeros).split('').map(d => SUB[Number(d)]).join('')}${digits}`
}

/**
 * The curve price just before the first trade, so the chart starts at the opening
 * price. For a buy the curve took `quote` minus the fee; for a sell it gave back
 * `quote` plus the fee.
 */
export function openingPrice(t: Trade, feeBps: number, vq: number, vt: number) {
  const net = t.buy ? (Number(t.quote) * 10_000) / (10_000 + feeBps) : (Number(t.quote) * 10_000) / (10_000 - feeBps)
  const vqBefore = t.buy ? vq - net : vq + net
  const vtBefore = t.buy ? vt + Number(t.tokens) : vt - Number(t.tokens)
  return vtBefore > 0 ? vqBefore / vtBefore : t.price
}
