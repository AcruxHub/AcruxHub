import { useEffect, useMemo, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ammProgram, swapQuote, minOut, launchAddress, BN } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync, tokenLabel } from '../hooks.ts'
import { loadPools, launchSymbols } from '../data.ts'
import { fmt, parseAmount } from '../net.ts'
import { Action, Empty } from '../ui.tsx'

export function Swap() {
  const w = useWallet()
  const pools = useAsync(() => loadPools(w.conn), [w.conn, w.refreshKey])
  const symbols = useAsync(() => launchSymbols(w.conn), [w.conn])
  const [poolKey, setPoolKey] = useState<string | null>(null)
  const [aToB, setAToB] = useState(true)
  const [amount, setAmount] = useState('')
  const [slip, setSlip] = useState('0.5')

  // Paste a contract address (CA): find its pool and set up a buy of that token.
  const [ca, setCa] = useState(() => decodeURIComponent(location.hash.split('/')[1] ?? ''))
  const caKey = useMemo(() => { try { return ca.trim() ? new PublicKey(ca.trim()) : null } catch { return null } }, [ca])
  const caPools = useMemo(
    () => (caKey && pools.data ? pools.data.filter(p => p.mintA.equals(caKey) || p.mintB.equals(caKey)) : []),
    [caKey, pools.data],
  )
  useEffect(() => {
    if (!caKey || !caPools.length) return
    // Deepest pool by the pasted token's reserve.
    const best = [...caPools].sort((x, y) => {
      const rx = x.mintA.equals(caKey) ? x.reserveA : x.reserveB
      const ry = y.mintA.equals(caKey) ? y.reserveA : y.reserveB
      return rx === ry ? 0 : rx > ry ? -1 : 1
    })[0]
    setPoolKey(best.address.toBase58())
    setAToB(!best.mintA.equals(caKey)) // receive the pasted token
    setAmount('')
  }, [caKey, caPools])
  const onCurve = useAsync(async () => {
    if (!caKey || caPools.length) return null
    const launch = launchAddress(caKey)
    return (await w.conn.getAccountInfo(launch)) ? launch.toBase58() : null
  }, [caKey?.toBase58(), caPools.length, w.conn])

  const pool = pools.data?.find(p => p.address.toBase58() === poolKey) ?? pools.data?.[0]
  const label = (m: { toBase58(): string }) => tokenLabel(m.toBase58(), symbols.data)
  const inDec = pool ? (aToB ? pool.decimalsA : pool.decimalsB) : 6
  const outDec = pool ? (aToB ? pool.decimalsB : pool.decimalsA) : 6
  const raw = parseAmount(amount, inDec)
  const slipBps = Math.round(Number(slip) * 100)

  const quote = useMemo(() => {
    if (!pool || !raw) return null
    const [ri, ro] = aToB ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA]
    return swapQuote(raw, ri, ro, pool.feeBps)
  }, [pool, raw, aToB])

  const balIn = useAsync(async () => {
    if (!w.publicKey || !pool) return null
    const mint = aToB ? pool.mintA : pool.mintB
    try {
      return BigInt((await w.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, w.publicKey))).value.amount)
    } catch { return 0n }
  }, [w.publicKey, pool?.address.toBase58(), aToB, w.refreshKey])

  if (pools.loading && !pools.data) return <div className="card narrow">Loading pools…</div>
  if (pools.error) return <div className="card narrow"><Empty>Could not load pools: {pools.error}</Empty></div>
  if (!pools.data?.length) return <div className="card narrow"><h2>Swap</h2><Empty>No pools yet. Create one on the Pools tab.</Empty></div>

  return (
    <div className="card narrow">
      <h2>Swap</h2>
      <div className="field">
        <label>Paste a token address (CA)</label>
        <input
          className="mono"
          value={ca}
          onChange={e => setCa(e.target.value)}
          onPaste={e => { const t = e.clipboardData.getData('text').trim(); if (t) { e.preventDefault(); setCa(t) } }}
          placeholder="Token mint address"
          spellCheck={false}
        />
        {ca.trim() && !caKey && <small className="error">That isn't a valid address.</small>}
        {caKey && caPools.length > 0 && <small className="ok">Found {label(caKey)}: {caPools.length} pool{caPools.length > 1 ? 's' : ''}, set up to buy it.</small>}
        {caKey && !caPools.length && onCurve.data && (
          <small>This coin is still on its launch curve. <a href={`#Launch/${onCurve.data}`}>Buy it on its coin page →</a></small>
        )}
        {caKey && !caPools.length && !onCurve.loading && !onCurve.data && (
          <small className="muted">No pool for this token yet. <a href="#Pools">Create one on Pools →</a></small>
        )}
      </div>
      <div className="field">
        <label>Pool</label>
        <select value={pool?.address.toBase58()} onChange={e => setPoolKey(e.target.value)}>
          {pools.data.map(p => (
            <option key={p.address.toBase58()} value={p.address.toBase58()}>{label(p.mintA)} / {label(p.mintB)} · {(p.feeBps / 100).toFixed(2)}%</option>
          ))}
        </select>
      </div>
      {pool && (
        <>
          <div className="field">
            <label>You pay ({label(aToB ? pool.mintA : pool.mintB)}){balIn.data != null && <> · balance {fmt(balIn.data, inDec)}</>}</label>
            <input inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <button className="flip" title="Flip direction" onClick={() => setAToB(d => !d)}>⇅</button>
          <div className="field">
            <label>You receive ({label(aToB ? pool.mintB : pool.mintA)})</label>
            <input readOnly value={quote ? fmt(quote.out, outDec) : ''} placeholder="0.0" />
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Max slippage %</label>
              <input inputMode="decimal" value={slip} onChange={e => setSlip(e.target.value)} />
            </div>
            <dl className="kv" style={{ margin: 0 }}>
              <dt>Price impact</dt><dd>{quote ? (quote.impactBps / 100).toFixed(2) + '%' : '–'}</dd>
              <dt>Min received</dt><dd>{quote ? fmt(minOut(quote.out, slipBps), outDec) : '–'}</dd>
              <dt>Send</dt><dd>{w.privateMode ? <span className="pill good">private</span> : <span className="pill">public</span>}</dd>
            </dl>
          </div>
          <Action
            label={w.publicKey ? 'Swap' : 'Connect a wallet'}
            disabled={!w.publicKey || !quote || quote.out === 0n || !(slipBps >= 0 && slipBps <= 5000)}
            run={async () => {
              const amm = ammProgram(w.provider!)
              const slot = await w.conn.getSlot()
              const tx = await amm.methods
                .swap(new BN(raw!.toString()), new BN(minOut(quote!.out, slipBps).toString()), aToB, new BN(slot + 300))
                .accountsPartial({
                  user: w.publicKey!, pool: pool.address, mintA: pool.mintA, mintB: pool.mintB, vaultA: pool.vaultA, vaultB: pool.vaultB,
                  userA: getAssociatedTokenAddressSync(pool.mintA, w.publicKey!), userB: getAssociatedTokenAddressSync(pool.mintB, w.publicKey!),
                })
                .transaction()
              const sig = await w.send(tx)
              setAmount('')
              w.bump()
              return `Swapped. ${sig}`
            }}
          />
          <p className="muted" style={{ fontSize: 13 }}>
            Private sends split your signed swap into 3 encrypted fragments, one per proposer of the target slot. It becomes readable only once 2 of them have included it, so no single proposer can see it first and trade ahead of you.
          </p>
        </>
      )}
    </div>
  )
}
