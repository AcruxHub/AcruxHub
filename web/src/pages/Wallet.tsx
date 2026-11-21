// Wallet: every balance in one place with its value in ACRUX, plus Send and
// Receive for native ACRUX and any token. It's the home screen of the Telegram
// Mini App, and works the same on the site.
import { useEffect, useMemo, useState } from 'react'
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token'
import { wacruxProgram, unwrapInstruction } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync, holdings, tokenLabel, WACRUX } from '../hooks.ts'
import { loadPools, launchSymbols, acruxPrices } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, CopyButton, Empty, NeedWallet } from '../ui.tsx'
import { FEE_RESERVE } from '../wrap.ts'
import { compact } from '../history.ts'
import { isTelegram, linkTelegramWallet } from '../native.ts'

const NATIVE = 'native'
type Row = { id: string; mint: string | null; label: string; amount: bigint; decimals: number; value: number | null; note?: string }

export function Wallet() {
  const w = useWallet()
  // #Wallet/send/<mint> opens Send with that token picked.
  const [, mode, preset] = location.hash.slice(1).split('/')
  const data = useAsync(async () => {
    if (!w.publicKey) return null
    const [lamports, toks, pools, symbols, prices] = await Promise.all([
      w.conn.getBalance(w.publicKey),
      holdings(w.conn, w.publicKey),
      loadPools(w.conn).catch(() => []),
      launchSymbols(w.conn),
      acruxPrices(w.conn, WACRUX).catch(() => new Map<string, number>()),
    ])
    return { lamports: BigInt(lamports), toks, lpMints: new Set(pools.map(p => p.lpMint.toBase58())), symbols, prices }
  }, [w.publicKey?.toBase58(), w.conn, w.refreshKey])
  const [sendId, setSendId] = useState<string | null>(mode === 'send' ? (preset || NATIVE) : null)
  const [receive, setReceive] = useState(mode === 'receive')
  // Follow #Wallet/send and #Wallet/receive links while already on this page.
  useEffect(() => {
    const on = () => {
      const [r, m, p] = location.hash.slice(1).split('/')
      if (r !== 'Wallet') return
      setSendId(m === 'send' ? (p || NATIVE) : null)
      setReceive(m === 'receive')
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  // Inside Telegram, tell the bot which address this is, so /wallet can show balances in chat.
  useEffect(() => { if (isTelegram && w.publicKey) linkTelegramWallet(w.publicKey.toBase58()) }, [w.publicKey?.toBase58()])

  const rows = useMemo<Row[]>(() => {
    if (!data.data) return []
    const { lamports, toks, lpMints, symbols, prices } = data.data
    const list: Row[] = [{ id: NATIVE, mint: null, label: 'ACRUX', amount: lamports, decimals: 9, value: Number(lamports) / LAMPORTS_PER_SOL, note: 'pays gas' }]
    for (const t of toks) {
      if (t.amount <= 0n || lpMints.has(t.mint)) continue
      const whole = Number(t.amount) / 10 ** t.decimals
      const isW = t.mint === WACRUX
      const p = isW ? 1 : prices.get(t.mint)
      list.push({
        id: t.mint, mint: t.mint, label: isW ? 'Wrapped ACRUX' : tokenLabel(t.mint, symbols), amount: t.amount, decimals: t.decimals,
        value: p != null ? whole * p : null, note: isW ? '1:1 with ACRUX' : undefined,
      })
    }
    return [list[0], ...list.slice(1).sort((a, b) => (b.value ?? -1) - (a.value ?? -1))]
  }, [data.data])
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0)

  if (!w.publicKey) return <div className="card narrow"><h2>Wallet</h2><NeedWallet /></div>
  const addr = w.publicKey.toBase58()
  const sending = rows.find(r => r.id === sendId) ?? (sendId && rows.length ? rows[0] : null)

  return (
    <div className="narrow">
      <div className="card wallet-head">
        <small className="muted">Total value</small>
        <div className="wallet-total num">{data.data ? compact(total) : '…'} <small>ACRUX</small></div>
        <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}><span className="mono muted">{short(addr, 6)}</span><CopyButton text={addr} label="Copy address" /></div>
        <div className="wallet-actions">
          <button className="primary" onClick={() => { setSendId(sendId ? null : NATIVE); setReceive(false) }}>↑ Send</button>
          <button onClick={() => { setReceive(!receive); setSendId(null) }}>↓ Receive</button>
          <button onClick={() => { location.hash = '#Swap' }}>⇄ Swap</button>
          <button onClick={() => { location.hash = '#Bridge' }}>Bridge</button>
        </div>
      </div>

      {receive && (
        <div className="card">
          <h2>Receive</h2>
          <p className="muted" style={{ marginTop: 0 }}>Send ACRUX or any Acrux token to this address. It's the same address for every token.</p>
          <p className="mono" style={{ wordBreak: 'break-all', fontSize: 15 }}>{addr}</p>
          <CopyButton text={addr} label="Copy address" />
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>Coming from Solana? Use Bridge. A plain Solana transfer to this address won't arrive on Acrux.</p>
        </div>
      )}

      {sending && <Send key={sending.id} rows={rows} row={sending} onPick={setSendId} onDone={() => w.bump()} />}

      <div className="card">
        <h2>Balances</h2>
        {data.loading && !data.data ? <Empty>Loading…</Empty> : data.error ? <Empty>{data.error}</Empty> : rows.map(r => (
          <div key={r.id} className="wallet-row">
            <div className="wallet-row-main">
              <div style={{ minWidth: 0 }}><strong>{r.label}</strong>{r.note && <div><small className="faint">{r.note}</small></div>}</div>
              <div className="num" style={{ textAlign: 'right' }}>
                {fmt(r.amount, r.decimals, 4)}
                <div><small className="muted">{r.value != null ? `≈ ${compact(r.value)} ACRUX` : 'no price yet'}</small></div>
              </div>
            </div>
            <div className="wallet-row-actions">
              <button onClick={() => { setSendId(r.id); setReceive(false); scrollTo({ top: 0, behavior: 'smooth' }) }}>Send</button>
              {r.mint && r.mint !== WACRUX && <>
                <button className="buy" onClick={() => { location.hash = `#Swap/${r.mint}` }}>Buy</button>
                <button className="sell" onClick={() => { location.hash = `#Swap/${r.mint}/sell` }}>Sell</button>
                <button onClick={() => { location.hash = `#Launch/${r.mint}` }}>Chart</button>
              </>}
              {r.mint === WACRUX && (
                <Action primary={false} label="Unwrap" run={async () => {
                  const sig = await w.send(new Transaction().add(await unwrapInstruction(wacruxProgram(w.provider!), w.publicKey!, r.amount)))
                  w.bump(); return `Unwrapped. ${sig}`
                }} />
              )}
            </div>
          </div>
        ))}
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>Values use live pool and curve prices. Liquidity positions are on <a href="#Portfolio">Portfolio</a>.</p>
      </div>
      {isTelegram && <p className="faint" style={{ fontSize: 12, textAlign: 'center' }}>Your key stays in this phone's secure storage. The bot never sees it.</p>}
    </div>
  )
}

function Send({ rows, row, onPick, onDone }: { rows: Row[]; row: Row; onPick: (id: string) => void; onDone: () => void }) {
  const w = useWallet()
  const [to, setTo] = useState('')
  const [amt, setAmt] = useState('')
  const dest = useMemo(() => { try { return to.trim() ? new PublicKey(to.trim()) : null } catch { return null } }, [to])
  const native = row.id === NATIVE
  const max = native ? (row.amount > FEE_RESERVE ? row.amount - FEE_RESERVE : 0n) : row.amount
  const raw = parseAmount(amt, row.decimals)
  const self = !!(dest && w.publicKey && dest.equals(w.publicKey))
  // Off-curve addresses belong to programs, not people: tokens sent there are usually lost.
  const offCurve = !!(dest && !PublicKey.isOnCurve(dest.toBytes()))
  const problem = !to.trim() ? null
    : !dest ? 'That is not a valid Acrux address.'
    : self ? 'That is your own address.'
    : offCurve ? 'That address belongs to a program, not a wallet. Tokens sent there would likely be lost.'
    : raw && raw > max ? `You can send at most ${fmt(max, row.decimals, 4)}${native ? ' (a little ACRUX stays back for the fee)' : ''}.`
    : null
  const plain = (v: bigint) => fmt(v, row.decimals, row.decimals).replace(/,/g, '')
  const unit = row.label === 'Wrapped ACRUX' ? 'wACRUX' : row.label

  return (
    <div className="card">
      <h2>Send</h2>
      <div className="field">
        <label>Token</label>
        <select value={row.id} onChange={e => { onPick(e.target.value); setAmt('') }}>
          {rows.map(r => <option key={r.id} value={r.id}>{r.label} · {fmt(r.amount, r.decimals, 4)}</option>)}
        </select>
      </div>
      <div className="field">
        <label>To (Acrux address)</label>
        <input className="mono" value={to} onChange={e => setTo(e.target.value)} placeholder="Recipient's address" spellCheck={false} autoComplete="off" />
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <small>Amount</small>
        <button className="ghost" style={{ padding: 0 }} onClick={() => setAmt(plain(max))}><small>Max {fmt(max, row.decimals, 4)}</small></button>
      </div>
      <div className="amount-box">
        <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" aria-label="Amount to send" />
        <span className="unit">{unit}</span>
      </div>
      <div className="chips">{[25, 50, 100].map(p => <button key={p} onClick={() => setAmt(plain((max * BigInt(p)) / 100n))}>{p === 100 ? 'Max' : `${p}%`}</button>)}</div>
      {problem && <p className="error">{problem}</p>}
      {dest && raw != null && raw > 0n && !problem && <p className="muted" style={{ fontSize: 13 }}>Sends <strong className="num">{fmt(raw, row.decimals, 4)} {unit}</strong> to <span className="mono">{short(dest, 6)}</span>. Transfers can't be undone, so check the address.</p>}
      <Action
        label="Send"
        disabled={!dest || !raw || raw <= 0n || !!problem}
        run={async () => {
          const me = w.publicKey!
          const tx = new Transaction()
          if (native) {
            tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: dest!, lamports: raw! }))
          } else {
            const mint = new PublicKey(row.mint!)
            const program = (await w.conn.getAccountInfo(mint))!.owner
            const from = getAssociatedTokenAddressSync(mint, me, false, program)
            const toAta = getAssociatedTokenAddressSync(mint, dest!, false, program)
            tx.add(createAssociatedTokenAccountIdempotentInstruction(me, toAta, dest!, mint, program))
            tx.add(createTransferCheckedInstruction(from, mint, toAta, me, raw!, row.decimals, [], program))
          }
          const sig = await w.send(tx)
          setAmt('')
          onDone()
          return `Sent. ${sig}`
        }}
      />
    </div>
  )
}
