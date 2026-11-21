import { useEffect, useMemo, useRef, useState } from 'react'
import { Keypair, ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getMint } from '@solana/spl-token'
import {
  launchConfig, launchAddress, launchPairAddress, launchPauseAddress, allAccounts, curveBuy, curveSell, curveProgress, stateOf, graduateAccounts, BN,
  graduateRaydiumAccounts, loadCpmmFeeTiers, cpmmPoolAddresses, CPMM_POOL_SIZE, RAYDIUM_CPMM_ID, holderStatus, discountedFeeBps, LOCKER_ID, loadLocks, lockerProgram,
  type CurveState,
} from '@acruxhub/sdk'
import { useWallet, readProvider } from '../wallet.tsx'
import { useAsync, tokenLabel, useAcruxUsd, usd } from '../hooks.ts'
import { loadLaunchConfig, decimalsOf, RETIRED_COINS } from '../data.ts'
import { fmt, parseAmount, short, LAUNCHES_PAUSED, KNOWN_TOKENS } from '../net.ts'
import { Action, CopyButton, Price } from '../ui.tsx'
import { useMeta, safeUrl, uploadCoin, readImage, type CoinMeta } from '../meta.ts'
import { launchpadUpgraded, launchpadFor } from '../launchpad.ts'
import { loadTrades, loadPoolTrades, loadHolders, holdersFromTrades, type Holder, ago, compact, fmtPrice, openingPrice, type Trade } from '../history.ts'
import { PriceChart } from '../chart.tsx'
import { wrapFor, spendable } from '../wrap.ts'
import { useLocked, lockDate } from './Locks.tsx'

type LaunchRow = { publicKey: PublicKey; account: any }
type Quote = { quoteMint: PublicKey; quoteSym: string; qd: number }
type View = { kind: 'board'; q: string } | { kind: 'create' } | { kind: 'coin'; key: string }
type Tab = 'top' | 'new' | 'almost' | 'graduated'

const TOKEN_DECIMALS = 6

function viewFromHash(): View {
  const rest = decodeURIComponent(location.hash.split('/').slice(1).join('/'))
  if (!rest) return { kind: 'board', q: '' }
  if (rest === 'new') return { kind: 'create' }
  if (rest.startsWith('q:')) return { kind: 'board', q: rest.slice(2) }
  return { kind: 'coin', key: rest.split('/')[0] } // /buy, /sell, /<amount> are trade presets
}

/** Price per whole coin in whole quote tokens. */
const priceOf = (s: CurveState, qd: number) => (Number(s.virtualQuote) / Number(s.virtualTokens)) * 10 ** (TOKEN_DECIMALS - qd)

export function Launch() {
  const w = useWallet()
  const upgraded = useAsync(() => launchpadUpgraded(w.network, w.conn), [w.conn, w.network.id])
  const config = useAsync(() => loadLaunchConfig(w.conn), [w.conn])
  const launches = useAsync(async () => {
    const lp = launchpadFor(readProvider(w.conn), false) // Launch accounts read the same in both builds
    const all = ((await allAccounts(lp, 'Launch')) as LaunchRow[]).filter(l => !HIDDEN_COINS.has(l.account.mint.toBase58()))
    return all.sort((a, b) => b.account.index.cmp(a.account.index))
  }, [w.conn, w.refreshKey])
  const defaultDecimals = useAsync(async () => (config.data ? decimalsOf(w.conn, config.data.quoteMint) : 9), [config.data])
  // Each coin trades in the quote token its curve was created with.
  const launchQuotes = useAsync(async () => {
    const ls = launches.data ?? []
    const out = new Map<string, { mint: PublicKey; decimals: number }>()
    for (let i = 0; i < ls.length; i += 99) {
      const chunk = ls.slice(i, i + 99)
      const infos = (await w.conn.getMultipleParsedAccounts(chunk.map(l => l.account.curveQuote))).value
      chunk.forEach((l, j) => {
        const info = (infos[j]?.data as any)?.parsed?.info
        if (info) out.set(l.publicKey.toBase58(), { mint: new PublicKey(info.mint), decimals: info.tokenAmount.decimals })
      })
    }
    return out
  }, [launches.data, w.conn])
  // Pairs and the pause switch exist only on the upgraded launchpad.
  const pairs = useAsync(async () => {
    if (!config.data || upgraded.data == null) return null
    const base = [{ mint: config.data.quoteMint as PublicKey, params: config.data.params, isDefault: true }]
    let extra: { mint: PublicKey; params: any; isDefault: boolean }[] = []
    if (upgraded.data) {
      const lp = launchpadFor(readProvider(w.conn), true)
      const approved = ((await allAccounts<any>(lp, 'QuotePair').catch(() => [])) as any[]).filter(p => p.account.enabled)
      extra = approved.filter(p => !(p.account.mint as PublicKey).equals(config.data!.quoteMint)).map(p => ({ mint: p.account.mint, params: p.account.params, isDefault: false }))
    }
    return Promise.all([...base, ...extra].map(async p => ({ ...p, sym: tokenLabel(p.mint.toBase58()), decimals: await decimalsOf(w.conn, p.mint) })))
  }, [config.data, upgraded.data, w.conn])
  const paused = useAsync(async () => {
    if (!upgraded.data) return false
    const lp = launchpadFor(readProvider(w.conn), true)
    const p: any = await (lp.account as any).pause.fetchNullable(launchPauseAddress()).catch(() => null)
    return !!p?.paused
  }, [upgraded.data, w.conn, w.refreshKey])

  const [view, setView] = useState<View>(viewFromHash)
  useEffect(() => {
    const on = () => { if (location.hash.startsWith('#Launch') || location.hash === '') setView(viewFromHash()) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  if (config.loading && !config.data) return <BoardSkeleton />
  if (!config.data) return <div className="card empty">The launchpad isn't set up on {w.network.name} yet.</div>
  const qd = defaultDecimals.data ?? 9
  const fallback: Quote = { quoteMint: config.data.quoteMint, quoteSym: tokenLabel(config.data.quoteMint.toBase58()), qd }
  const quoteOf = (l: LaunchRow): Quote => {
    const q = launchQuotes.data?.get(l.publicKey.toBase58())
    return q ? { quoteMint: q.mint, quoteSym: tokenLabel(q.mint.toBase58()), qd: q.decimals } : fallback
  }
  const totalSupply = BigInt(config.data.params.totalSupply.toString())
  // Test coins (priced in the faucet's demo tokens, from before real ACRUX) are left out entirely.
  const real = launches.data && launchQuotes.data ? launches.data.filter(l => !isTestCoin(quoteOf(l))) : null
  const pausedNote = paused.data ? 'The launchpad is paused for now: no new coins, buys, sells or graduations. Funds stay where they are.' : LAUNCHES_PAUSED

  if (view.kind === 'create') {
    if (pausedNote) return <PausedBanner paused={!!paused.data} note={pausedNote} />
    if (!pairs.data) return <BoardSkeleton />
    return <Create pairs={pairs.data} upgraded={!!upgraded.data} onDone={key => { location.hash = key ? `#Launch/${key}` : '#Launch' }} />
  }
  if (view.kind === 'coin') {
    const l = real?.find(x => x.publicKey.toBase58() === view.key || x.account.mint.toBase58() === view.key)
    if (!l) return !real ? <BoardSkeleton /> : <div className="card empty">Coin not found. <a href="#Launch">Back to coins</a></div>
    if (!launchQuotes.data || upgraded.data == null) return <BoardSkeleton />
    return <Coin l={l} {...quoteOf(l)} totalSupply={totalSupply} upgraded={upgraded.data} paused={!!paused.data} />
  }
  return <Board launches={real} loading={launches.loading || launchQuotes.loading} error={launches.error} quoteOf={quoteOf} totalSupply={totalSupply} query={view.q} pausedNote={pausedNote} paused={!!paused.data} />
}

function PausedBanner({ paused, note }: { paused: boolean; note: string }) {
  return (
    <div className="card notice" role="status" style={{ marginBottom: 20 }}>
      <strong>{paused ? 'Launchpad paused' : 'New launches paused'}</strong>
      <p style={{ margin: '6px 0 0', color: 'var(--muted)' }}>{note}</p>
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div className="coin-grid" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 102, borderRadius: 16 }} />)}
    </div>
  )
}

// ------------------------------------------------------------------ board
/** Retired launches (the shared list in data.ts): kept off the board. */
const HIDDEN_COINS = new Set(RETIRED_COINS)
/** Coins priced in the faucet's demo tokens, from before Acrux's gas switch: worth nothing. */
const isTestCoin = (q: Quote) => !!KNOWN_TOKENS[q.quoteMint.toBase58()]

function Board({ launches, loading, error, quoteOf, totalSupply, query, pausedNote, paused }: {
  launches: LaunchRow[] | null; loading: boolean; error: string | null; quoteOf: (l: LaunchRow) => Quote; totalSupply: bigint; query: string; pausedNote: string | null; paused: boolean
}) {
  const w = useWallet()
  const [tab, setTab] = useState<Tab>('top')
  const [q, setQ] = useState(query)
  useEffect(() => setQ(query), [query])
  const needle = q.trim().toLowerCase()
  const everything = launches ?? []
  // Real coins first; the pre-switch test coins only show on their own tab.
  const all = everything
  // A pasted CA that matches a coin opens it straight away.
  useEffect(() => {
    const hit = everything.find(l => l.account.mint.toBase58() === q.trim())
    if (hit) location.hash = `#Launch/${hit.publicKey.toBase58()}`
  }, [q, everything.length])
  const filtered = all.filter(l => !needle || l.account.name.toLowerCase().includes(needle) || l.account.symbol.toLowerCase().includes(needle) || l.account.mint.toBase58().toLowerCase() === needle)
  const progress = (l: LaunchRow) => curveProgress(stateOf(l.account))
  const list = useMemo(() => {
    const xs = [...filtered]
    // Top: coins on the curve by progress, then graduated coins, so the board is never empty.
    if (tab === 'top') return [...xs.filter(l => !l.account.graduated).sort((a, b) => progress(b) - progress(a)), ...xs.filter(l => l.account.graduated)]
    if (tab === 'new') return xs
    if (tab === 'almost') return xs.filter(l => !l.account.graduated && progress(l) >= 0.5).sort((a, b) => progress(b) - progress(a))
    return xs.filter(l => l.account.graduated)
  }, [filtered.length, tab, needle, launches])
  // The coin closest to graduating, not yet complete, gets the spotlight.
  // Locked supply per token, one read for the whole board.
  const allLocks = useAsync(() => loadLocks(w.conn, lockerProgram(readProvider(w.conn))), [w.conn, w.refreshKey])
  const lockedBy = useMemo(() => {
    const m = new Map<string, bigint>()
    for (const k of allLocks.data ?? []) m.set(k.mint.toBase58(), (m.get(k.mint.toBase58()) ?? 0n) + k.amount)
    return m
  }, [allLocks.data])
  const feature = all.filter(l => !l.account.complete && !l.account.graduated && progress(l) > 0).sort((a, b) => progress(b) - progress(a))[0]

  return (
    <>
      {pausedNote && <PausedBanner paused={paused} note={pausedNote} />}
      {feature && !needle && <Feature l={feature} {...quoteOf(feature)} totalSupply={totalSupply} />}
      {launches && all.length > 0 && (
        <div className="board-summary">
          <span><strong className="num">{all.length}</strong> {all.length === 1 ? 'coin' : 'coins'}</span>
          <span><strong className="num">{all.filter(l => l.account.graduated).length}</strong> graduated</span>
          <span><strong className="num">{all.filter(l => !l.account.graduated && !l.account.complete).length}</strong> on the curve</span>
          <span className="faint">Every coin: fixed supply, no presale, liquidity locked forever at graduation</span>
        </div>
      )}
      <div className="board-tools">
        <div className="seg" role="tablist" aria-label="Sort coins">
          {([['top', 'Top'], ['new', 'New'], ['almost', 'About to graduate'], ['graduated', 'Graduated']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, ticker or CA" aria-label="Search coins" spellCheck={false} />
      </div>
      {error && <p className="error">Could not load coins: {error}</p>}
      {loading && !launches && <BoardSkeleton />}
      {launches && !list.length && (
        <div className="card empty">
          {needle ? <>No coins match “{q}”.</> : tab === 'graduated' ? 'No coins have graduated yet.' : tab === 'almost' ? 'No coins are close to graduating yet.' : 'No coins yet.'}
          {!pausedNote && <div style={{ marginTop: 14 }}><button className="primary" onClick={() => { location.hash = '#Launch/new' }}>Create the first one</button></div>}
        </div>
      )}
      <div className="coin-grid">
        {list.map(l => <CoinCard key={l.publicKey.toBase58()} l={l} {...quoteOf(l)} totalSupply={totalSupply} locked={lockedBy.get(l.account.mint.toBase58()) ?? 0n} />)}
      </div>
    </>
  )
}

function CoinImage({ meta, symbol, size }: { meta: CoinMeta | null; symbol: string; size: number }) {
  const src = safeUrl(meta?.image)
  return src
    ? <img className="coin-img" src={src} alt={symbol} width={size} height={size} loading="lazy" />
    : <div className="coin-img placeholder" style={{ width: size, height: size }}>{symbol.slice(0, 4)}</div>
}

function Status({ a, s }: { a: any; s: CurveState }) {
  if (a.graduated) return <span className="pill good">Graduated</span>
  if (a.complete) return <span className="pill warn">Ready to graduate</span>
  return <span className="num faint" style={{ fontSize: 12 }}>{(curveProgress(s) * 100).toFixed(1)}%</span>
}

/** "🔒 42.9% locked", for any coin with tokens in the locker. */
export function LockTag({ locked, totalSupply }: { locked: bigint; totalSupply: bigint }) {
  if (locked <= 0n || totalSupply <= 0n) return null
  const p = (Number(locked) / Number(totalSupply)) * 100
  return <span className="pill good" title="Tokens locked on chain until a date">🔒 {p.toFixed(p < 1 ? 2 : 1)}% locked</span>
}

/** Live price, supply and market cap. A graduated coin trades in its Raydium pool, so
 * its price comes from the pool's vaults, and graduation burned the unsold tokens, so
 * its supply is the mint's real supply. Coins on the curve use the curve. */
function useMarket(l: LaunchRow, qd: number, totalSupply: bigint) {
  const w = useWallet()
  const a = l.account
  const pool = useAsync(async () => {
    if (!a.graduated) return null
    const info = await w.conn.getAccountInfo(a.pool)
    if (!info || info.data.length !== CPMM_POOL_SIZE) return null
    const d = info.data
    const vA = new PublicKey(d.subarray(72, 104)), vB = new PublicKey(d.subarray(104, 136)), mint0 = new PublicKey(d.subarray(168, 200))
    const [bA, bB, mint] = await Promise.all([w.conn.getTokenAccountBalance(vA), w.conn.getTokenAccountBalance(vB), getMint(w.conn, a.mint)])
    const tokenIsA = mint0.equals(a.mint)
    const tok = Number((tokenIsA ? bA : bB).value.uiAmountString), quote = Number((tokenIsA ? bB : bA).value.uiAmountString)
    return tok > 0 ? { price: quote / tok, supply: mint.supply } : null
  }, [w.conn, a.pool.toBase58(), a.graduated, w.refreshKey])
  const price = pool.data?.price ?? priceOf(stateOf(a), qd)
  const supply = pool.data?.supply ?? totalSupply
  return { price, supply, mcap: price * (Number(supply) / 10 ** TOKEN_DECIMALS), live: !!pool.data }
}

/** Market cap of the supply outside token locks (circulating), the figure the cards show. */
function unlockedShare(mcap: number, locked: bigint, supply: bigint) {
  if (locked <= 0n || supply <= 0n || locked > supply) return mcap
  return mcap * (Number(supply - locked) / Number(supply))
}

function mcapOf(s: CurveState, qd: number, totalSupply: bigint) {
  return priceOf(s, qd) * (Number(totalSupply) / 10 ** TOKEN_DECIMALS)
}

/** Market cap: in dollars (with the ACRUX figure beside it) for coins that trade in
 * ACRUX once ACRUX's dollar price is known; in the quote token otherwise. */
function Mcap({ mcap, quoteSym }: { mcap: number; quoteSym: string }) {
  const rate = useAcruxUsd()
  if (rate && quoteSym === 'ACRUX') return <span>MC <span className="coin-mcap">{usd(mcap * rate)}</span> <small className="faint">{compact(mcap)} ACRUX</small></span>
  return <span>MC <span className="coin-mcap">{compact(mcap)}</span> {quoteSym}</span>
}

function CoinCard({ l, quoteSym, qd, totalSupply, locked }: { l: LaunchRow; totalSupply: bigint; locked: bigint } & Quote) {
  const a = l.account
  const s = stateOf(a)
  const meta = useMeta(a.uri)
  const mk = useMarket(l, qd, totalSupply)
  return (
    <button className="coin-card" onClick={() => { location.hash = `#Launch/${l.publicKey.toBase58()}` }}>
      <CoinImage meta={meta} symbol={a.symbol} size={72} />
      <div className="coin-body">
        <div className="coin-title"><strong>{a.name}</strong><span className="tick">${a.symbol}</span></div>
        <div className="coin-meta"><Mcap mcap={unlockedShare(mk.mcap, locked, mk.supply)} quoteSym={quoteSym} /><span className="row" style={{ gap: 6 }}><LockTag locked={locked} totalSupply={mk.supply} /><Status a={a} s={s} /></span></div>
        <div className={`bar${a.graduated ? ' good' : ''}`}><div style={{ width: `${a.graduated ? 100 : curveProgress(s) * 100}%` }} /></div>
        {meta?.description ? <p className="coin-desc">{meta.description}</p> : <p className="coin-desc faint">by {short(a.creator)}</p>}
      </div>
    </button>
  )
}

function Feature({ l, quoteSym, qd, totalSupply }: { l: LaunchRow; totalSupply: bigint } & Quote) {
  const a = l.account
  const s = stateOf(a)
  const meta = useMeta(a.uri)
  const p = curveProgress(s)
  return (
    <button className="feature" onClick={() => { location.hash = `#Launch/${l.publicKey.toBase58()}` }}>
      <CoinImage meta={meta} symbol={a.symbol} size={84} />
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">Closest to graduating</div>
        <h2>{a.name} <span className="muted" style={{ fontSize: 14 }}>${a.symbol}</span></h2>
        <div className="coin-meta" style={{ justifyContent: 'flex-start', gap: 16, marginBottom: 8 }}>
          <Mcap mcap={mcapOf(s, qd, totalSupply)} quoteSym={quoteSym} />
          <span><span className="num">{fmt(s.realQuote, qd, 2)}</span> / <span className="num">{fmt(s.graduationQuote, qd, 0)}</span> {quoteSym} raised</span>
        </div>
        <div className="bar" style={{ maxWidth: 420 }}><div style={{ width: `${p * 100}%` }} /></div>
      </div>
      <span className="feature-cta pill cyan" style={{ fontSize: 12, padding: '6px 12px' }}>{(p * 100).toFixed(1)}% · Trade →</span>
    </button>
  )
}

// ------------------------------------------------------------------ coin page

function Coin({ l, quoteMint, quoteSym, qd, totalSupply, upgraded, paused }: { l: LaunchRow; totalSupply: bigint; upgraded: boolean; paused: boolean } & Quote) {
  const w = useWallet()
  const a = l.account
  const s = stateOf(a)
  const meta = useMeta(a.uri)
  const program = useMemo(() => launchpadFor(readProvider(w.conn), upgraded), [w.conn, upgraded])
  // Curve trades, then (once graduated) swaps in its pool, as one history.
  const trades = useAsync(async () => {
    const [curve, pool] = await Promise.all([
      loadTrades(w.conn, program, l.publicKey),
      a.graduated ? loadPoolTrades(w.conn, a.pool, a.mint).catch(() => []) : Promise.resolve([]),
    ])
    return [...curve, ...pool].sort((x, y) => x.time - y.time)
  }, [w.conn, program, l.publicKey.toBase58(), a.graduated, w.refreshKey])
  const curveBal = useAsync(async () => BigInt((await w.conn.getTokenAccountBalance(a.curveTokens)).value.amount), [w.conn, a.curveTokens.toBase58(), w.refreshKey])
  const [tab, setTab] = useState<'trades' | 'holders' | 'about'>('trades')
  const mk = useMarket(l, qd, totalSupply)
  const usdRate = useAcruxUsd() // ACRUX in dollars, for coins that trade in ACRUX
  const locked = useLocked(a.mint)
  const lockedPct = locked.data && mk.supply > 0n ? (Number(locked.data.total) / Number(mk.supply)) * 100 : 0
  // Market cap of what isn't locked (only shown when something is locked).
  const unlockedMcap = lockedPct > 0 ? mk.mcap * (1 - lockedPct / 100) : null

  const pts = useMemo(() => {
    const ts = trades.data ?? []
    const scale = 10 ** (TOKEN_DECIMALS - qd)
    const out = ts.map(t => ({ time: t.time, value: t.price * scale }))
    // Start the line at the opening price, a second before the first trade.
    if (ts.length) out.unshift({ time: ts[0].time - 1, value: openingPrice(ts[0], a.feeBps, ts[0].vq, ts[0].vt) * scale })
    return out
  }, [trades.data, qd])
  const now = mk.price
  // 24h change: against the last price at or before 24 hours ago. A coin younger than a day
  // has no such price, and "since launch" is a meaningless number (launch prices are tiny),
  // so it shows "–" until it has a day of history.
  const dayAgo = useMemo(() => {
    const scale = 10 ** (TOKEN_DECIMALS - qd)
    const cutoff = Date.now() / 1000 - 86_400
    let base: number | undefined
    for (const t of trades.data ?? []) { if (t.time <= cutoff) base = t.price * scale; else break }
    return base
  }, [trades.data, qd])
  const change = dayAgo ? (now / dayAgo - 1) * 100 : 0
  // Real balances from the chain; until they load (or if the read fails), fall back to curve trades.
  const chainHolders = useAsync(() => loadHolders(w.conn, a.mint, a.curveTokens, LOCKER_ID), [w.conn, a.mint.toBase58(), w.refreshKey])
  const holders = useMemo<Holder[]>(() => chainHolders.data ?? holdersFromTrades(trades.data ?? []).map(([owner, amount]) => ({ owner, amount, kind: 'wallet' as const })), [chainHolders.data, trades.data])
  const progress = curveProgress(s)

  return (
    <>
      <p style={{ margin: '0 0 14px' }}><a href="#Launch" className="muted">← Coins</a></p>
      <div className="coin-page">
        <div className="coin-main">
          <div className="coin-head">
            <CoinImage meta={meta} symbol={a.symbol} size={64} />
            <div style={{ minWidth: 0 }}>
              <h1>{a.name} <span className="tick">${a.symbol}</span> <Status a={a} s={s} /></h1>
              <div className="coin-sub">
                <span className="ca-row"><span className="mono">{short(a.mint, 6)}</span><CopyButton text={a.mint.toBase58()} /></span>
                <span>by <a href={`#Explorer/${a.creator.toBase58()}`} className="mono">{short(a.creator)}</a></span>
                <Links meta={meta} />
                {lockedPct > 0 && <a className="pill good" href={`#Locks/${a.mint.toBase58()}`} title="Tokens locked on chain until a date">🔒 {lockedPct.toFixed(lockedPct < 1 ? 2 : 1)}% locked</a>}
              </div>
            </div>
          </div>

          <div className={`stats${unlockedMcap != null ? ' stats-5' : ''}`}>
            {/* Market cap counts only what isn't in a token lock (circulating), as CoinGecko and
                DexScreener do; the whole supply at the same price is the FDV beside it. */}
            <div><span className="label" title={unlockedMcap != null ? 'Price × the supply that is not in a token lock (what can trade today)' : 'Price × supply'}>Market cap</span><span className="value">{usdRate && quoteSym === 'ACRUX' ? <>{usd((unlockedMcap ?? mk.mcap) * usdRate)}<small className="stat-sub">{compact(unlockedMcap ?? mk.mcap)} ACRUX</small></> : <>{compact(unlockedMcap ?? mk.mcap)} <small>{quoteSym}</small></>}</span></div>
            {unlockedMcap != null && (
              <div><span className="label" title="Fully diluted value: price × the whole supply, locked tokens included">FDV</span><span className="value">{usdRate && quoteSym === 'ACRUX' ? <>{usd(mk.mcap * usdRate)}<small className="stat-sub">{compact(mk.mcap)} ACRUX</small></> : <>{compact(mk.mcap)} <small>{quoteSym}</small></>}</span></div>
            )}
            <div><span className="label">Price</span><span className="value"><Price text={fmtPrice(now)} />{usdRate && quoteSym === 'ACRUX' && <small className="stat-sub">≈ {usd(now * usdRate)}</small>}</span></div>
            <div><span className="label" title={dayAgo ? 'Change over the last 24 hours' : 'Under a day old: shows once it has 24 hours of trading'}>24h</span><span className={`value ${change >= 0 ? 'up' : 'down'}`}>{dayAgo ?`${change >= 0 ? '+' : ''}${change.toFixed(1)}%` : '–'}</span></div>
            <div><span className="label">Trades</span><span className="value">{trades.data ? trades.data.length : '…'}</span></div>
          </div>

          <div className="card chart-card" style={{ marginBottom: 16 }}>
            <div className="chart-head"><small>Price in {quoteSym} per {a.symbol}</small><small>{a.graduated ? 'Bonding curve, then its pool' : 'Bonding curve'}</small></div>
            {trades.loading && !trades.data ? <div className="chart-empty">Loading trades…</div>
              : pts.length < 1 ? <div className="chart-empty">No trades yet: the first buy sets the chart off.</div>
              : <PriceChart points={pts} up={change >= 0} />}
          </div>

          <div className="card coin-tabs">
            <div className="tabs" role="tablist">
              {(['trades', 'holders', 'about'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t === 'trades' ? 'Trades' : t === 'holders' ? 'Holders' : 'About'}</button>)}
            </div>
            {tab === 'trades' && <TradesTable trades={trades.data ?? null} quoteSym={quoteSym} qd={qd} symbol={a.symbol} />}
            {tab === 'holders' && <Holders holders={holders} live={!!chainHolders.data} curve={curveBal.data ?? null} totalSupply={mk.supply} graduated={a.graduated} />}
            {tab === 'about' && (
              <div style={{ paddingTop: 12 }}>
                {meta?.description ? <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{meta.description}</p> : <p className="muted" style={{ marginTop: 0 }}>No description.</p>}
                <dl className="kv">
                  <dt>Supply</dt><dd>{fmt(mk.supply, TOKEN_DECIMALS, 0)}{a.graduated && mk.live ? ', unsold tokens burned at graduation' : ', fixed'}</dd>
                  <dt>Trade fee</dt><dd>{a.feeBps / 100}%</dd>
                  <dt>Pairs with</dt><dd>{quoteSym}</dd>
                  <dt>Locked</dt><dd>{locked.data?.count ? <>{lockedPct.toFixed(2)}% of supply in {locked.data.count} lock{locked.data.count === 1 ? '' : 's'}, first unlock {lockDate(locked.data.next!)}</> : 'none'} · <a href={`#Locks/${a.mint.toBase58()}`}>lock tokens</a></dd>
                  <dt>Mint</dt><dd><a href={`#Explorer/${a.mint.toBase58()}`}>{short(a.mint, 6)}</a></dd>
                  <dt>Launch account</dt><dd><a href={`#Explorer/${l.publicKey.toBase58()}`}>{short(l.publicKey, 6)}</a></dd>
                  {a.graduated && <><dt>Pool</dt><dd><a href={`#Explorer/${a.pool.toBase58()}`}>{short(a.pool, 6)}</a></dd></>}
                </dl>
              </div>
            )}
          </div>
        </div>

        <aside className="coin-side">
          <div className="card trade-card">
            {a.graduated ? <GraduatedNote pool={a.pool} mint={a.mint} />
              : a.complete ? <GraduatePanel a={a} quoteMint={quoteMint} paused={paused} upgraded={upgraded} />
              : <TradePanel l={l} s={s} quoteMint={quoteMint} quoteSym={quoteSym} qd={qd} paused={paused} upgraded={upgraded} />}
          </div>
          <div className="card progress-card">
            <div className="row" style={{ marginBottom: 8 }}><strong>Bonding curve</strong><span className="fixed pct">{a.graduated ? '100%' : `${(progress * 100).toFixed(1)}%`}</span></div>
            <div className={`bar${a.graduated ? ' good' : ''}`}><div style={{ width: `${a.graduated ? 100 : progress * 100}%` }} /></div>
            <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
              {a.graduated ? 'Graduated: its liquidity is locked in a pool forever (all LP burned).'
                : <>When <span className="num">{fmt(s.graduationQuote, qd, 0)}</span> {quoteSym} is raised, the coin graduates: the raised {quoteSym} and matching coins go into a pool at the curve's final price and the LP is burned, locking the liquidity forever. Raised so far: <span className="num">{fmt(s.realQuote, qd, 2)}</span> {quoteSym}.</>}
            </p>
          </div>
        </aside>
      </div>
    </>
  )
}

function Links({ meta }: { meta: CoinMeta | null }) {
  const links = [['X', safeUrl(meta?.links?.x)], ['Telegram', safeUrl(meta?.links?.telegram)], ['Website', safeUrl(meta?.links?.website)]].filter(([, u]) => u) as [string, string][]
  if (!links.length) return null
  return <span className="links">{links.map(([label, url]) => <a key={label} className="pill" href={url} target="_blank" rel="noopener noreferrer nofollow">{label} ↗</a>)}</span>
}

function TradesTable({ trades, quoteSym, qd, symbol }: { trades: Trade[] | null; quoteSym: string; qd: number; symbol: string }) {
  if (!trades) return <p className="muted" style={{ padding: '16px 0' }}>Loading trades…</p>
  if (!trades.length) return <p className="muted" style={{ padding: '16px 0' }}>No trades yet.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Account</th><th>Type</th><th style={{ textAlign: 'right' }}>{quoteSym}</th><th style={{ textAlign: 'right' }}>{symbol}</th><th style={{ textAlign: 'right' }}>Age</th></tr></thead>
        <tbody>
          {[...trades].reverse().slice(0, 100).map(t => (
            <tr key={t.sig + t.buy} className={t.buy ? 'trade-row-buy' : 'trade-row-sell'}>
              <td><a href={`#Explorer/${t.user}`} className="mono">{short(t.user)}</a></td>
              <td className="side">{t.buy ? 'Buy' : 'Sell'}</td>
              <td className="num" style={{ textAlign: 'right' }}>{fmt(t.quote, qd, 4)}</td>
              <td className="num" style={{ textAlign: 'right' }}>{compact(Number(t.tokens) / 10 ** TOKEN_DECIMALS)}</td>
              <td style={{ textAlign: 'right' }}><a href={`#Explorer/${t.sig}`} className="muted">{ago(t.time)}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Holders({ holders, live, curve, totalSupply, graduated }: { holders: Holder[]; live: boolean; curve: bigint | null; totalSupply: bigint; graduated: boolean }) {
  const pct = (v: bigint) => `${((Number(v) / Number(totalSupply)) * 100).toFixed(2)}%`
  const wallets = holders.filter(h => h.kind === 'wallet')
  const shown = live ? holders : [...(curve != null && !graduated ? [{ owner: 'curve', amount: curve, kind: 'curve' as const }] : []), ...holders]
  const name = (h: Holder) => h.kind === 'curve' ? 'Bonding curve' : h.kind === 'lock' ? '🔒 Token locks' : h.kind === 'pool' ? 'Liquidity pool' : null
  let rank = 0
  return (
    <div className="holders" style={{ paddingTop: 6 }}>
      <p className="muted" style={{ margin: '0 0 8px' }}><strong className="num" style={{ color: 'var(--text)' }}>{wallets.length}</strong> holder{wallets.length === 1 ? '' : 's'}</p>
      <ol>
        {shown.slice(0, 25).map(h => {
          const label = name(h)
          return (
            <li key={h.kind + h.owner}>
              <span>{label
                ? <span className="muted">{label}</span>
                : <><span className="faint num" style={{ marginRight: 8 }}>{++rank}.</span><a href={`#Explorer/${h.owner}`} className="mono">{short(h.owner)}</a></>}</span>
              <span className="num">{pct(h.amount)}</span>
            </li>
          )
        })}
      </ol>
      {!shown.length && <p className="muted">No holders yet.</p>}
      <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>{live ? 'Live balances from the chain.' : 'Loading live balances… showing curve buys and sells for now.'}</p>
    </div>
  )
}

function TradePanel({ l, s, quoteMint, quoteSym, qd, paused, upgraded }: { l: LaunchRow; s: CurveState; paused: boolean; upgraded: boolean } & Quote) {
  const w = useWallet()
  const a = l.account
  // Links from the bot: #Launch/<CA>/sell, #Launch/<CA>/buy/<amount>.
  const linkParts = location.hash.split('/').slice(2)
  const [side, setSide] = useState<'buy' | 'sell'>(linkParts.includes('sell') ? 'sell' : 'buy')
  const [amt, setAmt] = useState(linkParts.find(p => /^\d+(\.\d+)?$/.test(p)) ?? '')
  const [slip, setSlip] = useState(1)
  const raw = parseAmount(amt, side === 'buy' ? qd : TOKEN_DECIMALS)
  // Platform-token holders pay a smaller trade fee (upgraded launchpad only).
  const holder = useAsync(async () => (upgraded && w.publicKey ? holderStatus(w.conn, launchpadFor(w.provider ?? readProvider(w.conn), true), w.publicKey) : null), [upgraded, w.publicKey?.toBase58(), w.conn, w.refreshKey])
  // Curve trades are priced by the program, which only counts the wallet's own tokens.
  const discount = holder.data?.chainDiscountBps ?? 0
  const sd = useMemo(() => ({ ...s, feeBps: discountedFeeBps(s.feeBps, discount) }), [s, discount])
  const q = useMemo(() => (raw ? (side === 'buy' ? curveBuy(sd, raw) : curveSell(sd, raw)) : null), [raw, side, l, sd])
  const fee = a.feeRecipient as PublicKey
  const bal = useAsync(async () => {
    if (!w.publicKey) return null
    const get = async (m: PublicKey) => { try { return BigInt((await w.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(m, w.publicKey!))).value.amount) } catch { return 0n } }
    const [qb, tb] = await Promise.all([get(quoteMint), get(a.mint)])
    return { quote: await spendable(w.conn, w.publicKey, quoteMint, qb), tokens: tb }
  }, [w.publicKey, w.conn, w.refreshKey, quoteMint.toBase58()])
  const plain = (v: bigint, d: number) => fmt(v, d, d).replace(/,/g, '')
  const chips: [string, () => void][] = side === 'buy'
    ? [['1', () => setAmt('1')], ['5', () => setAmt('5')], ['10', () => setAmt('10')], ...(bal.data ? [['Max', () => setAmt(plain(bal.data!.quote, qd))] as [string, () => void]] : [])]
    : bal.data ? ([25, 50, 75, 100].map(p => [`${p}%`, () => setAmt(plain((bal.data!.tokens * BigInt(p)) / 100n, TOKEN_DECIMALS))]) as [string, () => void][]) : []

  const accounts = () => ({
    user: w.publicKey!, launch: l.publicKey, mint: a.mint, quoteMint, curveTokens: a.curveTokens, curveQuote: a.curveQuote,
    userTokens: getAssociatedTokenAddressSync(a.mint, w.publicKey!),
    userQuote: getAssociatedTokenAddressSync(quoteMint, w.publicKey!),
    feeQuote: getAssociatedTokenAddressSync(quoteMint, fee, true),
    ...(upgraded ? { holderTokens: holder.data?.account ?? null } : {}),
  })
  const pre = () => [
    createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, fee, true), fee, quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, w.publicKey!), w.publicKey!, quoteMint),
  ]
  const minOut = (v: bigint) => (v * BigInt(10_000 - Math.round(slip * 100))) / 10_000n

  return (
    <>
      <div className="side-toggle">
        <button className={side === 'buy' ? 'buy-on' : ''} onClick={() => { setSide('buy'); setAmt('') }}>Buy</button>
        <button className={side === 'sell' ? 'sell-on' : ''} onClick={() => { setSide('sell'); setAmt('') }}>Sell</button>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <small>{side === 'buy' ? 'You pay (fee included)' : 'You sell'}</small>
        {bal.data && <small className="fixed">You can spend <span className="num" style={{ color: 'var(--text)' }}>{side === 'buy' ? fmt(bal.data.quote, qd, 4) : fmt(bal.data.tokens, TOKEN_DECIMALS, 2)}</span> {side === 'buy' ? quoteSym : a.symbol}</small>}
      </div>
      <div className="amount-box">
        <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0.0" aria-label="Amount" />
        <span className="unit">{side === 'buy' ? quoteSym : a.symbol}</span>
      </div>
      {!!chips.length && <div className="chips">{chips.map(([label, f]) => <button key={label} onClick={f}>{label}</button>)}</div>}
      <div className="quote-line">
        <span>You get</span>
        <strong>{q ? ('tokensOut' in q ? `${fmt(q.tokensOut, TOKEN_DECIMALS, 2)} ${a.symbol}` : `${fmt(q.quoteOut, qd, 4)} ${quoteSym}`) : '–'}</strong>
      </div>
      {q && 'completes' in q && q.completes && <p className="ok" style={{ marginTop: -6 }}>This buy completes the curve.</p>}
      <div className="quote-line" style={{ marginTop: -6 }}>
        <span>Trade fee</span>
        <span>{discount > 0
          ? <><s className="faint">{s.feeBps / 100}%</s> <strong className="up">{sd.feeBps / 100}%</strong> <small className="muted">{holder.data?.tierName ?? 'holder'} tier</small></>
          : <>{s.feeBps / 100}%</>}</span>
      </div>
      <div className="quote-line" style={{ marginTop: -6 }}>
        <span>Max slippage</span>
        <span className="seg" style={{ padding: 2 }}>{[0.5, 1, 3].map(v => <button key={v} className={slip === v ? 'on' : ''} style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setSlip(v)}>{v}%</button>)}</span>
      </div>
      <Action
        label={w.publicKey ? (side === 'buy' ? `Buy ${a.symbol}` : `Sell ${a.symbol}`) : 'Connect a wallet to trade'}
        primary={false}
        disabled={!w.publicKey || !q || paused}
        className={side === 'buy' ? 'buy' : 'sell'}
        run={async () => {
          const lp = launchpadFor(w.provider!, upgraded)
          const wrap = side === 'buy' ? await wrapFor(w.conn, w.provider!, w.publicKey!, quoteMint, (q as any).quoteToCurve + (q as any).fee) : []
          const tx = side === 'buy'
            ? await lp.methods.buy(new BN(raw!.toString()), new BN(minOut((q as any).tokensOut).toString())).accountsPartial(accounts()).preInstructions([...pre(), ...wrap]).transaction()
            : await lp.methods.sell(new BN(raw!.toString()), new BN(minOut((q as any).quoteOut).toString())).accountsPartial(accounts()).preInstructions(pre()).transaction()
          const sig = await w.send(tx)
          setAmt('')
          w.bump()
          return `${side === 'buy' ? 'Bought' : 'Sold'}. ${sig}`
        }}
      />
      {w.privateMode && <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>Sent sealed 2-of-3: no single proposer can read it before it's ordered.</p>}
    </>
  )
}

/** Which kind of pool a graduated coin went to, read from the pool account's owner. */
function GraduatedNote({ pool, mint }: { pool: PublicKey; mint: PublicKey }) {
  const w = useWallet()
  const owner = useAsync(async () => (await w.conn.getAccountInfo(pool))?.owner ?? null, [pool.toBase58(), w.conn])
  const venue = owner.data?.equals(RAYDIUM_CPMM_ID) ? 'a Raydium CPMM pool' : 'the AcruxHub DEX'
  return (
    <>
      <strong>Graduated</strong>
      <p className="muted" style={{ margin: '6px 0 14px', fontSize: 13 }}>Trading on {owner.loading ? 'its pool' : venue}, with the liquidity locked forever.</p>
      <button className="primary" style={{ width: '100%' }} onClick={() => { location.hash = `#Swap/${mint.toBase58()}` }}>Trade on Swap</button>
    </>
  )
}

/** A completed curve can graduate into either venue, once. */
function GraduatePanel({ a, quoteMint, paused, upgraded }: { a: any; quoteMint: PublicKey; paused: boolean; upgraded: boolean }) {
  const w = useWallet()
  const [venue, setVenue] = useState<'raydium' | 'acruxhub'>('raydium')
  const tiers = useAsync(() => loadCpmmFeeTiers(w.conn), [w.conn])
  // The program refuses tiers over 1% or with pool creation disabled.
  const allowed = (tiers.data ?? []).filter(t => !t.disableCreatePool && t.tradeFeeRate <= 10_000n)
  const [tierIdx, setTierIdx] = useState('0')
  const tier = allowed.find(t => String(t.index) === tierIdx) ?? allowed[0]
  const rent = useAsync(async () => {
    const sizes = [CPMM_POOL_SIZE, 4075, 165, 165, 82]
    return (await Promise.all(sizes.map(n => w.conn.getMinimumBalanceForRentExemption(n)))).reduce((s, x) => s + BigInt(x), 0n)
  }, [w.conn])
  const acrux = useAsync(async () => (w.publicKey ? BigInt(await w.conn.getBalance(w.publicKey)) : null), [w.publicKey, w.conn, w.refreshKey])
  // Raydium pool addresses are fixed per tier + pair, so someone may have made this one already.
  const taken = useAsync(async () => {
    if (!tier) return false
    return !!(await w.conn.getAccountInfo(cpmmPoolAddresses(tier.address, a.mint, quoteMint).pool))
  }, [tier?.address.toBase58(), a.mint.toBase58(), w.conn, w.refreshKey])
  const cost = tier && rent.data != null ? tier.createPoolFee + rent.data : null
  const short_ = acrux.data != null && cost != null && acrux.data < cost + 20_000_000n
  const pctOf = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(ppm % 100n ? 3 : 2)}%`

  return (
    <>
      <strong>Ready to graduate</strong>
      <p className="muted" style={{ margin: '6px 0 14px', fontSize: 13 }}>
        The curve is full. Anyone can graduate it, once: the raised quote and matching coins go into a pool at the curve's final price, the LP is burned and leftover coins are burned.
      </p>
      <div className="side-toggle">
        <button className={venue === 'raydium' ? 'buy-on' : ''} onClick={() => setVenue('raydium')}>Raydium pool</button>
        <button className={venue === 'acruxhub' ? 'buy-on' : ''} onClick={() => setVenue('acruxhub')}>AcruxHub DEX</button>
      </div>
      {venue === 'raydium' ? (
        <>
          <div className="field">
            <label>Raydium fee tier</label>
            <select value={tier ? String(tier.index) : ''} onChange={e => setTierIdx(e.target.value)} disabled={!allowed.length}>
              {allowed.map(t => <option key={t.index} value={String(t.index)}>{pctOf(t.tradeFeeRate)} trade fee (tier {t.index})</option>)}
            </select>
          </div>
          <dl className="kv" style={{ marginBottom: 12 }}>
            <dt>You pay</dt><dd>{cost != null && tier ? `${fmt(cost, 9, 4)} ACRUX` : '–'}</dd>
            {acrux.data != null && <><dt>Your ACRUX</dt><dd>{fmt(acrux.data, 9, 4)}</dd></>}
          </dl>
          {taken.data && <p className="error">A Raydium pool for this coin already exists on this tier. Pick another tier, or graduate to the AcruxHub DEX.</p>}
          {short_ && <p className="error">You need about {cost != null ? fmt(cost + 20_000_000n, 9, 3) : '0.21'} ACRUX for this.</p>}
          <Action
            label="Graduate to Raydium"
            disabled={!w.publicKey || !tier || !!taken.data || short_ || paused}
            run={async () => {
              const lp = launchpadFor(w.provider!, upgraded)
              const tx = await lp.methods.graduateRaydium()
                .accountsPartial({ payer: w.publicKey!, ...graduateRaydiumAccounts(a, quoteMint, tier!.address) })
                .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
                .transaction()
              const sig = await w.send(tx)
              w.bump()
              return `Graduated into a Raydium pool. ${sig}`
            }}
          />
          <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>Includes Raydium's 0.15 ACRUX pool fee and the pool's rent. About 16% of a Raydium pool's trading fee goes to Raydium.</p>
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>An AcruxHub AMM pool with a 0.30% fee. You pay only the pool's rent, and every trading fee stays in the pool.</p>
          <Action
            label="Graduate to AcruxHub DEX"
            disabled={!w.publicKey || paused}
            run={async () => {
              const lp = launchpadFor(w.provider!, upgraded)
              const tx = await lp.methods.graduate()
                .accountsPartial({ payer: w.publicKey!, ...graduateAccounts(a, quoteMint) })
                .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
                .transaction()
              const sig = await w.send(tx)
              w.bump()
              return `Graduated. ${sig}`
            }}
          />
        </>
      )}
    </>
  )
}

// ------------------------------------------------------------------ create

function freshCurve(params: any): CurveState {
  return {
    virtualQuote: BigInt(params.virtualQuote.toString()),
    virtualTokens: BigInt(params.virtualTokens.toString()),
    realQuote: 0n,
    realTokens: BigInt(params.curveSupply.toString()),
    graduationQuote: BigInt(params.graduationQuote.toString()),
    feeBps: params.feeBps,
  }
}

type Pair = { mint: PublicKey; params: any; isDefault: boolean; sym: string; decimals: number }

function Create({ pairs, upgraded, onDone }: { pairs: Pair[]; upgraded: boolean; onDone: (key?: string) => void }) {
  const w = useWallet()
  const [pairIdx, setPairIdx] = useState(0)
  const pair = pairs[Math.min(pairIdx, pairs.length - 1)]
  const { mint: quoteMint, params, sym: quoteSym, decimals: qd } = pair
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState<string | null>(null)
  const [showLinks, setShowLinks] = useState(false)
  const [x, setX] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [firstBuy, setFirstBuy] = useState('')
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // HUB holders get their tier's discount on the launch buy too (the program checks the
  // HUB account passed as holderTokens, so it has to be passed here as on a coin's page).
  const holder = useAsync(async () => (upgraded && w.publicKey ? holderStatus(w.conn, launchpadFor(w.provider ?? readProvider(w.conn), true), w.publicKey) : null), [upgraded, w.publicKey?.toBase58(), w.conn, w.refreshKey])
  const holderDiscount = holder.data?.chainDiscountBps ?? 0
  const buyRaw = firstBuy ? parseAmount(firstBuy, qd) : 0n
  const buyQuote = buyRaw ? curveBuy(freshCurve(params), buyRaw) : null
  const pick = (f: File | undefined) => {
    if (!f) return
    setImgErr(null)
    readImage(f).then(setImage, e => setImgErr(e.message))
  }

  return (
    <div className="create">
      <p style={{ margin: '0 0 14px' }}><a href="#Launch" className="muted">← Coins</a></p>
      <div className="page-head"><div><h1>Create a coin</h1><p>One transaction. Fixed supply, no presale, no creator allocation.</p></div></div>
      <div className="card">
        <div
          className={`dropzone${drag ? ' over' : ''}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]) }}
          role="button"
          tabIndex={0}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
        >
          {image ? <img src={image} alt="Coin image preview" /> : <span><strong style={{ color: 'var(--text)' }}>Drop an image or click to upload</strong><br /><small>PNG, JPG, GIF or WebP · up to 1 MB · square looks best</small></span>}
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={e => pick(e.target.files?.[0])} />
        </div>
        {imgErr && <p className="error">{imgErr}</p>}

        <div className="row">
          <div className="field"><label>Name</label><input maxLength={32} value={name} onChange={e => setName(e.target.value)} placeholder="My Coin" /></div>
          <div className="field fixed" style={{ width: 140 }}><label>Ticker</label><input maxLength={10} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9$]/g, ''))} placeholder="COIN" /></div>
        </div>
        <div className="field"><label>Description</label><textarea rows={3} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="What's it about?" /></div>

        <button className="link-toggle" onClick={() => setShowLinks(v => !v)}>{showLinks ? '− Hide links' : '+ Add social links (optional)'}</button>
        {showLinks && (
          <>
            <div className="field"><label>X</label><input value={x} onChange={e => setX(e.target.value)} placeholder="@handle or x.com/handle" /></div>
            <div className="field"><label>Telegram</label><input value={telegram} onChange={e => setTelegram(e.target.value)} placeholder="t.me/group" /></div>
            <div className="field"><label>Website</label><input value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://…" /></div>
          </>
        )}

        {pairs.length > 1 && (
          <div className="field">
            <label>Pair with</label>
            <select value={String(pairIdx)} onChange={e => { setPairIdx(Number(e.target.value)); setFirstBuy('') }}>
              {pairs.map((p, i) => <option key={p.mint.toBase58()} value={String(i)}>{p.sym}{p.isDefault ? ' (default)' : ''}</option>)}
            </select>
            <small>Your coin's curve, and its pool after graduation, trade against this token. You can't change it later.</small>
          </div>
        )}

        <div className="field">
          <label>Buy at launch (optional)</label>
          <div className="amount-box">
            <input inputMode="decimal" value={firstBuy} onChange={e => setFirstBuy(e.target.value)} placeholder="0" />
            <span className="unit">{quoteSym}</span>
          </div>
          {buyQuote && <small>≈ {fmt(buyQuote.tokensOut, TOKEN_DECIMALS, 0)} {symbol || 'coins'} at the opening price, same terms as everyone else</small>}
        </div>

        <dl className="kv" style={{ margin: '4px 0 16px' }}>
          <dt>Supply</dt><dd>{fmt(BigInt(params.totalSupply.toString()), TOKEN_DECIMALS, 0)}, fixed</dd>
          <dt>Graduates at</dt><dd>{fmt(BigInt(params.graduationQuote.toString()), qd)} {quoteSym} raised</dd>
          <dt>Trade fee</dt><dd>{holderDiscount > 0
            ? <><s className="faint">{params.feeBps / 100}%</s> <strong className="up">{discountedFeeBps(params.feeBps, holderDiscount) / 100}%</strong> <small className="muted">{holder.data?.tierName ?? 'holder'} tier</small></>
            : <>{params.feeBps / 100}%</>}</dd>
          <dt>Cost to create</dt><dd>network fees only</dd>
        </dl>

        <Action
          label={w.publicKey ? 'Create coin' : 'Connect a wallet to create'}
          disabled={!w.publicKey || !name || !symbol || !image || (firstBuy !== '' && !buyQuote)}
          run={async () => {
            const { uri } = await uploadCoin({ name, symbol, description, image: image!, x, telegram, website })
            const lp = launchpadFor(w.provider!, upgraded)
            const mint = Keypair.generate()
            const launch = launchAddress(mint.publicKey)
            const createAccounts: any = { creator: w.publicKey!, config: launchConfig(), mint: mint.publicKey, quoteMint }
            // The upgraded launchpad takes an optional pair account (null = the default quote).
            if (upgraded) createAccounts.quotePair = pair.isDefault ? null : launchPairAddress(quoteMint)
            const create = await lp.methods.createLaunch(name, symbol, uri).accountsPartial(createAccounts).instruction()
            const feeRecipient = params.feeRecipient as PublicKey
            const post = buyQuote
              ? [
                  createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, feeRecipient, true), feeRecipient, quoteMint),
                  ...(await wrapFor(w.conn, w.provider!, w.publicKey!, quoteMint, buyQuote.quoteToCurve + buyQuote.fee)),
                  await lp.methods.buy(new BN(buyRaw!.toString()), new BN(buyQuote.tokensOut.toString()))
                    .accountsPartial({
                      user: w.publicKey!, launch, mint: mint.publicKey, quoteMint,
                      curveTokens: getAssociatedTokenAddressSync(mint.publicKey, launch, true),
                      curveQuote: getAssociatedTokenAddressSync(quoteMint, launch, true),
                      userTokens: getAssociatedTokenAddressSync(mint.publicKey, w.publicKey!),
                      userQuote: getAssociatedTokenAddressSync(quoteMint, w.publicKey!),
                      feeQuote: getAssociatedTokenAddressSync(quoteMint, feeRecipient, true),
                      ...(upgraded ? { holderTokens: (await holderStatus(w.conn, lp, w.publicKey!)).account } : {}),
                    })
                    .instruction(),
                ]
              : []
            const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), create, ...post)
            await w.send(tx, [mint])
            w.bump()
            onDone(launch.toBase58())
          }}
        />
      </div>
    </div>
  )
}
