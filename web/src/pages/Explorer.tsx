import { Fragment, useEffect, useState } from 'react'
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { useWallet } from '../wallet.tsx'
import { useAsync, holdings, tokenLabel } from '../hooks.ts'
import { fmt, short } from '../net.ts'
import { Empty } from '../ui.tsx'

export function Explorer() {
  const w = useWallet()
  const initial = decodeURIComponent(location.hash.split('/')[1] ?? '')
  const [q, setQ] = useState(initial)
  const [query, setQuery] = useState(initial)
  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <form className="row" onSubmit={e => { e.preventDefault(); setQuery(q.trim()); location.hash = `Explorer/${encodeURIComponent(q.trim())}` }}>
          <input className="mono" value={q} onChange={e => setQ(e.target.value)} placeholder="Address, transaction signature, or Acrux tx id" />
          <button className="primary fixed" type="submit">Search</button>
        </form>
      </div>
      {query ? <Result query={query} /> : w.network.gateway ? <NetOverview /> : <LocalOverview />}
    </div>
  )
}

function NetOverview() {
  const w = useWallet()
  const gw = w.network.gateway!
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 2000); return () => clearInterval(t) }, [])
  const win = useAsync(() => gw.call<any>('getCurrentWindow', {}), [tick])
  const slots = useAsync(() => gw.call<any[]>('getRecentSlots', { limit: 12 }), [tick])
  const counters = useAsync(() => gw.call<any>('getCounters', {}), [tick])
  return (
    <>
      <div className="card">
        <h2>Now producing</h2>
        {win.data ? (
          <>
            <p className="stat">slots {win.data.firstSlot}–{win.data.lastSlot}</p>
            {win.data.hubCode && <p className="muted">window #{win.data.number} · hub {win.data.hubCode}</p>}
            <h3>Proposers</h3>
            {win.data.proposers?.map((p: any) => (
              <div key={p.index} className="row" style={{ marginBottom: 4 }}>
                <span>#{p.index} <span className="mono">{p.identity ? short(p.identity) : p.name ?? ''}</span></span>
                <span className="fixed">{p.status === 'online' ? <span className="pill good">online</span> : <span className="pill">{p.status}</span>}</span>
              </div>
            ))}
          </>
        ) : <Empty>{win.error ?? 'Loading…'}</Empty>}
      </div>
      <div className="card">
        <h2>Recent slots</h2>
        {slots.data ? (
          <table>
            <thead><tr><th>Slot</th><th>State</th><th>Txs</th></tr></thead>
            <tbody>
              {[...slots.data].reverse().map((s: any) => (
                <tr key={s.slot}><td>{s.slot}</td><td>{s.status}</td><td>{s.mergedOrder?.length ?? 0}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>{slots.error ?? 'Loading…'}</Empty>}
      </div>
      {counters.data && (
        <div className="card">
          <h2>Network counters</h2>
          <dl className="kv">
            {Object.entries(counters.data).filter(([, v]) => typeof v !== 'object').slice(0, 14).map(([k, v]) => (
              <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>
            ))}
          </dl>
        </div>
      )}
    </>
  )
}

function LocalOverview() {
  const w = useWallet()
  const info = useAsync(async () => ({ slot: await w.conn.getSlot(), epoch: await w.conn.getEpochInfo(), version: await w.conn.getVersion() }), [w.conn])
  return (
    <div className="card">
      <h2>{w.network.name}</h2>
      {info.data ? (
        <dl className="kv">
          <dt>Slot</dt><dd>{info.data.slot}</dd>
          <dt>Epoch</dt><dd>{info.data.epoch.epoch}</dd>
          <dt>Version</dt><dd>{info.data.version['solana-core']}</dd>
        </dl>
      ) : <Empty>{info.error ?? 'Loading…'}</Empty>}
    </div>
  )
}

function Result({ query }: { query: string }) {
  const w = useWallet()
  const res = useAsync(async () => {
    // Acrux tx id: 64 hex chars.
    if (/^[0-9a-f]{64}$/i.test(query) && w.network.gateway) return { kind: 'acruxTx' as const, tx: await w.network.gateway.call('getTransaction', { id: query }) }
    let key: PublicKey | null = null
    try { key = new PublicKey(query) } catch { /* not an address */ }
    if (key) {
      const [acct, sigs, toks] = await Promise.all([
        w.conn.getAccountInfo(key),
        w.conn.getSignaturesForAddress(key, { limit: 15 }).catch(() => []),
        holdings(w.conn, key).catch(() => []),
      ])
      return { kind: 'address' as const, key, acct, sigs, toks }
    }
    const tx = await w.conn.getTransaction(query, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    return { kind: 'tx' as const, tx }
  }, [query, w.conn])

  if (res.loading) return <div className="card">Searching…</div>
  if (res.error) return <div className="card"><Empty>{res.error}</Empty></div>
  const r = res.data!
  if (r.kind === 'acruxTx') {
    return <div className="card" style={{ gridColumn: '1 / -1' }}><h2>Acrux transaction</h2><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.tx, null, 2)}</pre></div>
  }
  if (r.kind === 'tx') {
    if (!r.tx) return <div className="card"><Empty>Not found.</Empty></div>
    const t = r.tx
    return (
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>Transaction</h2>
        <dl className="kv">
          <dt>Slot</dt><dd>{t.slot}</dd>
          <dt>Status</dt><dd>{t.meta?.err ? <span className="error">failed</span> : <span className="pill good">success</span>}</dd>
          <dt>Fee</dt><dd>{fmt(BigInt(t.meta?.fee ?? 0), 9)}</dd>
        </dl>
        <h3>Logs</h3>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{t.meta?.logMessages?.join('\n')}</pre>
      </div>
    )
  }
  return (
    <>
      <div className="card">
        <h2>Account <span className="mono" style={{ fontSize: 13 }}>{short(r.key, 6)}</span></h2>
        {r.acct ? (
          <dl className="kv">
            <dt>Balance</dt><dd>{(r.acct.lamports / LAMPORTS_PER_SOL).toLocaleString()} {w.network.explorerNative}</dd>
            <dt>Owner</dt><dd className="mono">{short(r.acct.owner, 6)}</dd>
            <dt>Executable</dt><dd>{r.acct.executable ? 'yes' : 'no'}</dd>
            <dt>Data</dt><dd>{r.acct.data.length} bytes</dd>
          </dl>
        ) : <Empty>No account at this address yet.</Empty>}
        <h3>Tokens</h3>
        {r.toks.length ? r.toks.map(t => <div key={t.account} className="row"><span>{tokenLabel(t.mint)}</span><span className="fixed">{fmt(t.amount, t.decimals)}</span></div>) : <Empty>None.</Empty>}
      </div>
      <div className="card">
        <h2>Recent activity</h2>
        {r.sigs.length ? r.sigs.map(s => (
          <div key={s.signature} style={{ marginBottom: 6 }}>
            <a className="mono" href={`#Explorer/${s.signature}`}>{short(s.signature, 10)}</a> <small>slot {s.slot}{s.err ? ' · failed' : ''}</small>
          </div>
        )) : <Empty>No transactions found (Acrux keeps 7 days).</Empty>}
      </div>
    </>
  )
}
