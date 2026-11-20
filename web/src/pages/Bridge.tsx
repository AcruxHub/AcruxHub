// Bridge ACRUX from Solana to Acrux, through Acrux's own bridge program: the
// deposit is signed on Solana by the user's Solana wallet (Phantom, Backpack) and
// arrives on Acrux as native ACRUX, 1:1. Going back to Solana isn't open yet.
import { useEffect, useMemo, useState } from 'react'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { acruxBridgeDeposit, acruxBridgeNextSequence, ACRUX_SOLANA_MINT, ACRUX_SOLANA_DECIMALS } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync } from '../hooks.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { inApp, API_BASE } from '../native.ts'

// Solana's public RPC refuses browsers, so reads go through our own /api/solana.
const SOLANA_RPC = `${API_BASE || location.origin}/api/solana`
const MIN_SOL = 5_000_000n // 0.005 SOL for the fee and the deposit record's rent

type SolWallet = {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>
  signAndSendTransaction(tx: Transaction): Promise<{ signature: string }>
}
const solanaWallet = (): SolWallet | null => {
  const w = window as any
  return w.phantom?.solana ?? w.backpack ?? w.solana ?? null
}

export function Bridge() {
  const w = useWallet()
  const sol = useMemo(() => new Connection(SOLANA_RPC, 'confirmed'), [])
  const [from, setFrom] = useState<PublicKey | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [amt, setAmt] = useState('')
  const [to, setTo] = useState('')
  const [editTo, setEditTo] = useState(false)
  const [tick, setTick] = useState(0)
  const [sent, setSent] = useState<{ sig: string; amount: bigint; to: PublicKey; before: bigint; arrived: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  // Reconnect silently if the wallet already trusts the site.
  useEffect(() => {
    solanaWallet()?.connect({ onlyIfTrusted: true }).then(r => setFrom(new PublicKey(r.publicKey.toString()))).catch(() => {})
  }, [])

  const balances = useAsync(async () => {
    if (!from) return null
    const [acrux, lamports] = await Promise.all([
      sol.getTokenAccountBalance(getAssociatedTokenAddressSync(ACRUX_SOLANA_MINT, from)).then(r => BigInt(r.value.amount)).catch(() => 0n),
      sol.getBalance(from).then(BigInt),
    ])
    return { acrux, lamports }
  }, [from?.toBase58(), tick])

  // Where it arrives: by default the same address on Acrux (the same key works there).
  const recipient = useMemo(() => {
    const s = to.trim()
    if (!editTo || !s) return from
    try { return new PublicKey(s) } catch { return null }
  }, [to, from, editTo])
  const raw = parseAmount(amt, ACRUX_SOLANA_DECIMALS)

  // After sending, watch the recipient's ACRUX on Acrux until the deposit lands.
  useEffect(() => {
    if (!sent || sent.arrived) return
    const t = setInterval(async () => {
      const now = BigInt(await w.conn.getBalance(sent.to).catch(() => 0))
      // Credited as lamports: 1 base unit (6 decimals) = 1,000 lamports (9 decimals).
      if (now >= sent.before + sent.amount * 1000n - 10_000n) { setSent({ ...sent, arrived: true }); w.bump() }
    }, 3000)
    return () => clearInterval(t)
  }, [sent, w.conn])

  const wallet = solanaWallet()
  const problems = [
    !raw || raw <= 0n ? 'Enter an amount.' : null,
    balances.data && raw && raw > balances.data.acrux ? 'That is more ACRUX than this wallet holds on Solana.' : null,
    balances.data && balances.data.lamports < MIN_SOL ? 'This wallet needs about 0.005 SOL on Solana for the fee.' : null,
    !recipient ? 'That Acrux address is not valid.' : null,
  ].filter(Boolean) as string[]

  async function bridge() {
    setErr(null); setBusy(true)
    try {
      const seq = await acruxBridgeNextSequence(sol)
      const tx = new Transaction().add(acruxBridgeDeposit({ depositor: from!, recipient: recipient!, amount: raw!, sequence: seq }))
      tx.feePayer = from!
      tx.recentBlockhash = (await sol.getLatestBlockhash('confirmed')).blockhash
      const before = BigInt(await w.conn.getBalance(recipient!).catch(() => 0))
      const { signature } = await solanaWallet()!.signAndSendTransaction(tx)
      setSent({ sig: signature, amount: raw!, to: recipient!, before, arrived: false })
      setAmt('')
      setTimeout(() => setTick(x => x + 1), 4000)
    } catch (e: any) {
      const m = e?.message ?? String(e)
      setErr(/seeds|ConstraintSeeds|2006/.test(m) ? 'Someone else bridged at the same moment. Try again.' : m)
    } finally { setBusy(false) }
  }

  return (
    <div className="narrow">
      <div className="page-head"><div>
        <h1>Bridge</h1>
        <p>Bring ACRUX from Solana to Acrux. 1 ACRUX on Solana becomes 1 ACRUX on Acrux, usually within a minute.</p>
      </div></div>

      <div className="card">
        {!wallet ? (
          <p className="muted" style={{ margin: 0 }}>
            {inApp
              ? 'Bridging needs a Solana wallet. Open acruxhub.com in Phantom’s browser or on a computer with Phantom or Backpack.'
              : 'Bridging needs a Solana wallet such as Phantom or Backpack. Install one, then reload this page.'}
          </p>
        ) : !from ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>Connect the Solana wallet that holds your ACRUX.</p>
            <button className="primary" style={{ width: '100%', height: 44 }} onClick={() => wallet.connect().then(r => setFrom(new PublicKey(r.publicKey.toString())), e => setErr(e.message))}>Connect Solana wallet</button>
          </>
        ) : (
          <>
            <div className="token-box">
              <div className="token-box-head"><span>From Solana</span>
                <button className="ghost" style={{ padding: 0 }} onClick={() => balances.data && setAmt(fmt(balances.data.acrux, ACRUX_SOLANA_DECIMALS, ACRUX_SOLANA_DECIMALS).replace(/,/g, ''))}>
                  You have <span className="num">{balances.data ? fmt(balances.data.acrux, ACRUX_SOLANA_DECIMALS, 2) : '…'}</span> ACRUX
                </button>
              </div>
              <div className="token-box-row">
                <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" aria-label="ACRUX to bridge" />
                <span className="token-badge">ACRUX</span>
              </div>
            </div>
            <div className="flip" aria-hidden="true">↓</div>
            <div className="token-box">
              <div className="token-box-head"><span>To Acrux</span><button className="ghost" style={{ padding: 0 }} onClick={() => setEditTo(x => !x)}>{editTo ? 'Use my address' : 'Send somewhere else'}</button></div>
              <div className="token-box-row">
                <span className="num" style={{ fontSize: 22 }}>{raw ? fmt(raw, ACRUX_SOLANA_DECIMALS, 2) : '0'}</span>
                <span className="token-badge">ACRUX</span>
              </div>
              {editTo
                ? <input className="mono" value={to} onChange={e => setTo(e.target.value)} placeholder="Acrux address" spellCheck={false} style={{ marginTop: 8 }} />
                : <small className="muted">Arrives at <span className="mono">{short(from, 6)}</span> on Acrux, your same address.</small>}
            </div>
            {problems.length > 0 && amt && <p className="error" style={{ marginBottom: 0 }}>{problems[0]}</p>}
            <button className="primary" style={{ width: '100%', height: 44, marginTop: 14 }} disabled={busy || problems.length > 0} onClick={bridge}>
              {busy ? 'Confirm in your wallet…' : `Bridge${raw ? ` ${fmt(raw, ACRUX_SOLANA_DECIMALS, 2)}` : ''} ACRUX`}
            </button>
            <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>From <span className="mono">{short(from)}</span> · network fee under 0.005 SOL · sent through Acrux’s own bridge</p>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </div>

      {sent && (
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>{sent.arrived ? 'Arrived on Acrux ✓' : 'On its way…'}</h2>
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Locked on Solana · <a href={`https://solscan.io/tx/${sent.sig}`} target="_blank" rel="noopener noreferrer">view</a></li>
            <li>{sent.arrived ? <>Credited <strong className="num">{fmt(sent.amount, ACRUX_SOLANA_DECIMALS, 2)} ACRUX</strong> to <span className="mono">{short(sent.to)}</span> on Acrux</> : 'Waiting for Acrux to credit it (usually under a minute)'}</li>
          </ol>
          {sent.arrived && <p style={{ marginBottom: 0 }}><a href="#Launch">Go trade →</a></p>}
        </div>
      )}

      <p className="faint" style={{ fontSize: 12 }}>
        Going back from Acrux to Solana isn’t open yet: it needs Solana to certify Acrux’s blocks first. Only bridge what you’re happy to keep on Acrux for now.
        The bridge is run by Acrux; <a href="https://acrux.computer/bridge" target="_blank" rel="noopener noreferrer">their page</a> shows every transfer.
      </p>
    </div>
  )
}
