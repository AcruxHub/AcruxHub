// Token locks: lock any token until a date. Nobody (not the owner, not AcruxHub)
// can move locked tokens before the date; the owner can only push it later.
import { useMemo, useState } from 'react'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { lockerProgram, loadLocks, lockInstruction, unlockInstruction, extendInstruction, type TokenLockRow } from '@acruxhub/sdk'
import { useWallet, readProvider } from '../wallet.tsx'
import { useAsync, tokenLabel } from '../hooks.ts'
import { launchSymbols } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, Empty, NeedWallet } from '../ui.tsx'

const DAY = 86_400
const PRESETS: [string, number][] = [['1 month', 30], ['3 months', 91], ['6 months', 182], ['1 year', 365], ['2 years', 730]]
const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const left = (ts: number) => {
  const s = ts - Date.now() / 1000
  if (s <= 0) return 'unlocked'
  const d = Math.floor(s / DAY)
  return d >= 1 ? `${d} day${d === 1 ? '' : 's'} left` : `${Math.ceil(s / 3600)} h left`
}

export function Locks() {
  const w = useWallet()
  const initial = decodeURIComponent(location.hash.split('/')[1] ?? '')
  const program = useMemo(() => lockerProgram(readProvider(w.conn)), [w.conn])
  const locks = useAsync(() => loadLocks(w.conn, program), [w.conn, program, w.refreshKey])
  const symbols = useAsync(() => launchSymbols(w.conn), [w.conn])
  const mints = useAsync(async () => {
    const out = new Map<string, { decimals: number; supply: bigint }>()
    for (const m of new Set((locks.data ?? []).map(l => l.mint.toBase58()))) {
      try { const x = await getMint(w.conn, new PublicKey(m)); out.set(m, { decimals: x.decimals, supply: x.supply }) } catch { /* skip */ }
    }
    return out
  }, [locks.data])
  const label = (m: PublicKey) => tokenLabel(m.toBase58(), symbols.data)
  const mine = (locks.data ?? []).filter(l => w.publicKey && l.owner.equals(w.publicKey))

  return (
    <>
      <div className="page-head"><div>
        <h1>Token locks</h1>
        <p>Lock tokens until a date, provably. Nobody can move them before then: not you, not AcruxHub. You can only push the date later. Teams use this to show holders their supply can't be dumped.</p>
      </div></div>
      <div className="grid">
        <div className="card">
          <h2>Lock tokens</h2>
          {w.publicKey ? <NewLock initial={initial} /> : <NeedWallet />}
        </div>
        <div className="card">
          <h2>Your locks</h2>
          {!w.publicKey ? <NeedWallet /> : !mine.length ? <Empty>No locks yet.</Empty> : mine.map(l => (
            <MyLock key={l.address.toBase58()} l={l} label={label(l.mint)} decimals={mints.data?.get(l.mint.toBase58())?.decimals ?? 6} />
          ))}
        </div>
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2>All locks</h2>
          {locks.loading && !locks.data ? <Empty>Loading…</Empty> : !(locks.data ?? []).length ? <Empty>No tokens are locked yet.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Token</th><th style={{ textAlign: 'right' }}>Locked</th><th style={{ textAlign: 'right' }}>Of supply</th><th>Unlocks</th><th>Owner</th></tr></thead>
                <tbody>
                  {(locks.data ?? []).map(l => {
                    const m = mints.data?.get(l.mint.toBase58())
                    return (
                      <tr key={l.address.toBase58()}>
                        <td><a href={`#Launch/${l.mint.toBase58()}`}>{label(l.mint)}</a></td>
                        <td className="num" style={{ textAlign: 'right' }}>{m ? fmt(l.amount, m.decimals, 0) : '…'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{m && m.supply > 0n ? `${(Number(l.amount) / Number(m.supply) * 100).toFixed(2)}%` : '–'}</td>
                        <td>{when(l.unlockTs)} <small className="muted">· {left(l.unlockTs)}</small></td>
                        <td><a href={`#Explorer/${l.owner.toBase58()}`} className="mono">{short(l.owner)}</a></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function NewLock({ initial }: { initial: string }) {
  const w = useWallet()
  const [ca, setCa] = useState(initial)
  const [amt, setAmt] = useState('')
  const [days, setDays] = useState(365)
  const [custom, setCustom] = useState('')
  const [ok, setOk] = useState(false)
  const mint = useMemo(() => { try { return ca.trim() ? new PublicKey(ca.trim()) : null } catch { return null } }, [ca])
  const info = useAsync(async () => {
    if (!mint || !w.publicKey) return null
    const m = await getMint(w.conn, mint)
    const bal = await w.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, w.publicKey)).then(r => BigInt(r.value.amount)).catch(() => 0n)
    return { decimals: m.decimals, supply: m.supply, bal }
  }, [mint?.toBase58(), w.publicKey?.toBase58(), w.refreshKey])
  const raw = info.data ? parseAmount(amt, info.data.decimals) : null
  const unlockTs = custom ? Math.floor(new Date(custom).getTime() / 1000) : Math.floor(Date.now() / 1000) + days * DAY
  const sym = mint ? tokenLabel(mint.toBase58()) : ''
  const plain = (v: bigint, d: number) => fmt(v, d, d).replace(/,/g, '')
  const valid = !!raw && raw > 0n && !!info.data && raw <= info.data.bal && unlockTs > Date.now() / 1000 + 60

  return (
    <>
      <div className="field">
        <label>Token address (CA)</label>
        <input className="mono" value={ca} onChange={e => setCa(e.target.value)} placeholder="The token to lock" spellCheck={false} />
      </div>
      {mint && info.data && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <small>Amount</small>
            <small>You have <span className="num" style={{ color: 'var(--text)' }}>{fmt(info.data.bal, info.data.decimals, 2)}</span> {sym}</small>
          </div>
          <div className="amount-box">
            <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" aria-label="Amount to lock" />
            <span className="unit">{sym}</span>
          </div>
          <div className="chips">{[25, 50, 75, 100].map(p => <button key={p} onClick={() => setAmt(plain((info.data!.bal * BigInt(p)) / 100n, info.data!.decimals))}>{p}%</button>)}</div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Locked for</label>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              {PRESETS.map(([l, d]) => <button key={d} className={!custom && days === d ? 'on' : ''} onClick={() => { setCustom(''); setDays(d) }}>{l}</button>)}
            </div>
            <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} style={{ marginTop: 8 }} aria-label="Or pick an unlock date" />
          </div>
          {raw != null && raw > 0n && (
            <p className="muted" style={{ fontSize: 13 }}>
              Locks <strong className="num">{fmt(raw, info.data.decimals, 2)} {sym}</strong>
              {info.data.supply > 0n && <> ({(Number(raw) / Number(info.data.supply) * 100).toFixed(2)}% of supply)</>} until <strong>{when(unlockTs)}</strong>.
            </p>
          )}
          <label className="toggle" style={{ margin: '4px 0 12px' }}>
            <input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} />
            I understand nobody can unlock these early, me included.
          </label>
          <Action
            label="Lock tokens"
            disabled={!valid || !ok}
            run={async () => {
              const program = lockerProgram(w.provider!)
              const id = BigInt(Date.now()) // unique per owner and token
              const sig = await w.send(new Transaction().add(await lockInstruction(program, w.publicKey!, mint, id, raw!, unlockTs)))
              setAmt(''); setOk(false); w.bump()
              return `Locked until ${when(unlockTs)}. ${sig}`
            }}
          />
        </>
      )}
      {mint && info.error && <p className="error">Not a token: {info.error}</p>}
    </>
  )
}

function MyLock({ l, label, decimals }: { l: TokenLockRow; label: string; decimals: number }) {
  const w = useWallet()
  const open = Date.now() / 1000 >= l.unlockTs
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong className="num">{fmt(l.amount, decimals, 2)} {label}</strong>
        <small className="muted">{left(l.unlockTs)}</small>
      </div>
      <small className="muted">Unlocks {when(l.unlockTs)}</small>
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        {open
          ? <Action label="Unlock" run={async () => { const sig = await w.send(new Transaction().add(await unlockInstruction(lockerProgram(w.provider!), l))); w.bump(); return `Unlocked. ${sig}` }} />
          : [['+3 months', 91], ['+1 year', 365]].map(([t, d]) => (
            <Action key={t as string} primary={false} label={`Extend ${t}`} run={async () => {
              const sig = await w.send(new Transaction().add(await extendInstruction(lockerProgram(w.provider!), l, l.unlockTs + (d as number) * DAY)))
              w.bump(); return `Extended. ${sig}`
            }} />
          ))}
      </div>
    </div>
  )
}

/** Locked supply of one token, for its coin page. */
export function useLocked(mint: PublicKey) {
  const w = useWallet()
  return useAsync(async () => {
    const ls = await loadLocks(w.conn, lockerProgram(readProvider(w.conn)), { mint })
    return { total: ls.reduce((s, l) => s + l.amount, 0n), count: ls.length, next: ls[0]?.unlockTs ?? null, last: ls.at(-1)?.unlockTs ?? null }
  }, [w.conn, mint.toBase58(), w.refreshKey])
}
export { when as lockDate }
