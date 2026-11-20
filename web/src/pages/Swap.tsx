import { useEffect, useMemo, useState } from 'react'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ammProgram, minOut, launchAddress, platformFee, routedSwapInstructions, PLATFORM_FEE_BPS, holderStatus, discountedFeeBps, launchpadProgram } from '@acruxhub/sdk'
import { useWallet, readProvider } from '../wallet.tsx'
import { useAsync, tokenLabel } from '../hooks.ts'
import { loadMarkets, launchSymbols, marketQuote, marketName, type Market } from '../data.ts'
import { fmt, parseAmount } from '../net.ts'
import { Action, Empty } from '../ui.tsx'
import { wrapFor, spendable } from '../wrap.ts'

const pairKey = (m: Market) => `${m.mintA.toBase58()}|${m.mintB.toBase58()}`
const pct = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(2)}%`

export function Swap() {
  const w = useWallet()
  const markets = useAsync(() => loadMarkets(w.conn), [w.conn, w.refreshKey])
  const symbols = useAsync(() => launchSymbols(w.conn), [w.conn])
  const [pairSel, setPairSel] = useState<string | null>(null)
  const [aToB, setAToB] = useState(true)
  const [amount, setAmount] = useState('')
  const [slip, setSlip] = useState('0.5')
  // How the last successful swap went out, for the note under the result.
  const [lastSend, setLastSend] = useState<'private' | 'public' | null>(null)
  const label = (m: { toBase58(): string }) => tokenLabel(m.toBase58(), symbols.data)

  // Every pair, with all the markets (AcruxHub and Raydium pools) that trade it.
  const pairs = useMemo(() => {
    const g = new Map<string, Market[]>()
    for (const m of markets.data ?? []) g.set(pairKey(m), [...(g.get(pairKey(m)) ?? []), m])
    return [...g.entries()].map(([key, ms]) => ({ key, markets: ms, mintA: ms[0].mintA, mintB: ms[0].mintB }))
  }, [markets.data])

  // Paste a contract address (CA): find its pools and set up a buy of that token.
  const [ca, setCa] = useState(() => decodeURIComponent(location.hash.split('/')[1] ?? ''))
  const caKey = useMemo(() => { try { return ca.trim() ? new PublicKey(ca.trim()) : null } catch { return null } }, [ca])
  const caPairs = useMemo(
    () => (caKey ? pairs.filter(p => p.mintA.equals(caKey) || p.mintB.equals(caKey)) : []),
    [caKey, pairs],
  )
  useEffect(() => {
    if (!caKey || !caPairs.length) return
    // The pair holding the most of the pasted token, across all its pools.
    const depth = (p: (typeof caPairs)[number]) => p.markets.reduce((s, m) => s + (m.mintA.equals(caKey) ? m.reserveA : m.reserveB), 0n)
    const best = [...caPairs].sort((x, y) => (depth(x) === depth(y) ? 0 : depth(x) > depth(y) ? -1 : 1))[0]
    setPairSel(best.key)
    setAToB(!best.mintA.equals(caKey)) // receive the pasted token
    setAmount('')
  }, [caKey, caPairs])
  const onCurve = useAsync(async () => {
    if (!caKey || caPairs.length) return null
    const launch = launchAddress(caKey)
    return (await w.conn.getAccountInfo(launch)) ? launch.toBase58() : null
  }, [caKey?.toBase58(), caPairs.length, w.conn])

  const pair = pairs.find(p => p.key === pairSel) ?? pairs[0]
  const first = pair?.markets[0]
  const inMint = pair ? (aToB ? pair.mintA : pair.mintB) : null
  const outMint = pair ? (aToB ? pair.mintB : pair.mintA) : null
  const inProgram = first ? (aToB ? first.programA : first.programB) : null
  const inDec = first ? (aToB ? first.decimalsA : first.decimalsB) : 6
  const outDec = first ? (aToB ? first.decimalsB : first.decimalsA) : 6
  const raw = parseAmount(amount, inDec)
  const slipBps = Math.round(Number(slip) * 100)
  const feeTo = w.network.feeRecipient
  // Platform-token holders get the same tiered discount on AcruxHub's swap fee.
  const holder = useAsync(async () => (w.publicKey ? holderStatus(w.conn, launchpadProgram(readProvider(w.conn)), w.publicKey) : null), [w.publicKey?.toBase58(), w.conn, w.refreshKey])
  const discount = holder.data?.discountBps ?? 0
  const feeBps = discountedFeeBps(PLATFORM_FEE_BPS, discount)
  const split = raw ? platformFee(raw, feeTo ? feeBps : 0) : null

  // Quote every market for this pair and route to the one that pays the most.
  const routes = useMemo(() => {
    if (!pair || !split || split.net <= 0n) return []
    return pair.markets
      .map(m => ({ m, out: m.swapEnabled ? marketQuote(m, split.net, aToB) : 0n }))
      .sort((x, y) => (x.out === y.out ? 0 : x.out > y.out ? -1 : 1))
  }, [pair, split?.net, aToB])
  const best = routes[0]?.out ? routes[0] : null
  const impactBps = useMemo(() => {
    if (!best || !split) return 0
    const [ri, ro] = aToB ? [best.m.reserveA, best.m.reserveB] : [best.m.reserveB, best.m.reserveA]
    const ideal = (split.net * ro) / ri
    return ideal > 0n ? Number(((ideal - best.out) * 10_000n) / ideal) : 0
  }, [best, split?.net, aToB])

  const balIn = useAsync(async () => {
    if (!w.publicKey || !inMint || !inProgram) return null
    let wrapped = 0n
    try {
      wrapped = BigInt((await w.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(inMint, w.publicKey, false, inProgram))).value.amount)
    } catch { /* no account yet */ }
    // Paying in ACRUX: native ACRUX counts too, it's wrapped as part of the swap.
    return spendable(w.conn, w.publicKey, inMint, wrapped)
  }, [w.publicKey, inMint?.toBase58(), w.refreshKey])

  if (markets.loading && !markets.data) return <div className="card narrow">Loading pools…</div>
  if (markets.error) return <div className="card narrow"><Empty>Could not load pools: {markets.error}</Empty></div>
  if (!pairs.length) return <div className="card narrow"><h2>Swap</h2><Empty>No pools yet. Create one on the Pools tab.</Empty></div>

  const caPoolCount = caPairs.reduce((n, p) => n + p.markets.length, 0)
  return (
    <div className="narrow">
    <div className="page-head"><div><h1>Swap</h1><p>Best price across AcruxHub and Raydium pools, sealed against front-running.</p></div></div>
    <div className="card">
      <div className="field">
        <label>Token address (CA)</label>
        <input
          className="mono"
          value={ca}
          onChange={e => setCa(e.target.value)}
          onPaste={e => { const t = e.clipboardData.getData('text').trim(); if (t) { e.preventDefault(); setCa(t) } }}
          placeholder="Paste a token's CA to find its pools"
          spellCheck={false}
        />
        {ca.trim() && !caKey && <small className="error">That isn't a valid address.</small>}
        {caKey && caPoolCount > 0 && (
          <small className="ok">
            Found {label(caKey)}: {caPoolCount} pool{caPoolCount > 1 ? 's' : ''} ({[...new Set(caPairs.flatMap(p => p.markets.map(marketName)))].join(' + ')}), set up to buy it.
          </small>
        )}
        {caKey && !caPairs.length && onCurve.data && (
          <small>This coin is still on its launch curve. <a href={`#Launch/${onCurve.data}`}>Buy it on its coin page →</a></small>
        )}
        {caKey && !caPairs.length && !onCurve.loading && !onCurve.data && (
          <small className="muted">No pool for this token yet. <a href="#Pools">Create one on Pools →</a></small>
        )}
      </div>
      <div className="field">
        <label>Pair</label>
        <select value={pair?.key} onChange={e => setPairSel(e.target.value)}>
          {pairs.map(p => (
            <option key={p.key} value={p.key}>
              {label(p.mintA)} / {label(p.mintB)} · {p.markets.map(m => `${m.kind === 'raydium' ? 'Raydium' : 'AcruxHub'} ${pct(m.feePpm)}`).join(', ')}
            </option>
          ))}
        </select>
      </div>
      {pair && inMint && outMint && (
        <>
          <div className="token-box">
            <div className="token-box-head"><span>You pay</span>{balIn.data != null && <button className="ghost bal" onClick={() => setAmount(fmt(balIn.data!, inDec, inDec).replace(/,/g, ''))}>Balance <span className="num">{fmt(balIn.data, inDec)}</span></button>}</div>
            <div className="token-box-row">
              <input inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value)} aria-label="Amount to pay" />
              <span className="token-badge">{label(inMint)}</span>
            </div>
          </div>
          <button className="flip" title="Flip direction" aria-label="Flip direction" onClick={() => setAToB(d => !d)}>⇅</button>
          <div className="token-box">
            <div className="token-box-head"><span>You receive</span></div>
            <div className="token-box-row">
              <input readOnly value={best ? fmt(best.out, outDec) : ''} placeholder="0.0" aria-label="Amount received" />
              <span className="token-badge">{label(outMint)}</span>
            </div>
          </div>
          <div className="quote-line" style={{ margin: '12px 0' }}>
            <span>Max slippage</span>
            <span className="seg" style={{ padding: 2 }}>{['0.5', '1', '3'].map(v => <button key={v} className={slip === v ? 'on' : ''} style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setSlip(v)}>{v}%</button>)}</span>
          </div>
          <div className="details">
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Route</dt><dd>{best ? <>{marketName(best.m)} <span className="muted">{pct(best.m.feePpm)}</span></> : '–'}</dd>
              <dt>Price impact</dt><dd>{best ? (impactBps / 100).toFixed(2) + '%' : '–'}</dd>
              <dt>Min received</dt><dd>{best ? fmt(minOut(best.out, slipBps), outDec) : '–'}</dd>
              {feeTo && <><dt>AcruxHub fee</dt><dd>{split ? `${fmt(split.fee, inDec)} ${label(inMint)}` : `${feeBps / 100}%`}{discount > 0 && <small className="up"> {holder.data?.tierName ?? 'holder'} tier, {discount / 100}% off</small>}</dd></>}
              <dt>Send</dt><dd>{w.privateMode ? <span className="pill good">private</span> : <span className="pill">public</span>}</dd>
            </dl>
          </div>
          {routes.length > 1 && (
            <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
              Compared {routes.length} pools:{' '}
              {routes.map(({ m, out }, i) => (
                <span key={m.address.toBase58()}>
                  {i > 0 && ' · '}{marketName(m)} {pct(m.feePpm)}: {m.swapEnabled ? `${fmt(out, outDec)} ${label(outMint)}` : (m.note ?? 'unavailable')}
                  {best && m === best.m && ' ✓'}
                </span>
              ))}
            </div>
          )}
          <Action
            label={w.publicKey ? 'Swap' : 'Connect a wallet'}
            disabled={!w.publicKey || !best || !split || !(slipBps >= 0 && slipBps <= 5000)}
            run={async () => {
              setLastSend(null)
              const { ixs } = await routedSwapInstructions({
                market: best!.m, user: w.publicKey!, aToB, amountIn: raw!, minOut: minOut(best!.out, slipBps),
                feeRecipient: feeTo, feeBps, amm: ammProgram(w.provider!), deadlineSlot: (await w.conn.getSlot()) + 300,
              })
              const m = best!.m
              const wrap = await wrapFor(w.conn, w.provider!, w.publicKey!, inMint!, raw!)
              const tx = new Transaction().add(...wrap, ...ixs)
              const sealed = w.privateMode
              const sig = await w.send(tx)
              setLastSend(sealed ? 'private' : 'public')
              setAmount('')
              w.bump()
              return `Swapped via ${marketName(m)}. ${sig}`
            }}
          />
          {lastSend === 'private' && (
            <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              🔒 Sealed 2-of-3: no single proposer could read this swap before it was ordered, so no one proposer could sandwich it.{' '}
              <a href="https://acrux.computer/replay" target="_blank" rel="noreferrer">See what sandwiches cost real Solana users →</a>
            </p>
          )}
          {lastSend === 'public' && (
            <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              This swap went out as a public send. Turn on private sends to seal your next one.
            </p>
          )}
        </>
      )}
    </div>
    <p className="faint" style={{ fontSize: 12, margin: '12px 4px 0' }}>
      Every pool for the pair is checked, AcruxHub's and Raydium's, and your swap goes to the one that pays the most.
      {feeTo && <> A {PLATFORM_FEE_BPS / 100}% AcruxHub fee comes out of what you pay, on top of the pool's fee.</>} Private sends are split 2-of-3 across the slot's proposers, so no single one can read your swap and trade ahead of it. <a href="#Docs/swapping">How it works</a>
    </p>
    </div>
  )
}
