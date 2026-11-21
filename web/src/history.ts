// Trade history for a launch, read from the chain: every buy and sell emits a
// `Traded` event with the curve's state after it, so the price after each trade is
// virtual_quote / virtual_tokens. Acrux's RPC has no getTokenLargestAccounts, so
// holders are reconstructed from curve trades (wallet transfers aren't seen).
import * as anchor from '@coral-xyz/anchor'
import { PublicKey, type Connection } from '@solana/web3.js'

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
  /** A swap in the coin's pool after graduation (vq/vt are then the pool's vault reserves). */
  pool?: boolean
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

export type Holder = { owner: string; amount: bigint; kind: 'wallet' | 'curve' | 'lock' | 'pool' }

/** Real holders of a token, read from the chain. Acrux's RPC has no
 * getTokenLargestAccounts, so every token account seen in a transaction that touches
 * the mint (curve trades, pool swaps, locks, checked transfers) is collected, and
 * their live balances are read. Programs' accounts are labelled, not counted. */
export async function loadHolders(conn: Connection, mint: PublicKey, curveTokens: PublicKey, lockerId: PublicKey, limit = 1000): Promise<Holder[]> {
  const m = mint.toBase58()
  const sigs = (await conn.getSignaturesForAddress(mint, { limit })).filter(s => !s.err)
  const accounts = new Set<string>()
  for (let i = 0; i < sigs.length; i += 10) {
    const txs = await Promise.all(sigs.slice(i, i + 10).map(s => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)))
    for (const tx of txs) {
      if (!tx?.meta) continue
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
        const k = b.mint === m ? keys.get(b.accountIndex) : undefined
        if (k) accounts.add(k.toBase58())
      }
    }
  }
  const list = [...accounts].map(a => new PublicKey(a))
  const rows: { acct: PublicKey; owner: PublicKey; amount: bigint }[] = []
  for (let i = 0; i < list.length; i += 100) {
    const infos = await conn.getMultipleParsedAccounts(list.slice(i, i + 100))
    infos.value.forEach((x, j) => {
      const info = (x?.data as any)?.parsed?.info
      if (!info || info.mint !== m) return
      const amount = BigInt(info.tokenAmount.amount)
      if (amount > 0n) rows.push({ acct: list[i + j], owner: new PublicKey(info.owner), amount })
    })
  }
  // Off-curve owners are programs: a lock (owned by the locker) or a pool's authority.
  const offCurve = [...new Set(rows.filter(r => !PublicKey.isOnCurve(r.owner.toBytes())).map(r => r.owner.toBase58()))]
  const ownerInfos = offCurve.length ? await conn.getMultipleAccountsInfo(offCurve.map(o => new PublicKey(o))) : []
  const lockOwners = new Set(offCurve.filter((_, i) => ownerInfos[i]?.owner.equals(lockerId)))
  const by = new Map<string, Holder>()
  for (const r of rows) {
    const o = r.owner.toBase58()
    const kind: Holder['kind'] = r.acct.equals(curveTokens) ? 'curve' : lockOwners.has(o) ? 'lock' : !PublicKey.isOnCurve(r.owner.toBytes()) ? 'pool' : 'wallet'
    const key = kind === 'lock' ? 'lock' : kind === 'curve' ? 'curve' : o
    const h = by.get(key) ?? { owner: kind === 'lock' ? 'Token locks' : o, amount: 0n, kind }
    h.amount += r.amount
    by.set(key, h)
  }
  return [...by.values()].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
}

/** Swaps in a graduated coin's Raydium CPMM pool, as trades. Read from each swap's
 * token balance changes on the pool's two vaults; the price after a swap is the
 * vaults' ratio (quote raw per token raw, the same unit as curve trades). Pool
 * creation and liquidity changes (both vaults moving the same way) are skipped. */
export async function loadPoolTrades(conn: Connection, pool: PublicKey, mint: PublicKey, limit = 300): Promise<Trade[]> {
  const info = await conn.getAccountInfo(pool)
  if (!info || info.data.length < 200) return []
  const d = info.data
  const vA = new PublicKey(d.subarray(72, 104)).toBase58(), vB = new PublicKey(d.subarray(104, 136)).toBase58()
  const tokenIsA = new PublicKey(d.subarray(168, 200)).equals(mint)
  const [tokV, quoteV] = tokenIsA ? [vA, vB] : [vB, vA]
  const sigs = (await conn.getSignaturesForAddress(pool, { limit })).filter(s => !s.err)
  const out: Trade[] = []
  for (let i = 0; i < sigs.length; i += 10) {
    const chunk = sigs.slice(i, i + 10)
    const txs = await Promise.all(chunk.map(s => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)))
    txs.forEach((tx, j) => {
      if (!tx?.meta) return
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
      const bal = (list: typeof tx.meta.preTokenBalances, v: string) => {
        const b = (list ?? []).find(x => keys.get(x.accountIndex)?.toBase58() === v)
        return b ? BigInt(b.uiTokenAmount.amount) : null
      }
      const t0 = bal(tx.meta.preTokenBalances, tokV), t1 = bal(tx.meta.postTokenBalances, tokV)
      const q0 = bal(tx.meta.preTokenBalances, quoteV), q1 = bal(tx.meta.postTokenBalances, quoteV)
      if (t0 == null || t1 == null || q0 == null || q1 == null || t0 === 0n || t1 === 0n) return
      const dt = t1 - t0, dq = q1 - q0
      if (dt === 0n || dq === 0n || (dt > 0n) === (dq > 0n)) return // not a swap
      const vq = Number(q1), vt = Number(t1)
      out.push({
        sig: chunk[j].signature,
        time: tx.blockTime ?? chunk[j].blockTime ?? 0,
        buy: dt < 0n,
        user: keys.get(0)!.toBase58(),
        quote: dq < 0n ? -dq : dq,
        tokens: dt < 0n ? -dt : dt,
        price: vq / vt,
        vq,
        vt,
      })
    })
  }
  return out.sort((a, b) => a.time - b.time)
}
