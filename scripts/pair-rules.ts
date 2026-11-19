// Decision rules for the pair keeper (scripts/pair-keeper.ts): which tokens the
// launchpad should offer as pairs, judged by liquidity on Acrux. Pure functions,
// no chain access, so they're unit-tested in tests/pair-rules.test.ts.
//
// A token is APPROVED once its pools against the default quote have held at least
// `minLiquidity` (measured as 2 x the quote-side reserve, in whole quote tokens)
// continuously for `sustainHours`, and the token is safe to pair with: classic
// SPL token, mint authority revoked (fixed supply) and no freeze authority.
// A pair the keeper approved is DISABLED once its liquidity stays below
// `delistLiquidity` for `sustainHours`. Pairs the admin set by hand are never
// touched. Disabling only stops new coins; coins already paired keep trading.

export type RulesConfig = {
  /** Whole quote tokens of liquidity (2 x quote reserve) needed to approve. */
  minLiquidity: number
  /** Below this a keeper-approved pair is disabled (lower than minLiquidity, so it doesn't flap). */
  delistLiquidity: number
  /** How long liquidity must stay above (or below) the line before acting. */
  sustainHours: number
  /** Most keeper-approved pairs enabled at once; the deepest win. */
  maxPairs: number
}

export const DEFAULT_RULES: RulesConfig = { minLiquidity: 2_000, delistLiquidity: 1_000, sustainHours: 24, maxPairs: 20 }

/** One pool of a token against the default quote. Raw units. */
export type PoolObs = { pool: string; tokenReserve: bigint; quoteReserve: bigint }

export type TokenInfo = {
  mint: string
  /** Owned by the classic SPL Token program (the launchpad's curves use it). */
  classic: boolean
  mintAuthority: string | null
  freezeAuthority: string | null
  decimals: number
}

export type PairNow = { enabled: boolean; managed: boolean }

export type MintState = { aboveSince?: string; belowSince?: string }
export type KeeperState = { mints: Record<string, MintState>; managed: string[] }

export type Action =
  | { type: 'approve'; mint: string; virtualQuote: bigint; graduationQuote: bigint; liquidity: number; reason: string }
  | { type: 'disable'; mint: string; liquidity: number; reason: string }

/** Liquidity in whole quote tokens: 2 x the quote side, summed over the token's pools. */
export function liquidityOf(pools: PoolObs[], quoteDecimals: number): number {
  const q = pools.reduce((s, p) => s + p.quoteReserve, 0n)
  return (Number(q) * 2) / 10 ** quoteDecimals
}

/** Why a token can't be a pair, or null if it can. */
export function unsafeReason(t: TokenInfo): string | null {
  if (!t.classic) return 'not a classic SPL token'
  if (t.mintAuthority) return 'supply is not fixed (mint authority set)'
  if (t.freezeAuthority) return 'has a freeze authority'
  if (t.decimals > 12) return 'too many decimals'
  return null
}

/**
 * Pair parameters worth the same as the default curve at the token's pool price:
 * an amount of quote Q is worth Q x tokenReserve / quoteReserve of the token
 * (deepest pool's price). Returns null if the pools are empty.
 */
export function pairParams(pools: PoolObs[], defaults: { virtualQuote: bigint; graduationQuote: bigint }) {
  const deepest = [...pools].sort((a, b) => (a.quoteReserve === b.quoteReserve ? 0 : a.quoteReserve > b.quoteReserve ? -1 : 1))[0]
  if (!deepest || deepest.quoteReserve === 0n || deepest.tokenReserve === 0n) return null
  const conv = (q: bigint) => (q * deepest.tokenReserve) / deepest.quoteReserve
  const virtualQuote = conv(defaults.virtualQuote)
  const graduationQuote = conv(defaults.graduationQuote)
  if (virtualQuote === 0n || graduationQuote === 0n) return null
  return { virtualQuote, graduationQuote }
}

export function decide(a: {
  now: Date
  rules: RulesConfig
  quoteDecimals: number
  defaults: { virtualQuote: bigint; graduationQuote: bigint }
  /** Pools per token mint (only pools against the default quote). */
  pools: Record<string, PoolObs[]>
  tokens: Record<string, TokenInfo>
  /** Pairs on chain now, by mint. `managed` = approved by this keeper. */
  pairs: Record<string, PairNow>
  state: KeeperState
}): { actions: Action[]; state: KeeperState; notes: string[] } {
  const { now, rules } = a
  const sustainMs = rules.sustainHours * 3_600_000
  const iso = now.toISOString()
  const mints: Record<string, MintState> = {}
  const managed = new Set(a.state.managed)
  const actions: Action[] = []
  const notes: string[] = []
  const held = (since?: string) => !!since && now.getTime() - Date.parse(since) >= sustainMs

  const candidates: { mint: string; liquidity: number }[] = []
  for (const [mint, pools] of Object.entries(a.pools)) {
    const liq = liquidityOf(pools, a.quoteDecimals)
    const prev = a.state.mints[mint] ?? {}
    const st: MintState = {}
    if (liq >= rules.minLiquidity) st.aboveSince = prev.aboveSince ?? iso
    if (liq < rules.delistLiquidity) st.belowSince = prev.belowSince ?? iso
    mints[mint] = st

    const pair = a.pairs[mint]
    if (pair?.enabled && pair.managed && held(st.belowSince)) {
      actions.push({ type: 'disable', mint, liquidity: liq, reason: `liquidity ${liq.toFixed(0)} below ${rules.delistLiquidity} for ${rules.sustainHours}h` })
      continue
    }
    if (pair?.enabled) continue
    if (pair && !pair.managed) continue // set by the admin by hand: leave it alone
    if (!held(st.aboveSince)) continue
    const bad = a.tokens[mint] ? unsafeReason(a.tokens[mint]) : 'token info unavailable'
    if (bad) { notes.push(`${mint}: liquid but skipped (${bad})`); continue }
    candidates.push({ mint, liquidity: liq })
  }

  // Keeper pairs still enabled after this run's disables, then fill up to maxPairs, deepest first.
  const disabled = new Set(actions.map(x => x.mint))
  let active = Object.entries(a.pairs).filter(([m, p]) => p.enabled && p.managed && !disabled.has(m)).length
  for (const c of candidates.sort((x, y) => y.liquidity - x.liquidity)) {
    if (active >= rules.maxPairs) { notes.push(`${c.mint}: qualifies but maxPairs (${rules.maxPairs}) reached`); continue }
    const params = pairParams(a.pools[c.mint], a.defaults)
    if (!params) { notes.push(`${c.mint}: no usable price`); continue }
    actions.push({ type: 'approve', mint: c.mint, ...params, liquidity: c.liquidity, reason: `liquidity ${c.liquidity.toFixed(0)} above ${rules.minLiquidity} for ${rules.sustainHours}h` })
    managed.add(c.mint)
    active++
  }
  return { actions, state: { mints, managed: [...managed] }, notes }
}
