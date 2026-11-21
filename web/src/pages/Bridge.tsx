// Bridge ACRUX from Solana to Acrux, through Acrux's own bridge program: the deposit
// is signed on Solana and arrives on Acrux as native ACRUX, 1:1.
//
// Two ways to sign the Solana side:
//  - the app's own wallet (Telegram, the phone apps, a browser key): one key is the
//    same address on Solana and on Acrux, so it signs the deposit itself, no Phantom
//    needed. Fund that address on Solana with ACRUX + a little SOL, then bridge.
//  - an extension/app wallet (Phantom, Backpack) on the site.
// The way back (Acrux -> Solana, BridgeOut below) burns native ACRUX on Acrux with the
// same bridge program; Acrux's relayer pays it out on Solana, usually within a minute.
import { useEffect, useMemo, useState } from 'react'
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { acruxBridgeDeposit, acruxBridgeNextSequence, acruxBridgeWithdrawNative, acruxBridgeNextWithdrawal, ACRUX_MIN_WITHDRAWAL, ACRUX_SOLANA_MINT, ACRUX_SOLANA_DECIMALS } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync } from '../hooks.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { inApp, isTelegram, API_BASE, tap } from '../native.ts'
import { CopyButton, NeedWallet } from '../ui.tsx'

// Solana's public RPC refuses browsers, so reads (and bridge sends) go through our /api/solana.
const SOLANA_RPC = `${API_BASE || location.origin}/api/solana`
const MIN_SOL = 5_000_000n // 0.005 SOL for the fee and the deposit record's rent

type SolWallet = {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>
  signAndSendTransaction(tx: Transaction | VersionedTransaction): Promise<{ signature: string }>
}
const solanaWallet = (): SolWallet | null => {
  const w = window as any
  return w.phantom?.solana ?? w.backpack ?? w.solana ?? null
}

/** Waits for a Solana signature to confirm (polling: our proxy has no websocket). */
async function confirmSolana(sol: Connection, sig: string, what = 'The bridge deposit') {
  for (let i = 0; i < 60; i++) {
    const st = (await sol.getSignatureStatuses([sig]).catch(() => null))?.value[0]
    if (st?.err) throw new Error(`${what} failed on Solana: ${JSON.stringify(st.err)}`)
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`Not confirmed yet. Check it on Solscan: ${sig}`)
}

export function Bridge() {
  const w = useWallet()
  const sol = useMemo(() => new Connection(SOLANA_RPC, 'confirmed'), [])
  const ext = solanaWallet()
  // The app's key wallet signs on Solana itself; inside Telegram and the apps it's the default.
  const keyWallet = !!w.signWithKey && !!w.publicKey
  const [useExt, setUseExt] = useState(() => !inApp && !!ext && !keyWallet)
  const viaKey = keyWallet && !(useExt && ext)
  const [extFrom, setExtFrom] = useState<PublicKey | null>(null)
  const from = viaKey ? w.publicKey : extFrom
  const [err, setErr] = useState<string | null>(null)
  const [amt, setAmt] = useState('')
  const [to, setTo] = useState('')
  const [editTo, setEditTo] = useState(false)
  const [tick, setTick] = useState(0)
  const [sent, setSent] = useState<{ sig: string; amount: bigint; to: PublicKey; before: bigint; arrived: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Reconnect the extension silently if it already trusts the site.
  useEffect(() => {
    if (!viaKey) ext?.connect({ onlyIfTrusted: true }).then(r => setExtFrom(new PublicKey(r.publicKey.toString()))).catch(() => {})
  }, [viaKey])

  // After a SOL -> ACRUX swap: refresh, and fill the bridge amount with everything they now hold.
  const [fillAfterSwap, setFillAfterSwap] = useState(false)
  const balances = useAsync(async () => {
    if (!from) return null
    const [acrux, lamports] = await Promise.all([
      sol.getTokenAccountBalance(getAssociatedTokenAddressSync(ACRUX_SOLANA_MINT, from)).then(r => BigInt(r.value.amount)).catch(() => 0n),
      sol.getBalance(from).then(BigInt),
    ])
    return { acrux, lamports }
  }, [from?.toBase58(), tick])
  useEffect(() => {
    if (fillAfterSwap && balances.data && balances.data.acrux > 0n) {
      setAmt(fmt(balances.data.acrux, ACRUX_SOLANA_DECIMALS, ACRUX_SOLANA_DECIMALS).replace(/,/g, ''))
      setFillAfterSwap(false)
    }
  }, [fillAfterSwap, balances.data])
  // Funding a fresh wallet on Solana: check again every few seconds until it shows up.
  const empty = !!balances.data && balances.data.lamports < MIN_SOL
  useEffect(() => {
    if (!empty) return
    const t = setInterval(() => setTick(x => x + 1), 8000)
    return () => clearInterval(t)
  }, [empty])

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
      if (now >= sent.before + sent.amount * 1000n - 10_000n) { setSent({ ...sent, arrived: true }); w.bump(); tap('success') }
    }, 3000)
    return () => clearInterval(t)
  }, [sent, w.conn])

  const problems = [
    !raw || raw <= 0n ? 'Enter an amount.' : null,
    balances.data && raw && raw > balances.data.acrux ? (balances.data.acrux === 0n ? 'No ACRUX on Solana yet: swap some SOL for it in step 1 above.' : 'That is more ACRUX than this wallet holds on Solana.') : null,
    balances.data && balances.data.lamports < MIN_SOL ? 'This wallet needs about 0.005 SOL on Solana for the fee.' : null,
    !recipient ? 'That Acrux address is not valid.' : null,
  ].filter(Boolean) as string[]

  async function bridge() {
    setErr(null); setBusy(viaKey ? 'Sending…' : 'Confirm in your wallet…')
    try {
      const seq = await acruxBridgeNextSequence(sol)
      const tx = new Transaction().add(acruxBridgeDeposit({ depositor: from!, recipient: recipient!, amount: raw!, sequence: seq }))
      tx.feePayer = from!
      tx.recentBlockhash = (await sol.getLatestBlockhash('confirmed')).blockhash
      const before = BigInt(await w.conn.getBalance(recipient!).catch(() => 0))
      let signature: string
      if (viaKey) {
        w.signWithKey!(tx)
        signature = await sol.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
        setBusy('Confirming on Solana…')
        await confirmSolana(sol, signature)
      } else {
        signature = (await ext!.signAndSendTransaction(tx)).signature
      }
      setSent({ sig: signature, amount: raw!, to: recipient!, before, arrived: false })
      setAmt('')
      setTimeout(() => setTick(x => x + 1), 4000)
    } catch (e: any) {
      const m = e?.message ?? String(e)
      setErr(/seeds|ConstraintSeeds|2006|already in use/.test(m) ? 'Someone else bridged at the same moment. Try again.' : m)
      tap('error')
    } finally { setBusy(null) }
  }

  // #Bridge/out opens the way back.
  const [dir, setDir] = useState<'in' | 'out'>(() => (location.hash.split('/')[1] === 'out' ? 'out' : 'in'))
  const dirToggle = (
    <div className="seg" style={{ marginBottom: 14 }} role="tablist" aria-label="Direction">
      <button className={dir === 'in' ? 'on' : ''} onClick={() => setDir('in')}>Solana → Acrux</button>
      <button className={dir === 'out' ? 'on' : ''} onClick={() => setDir('out')}>Acrux → Solana</button>
    </div>
  )
  if (dir === 'out') {
    return (
      <div className="narrow">
        <div className="page-head"><div>
          <h1>Bridge</h1>
          <p>Send ACRUX from Acrux back to Solana. It's burned on Acrux and paid out on Solana 1:1, usually within a minute.</p>
        </div></div>
        {dirToggle}
        <BridgeOut sol={sol} ext={ext} />
      </div>
    )
  }

  const pickSource = (keyWallet && ext) ? (
    <div className="seg" style={{ marginBottom: 12 }} role="tablist" aria-label="Bridge from">
      <button className={viaKey ? 'on' : ''} onClick={() => setUseExt(false)}>This wallet</button>
      <button className={!viaKey ? 'on' : ''} onClick={() => setUseExt(true)}>Phantom / Backpack</button>
    </div>
  ) : null

  const connectExt = () => ext!.connect().then(r => setExtFrom(new PublicKey(r.publicKey.toString())), e => setErr(e.message))

  return (
    <div className="narrow">
      <div className="page-head"><div>
        <h1>Bridge</h1>
        <p>Bring ACRUX from Solana to Acrux. 1 ACRUX on Solana becomes 1 ACRUX on Acrux, usually within a minute.</p>
      </div></div>
      {dirToggle}

      <div className="card">
        {pickSource}
        {!keyWallet && !ext ? (
          inApp ? <NeedWallet /> : (
            <p className="muted" style={{ margin: 0 }}>
              Bridging needs a wallet: create one with Connect (top right), or install Phantom or Backpack and reload this page.
            </p>
          )
        ) : !from ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>Connect the Solana wallet that holds your ACRUX.</p>
            <button className="primary" style={{ width: '100%', height: 44 }} onClick={connectExt}>Connect Solana wallet</button>
          </>
        ) : (
          <>
            {viaKey && empty && (
              <div className="notice" style={{ marginTop: 0 }}>
                <strong>Fund this wallet on Solana first.</strong> Your address is the same on Solana and Acrux:
                <p className="mono" style={{ wordBreak: 'break-all', margin: '8px 0' }}>{from.toBase58()}</p>
                <CopyButton text={from.toBase58()} label="Copy address" />
                <p style={{ margin: '10px 0 0', fontSize: 13 }}>
                  From Phantom or an exchange, send to it <strong>on Solana</strong>: SOL (step 1 below swaps it for ACRUX), or ACRUX plus about <strong>0.02 SOL</strong> for fees.
                  {' '}Balances below update by themselves.
                </p>
              </div>
            )}
            {balances.data && (
              <SwapSol sol={sol} from={from} lamports={balances.data.lamports} acrux={balances.data.acrux} viaKey={viaKey} ext={ext}
                onDone={() => { setFillAfterSwap(true); setTick(x => x + 1) }} />
            )}
            <h3 className="step-title">Step 2 · Bridge ACRUX to Acrux</h3>
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
            <button className="primary" style={{ width: '100%', height: 44, marginTop: 14 }} disabled={!!busy || problems.length > 0} onClick={bridge}>
              {busy ?? `Bridge${raw ? ` ${fmt(raw, ACRUX_SOLANA_DECIMALS, 2)}` : ''} ACRUX`}
            </button>
            <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>
              From <span className="mono">{short(from)}</span>{viaKey ? ' (this wallet, signing on Solana)' : ''} · SOL {balances.data ? fmt(balances.data.lamports, 9, 4) : '…'} · network fee under 0.005 SOL · sent through Acrux’s own bridge
            </p>
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
          {sent.arrived && <p style={{ marginBottom: 0 }}><a href="#Swap">Buy something →</a> · <a href="#Wallet">Wallet</a></p>}
        </div>
      )}

      <p className="faint" style={{ fontSize: 12 }}>
        Going back to Solana works too: switch to Acrux → Solana above.
        {isTelegram ? ' Your key stays in this phone’s secure storage; the bot never sees it.' : ''}
        {' '}The bridge is run by Acrux; <a href="https://acrux.computer/bridge" target="_blank" rel="noopener noreferrer">their page</a> shows every transfer.
      </p>
    </div>
  )
}

// ------------------------------------------------------------------ step 1: SOL -> ACRUX on Solana

// Acrux's bridge takes ACRUX, so someone holding only SOL swaps first. Jupiter finds the
// route (today the Raydium ACRUX/SOL pool); the user's own wallet signs on Solana.
const JUP = 'https://lite-api.jup.ag/swap/v1'
const WSOL = 'So11111111111111111111111111111111111111112'
/** SOL left behind for Solana fees, the ACRUX token account's rent and the bridge record's rent. */
const SOL_RESERVE = 20_000_000n // 0.02 SOL
const SLIPPAGE_BPS = 100

type JupQuote = { outAmount: string; otherAmountThreshold: string; priceImpactPct: string; inAmount: string }

function SwapSol({ sol, from, lamports, acrux, viaKey, ext, onDone }: { sol: Connection; from: PublicKey; lamports: bigint; acrux: bigint; viaKey: boolean; ext: SolWallet | null; onDone: () => void }) {
  const w = useWallet()
  // Open by default for someone holding SOL but no ACRUX on Solana: that's who needs it.
  const [open, setOpen] = useState(acrux === 0n)
  const [amt, setAmt] = useState('')
  const [quote, setQuote] = useState<JupQuote | null>(null)
  const [quoteErr, setQuoteErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ sig: string; out: bigint } | null>(null)
  const raw = parseAmount(amt, 9)
  const max = lamports > SOL_RESERVE ? lamports - SOL_RESERVE : 0n

  // Quote as they type (debounced).
  useEffect(() => {
    setQuote(null); setQuoteErr(null)
    if (!raw || raw <= 0n || raw > max) return
    let live = true
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${JUP}/quote?inputMint=${WSOL}&outputMint=${ACRUX_SOLANA_MINT.toBase58()}&amount=${raw}&slippageBps=${SLIPPAGE_BPS}`)
        const j = await r.json()
        if (!live) return
        if (!r.ok || !j.outAmount) throw new Error(j.error ?? 'No route right now. Try a different amount.')
        setQuote(j)
      } catch (e: any) { if (live) setQuoteErr(e?.message ?? String(e)) }
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [raw?.toString(), max.toString()])

  const impact = quote ? Number(quote.priceImpactPct) * 100 : 0
  const problems = [
    !raw || raw <= 0n ? 'Enter how much SOL to swap.' : null,
    raw && raw > max ? (max > 0n ? `You can swap up to ${fmt(max, 9, 4)} SOL (about 0.02 SOL stays for fees).` : 'This wallet needs more than 0.02 SOL on Solana: fees and account rent come out of that.') : null,
    quoteErr,
  ].filter(Boolean) as string[]

  async function swap() {
    setErr(null); setBusy('Getting the best price…')
    try {
      // A fresh quote, so the price signed is the price now.
      const q = await (await fetch(`${JUP}/quote?inputMint=${WSOL}&outputMint=${ACRUX_SOLANA_MINT.toBase58()}&amount=${raw}&slippageBps=${SLIPPAGE_BPS}`)).json()
      if (!q.outAmount) throw new Error(q.error ?? 'No route right now. Try again in a moment.')
      const r = await (await fetch(`${JUP}/swap`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: from.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
      })).json()
      if (!r.swapTransaction) throw new Error(r.error ?? 'Jupiter could not build the swap. Try again.')
      const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64'))
      setBusy(viaKey ? 'Swapping…' : 'Confirm in your wallet…')
      let sig: string
      if (viaKey) {
        w.signVersionedWithKey!(tx)
        sig = await sol.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 })
      } else {
        sig = (await ext!.signAndSendTransaction(tx)).signature
      }
      setBusy('Confirming on Solana…')
      await confirmSolana(sol, sig, 'The swap')
      setDone({ sig, out: BigInt(q.outAmount) })
      setAmt('')
      tap('success')
      onDone()
    } catch (e: any) {
      const m = e?.message ?? String(e)
      setErr(/0x1771|slippage|SlippageToleranceExceeded/i.test(m) ? 'The price moved before it went through. Nothing was swapped: try again.' : /insufficient|0x1\b/i.test(m) ? 'Not enough SOL for this swap plus fees. Try a smaller amount.' : m)
      tap('error')
    } finally { setBusy(null) }
  }

  if (!open) {
    return (
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 13 }}>
        Have SOL but no ACRUX? <button className="ghost" style={{ padding: 0 }} onClick={() => setOpen(true)}>Swap SOL for ACRUX first →</button>
      </p>
    )
  }
  return (
    <div className="swap-step">
      <h3 className="step-title">Step 1 · Swap SOL for ACRUX on Solana</h3>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>The bridge carries ACRUX, so turn some SOL into ACRUX first. Skip this if you already hold ACRUX on Solana.</p>
      <div className="token-box">
        <div className="token-box-head"><span>You pay</span>
          <button className="ghost" style={{ padding: 0 }} onClick={() => setAmt(fmt(max, 9, 9).replace(/,/g, ''))}>
            You have <span className="num">{fmt(lamports, 9, 4)}</span> SOL
          </button>
        </div>
        <div className="token-box-row">
          <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" aria-label="SOL to swap" />
          <span className="token-badge">SOL</span>
        </div>
      </div>
      <div className="flip" aria-hidden="true">↓</div>
      <div className="token-box">
        <div className="token-box-head"><span>You get on Solana</span></div>
        <div className="token-box-row">
          <span className="num" style={{ fontSize: 22 }}>{quote ? fmt(BigInt(quote.outAmount), ACRUX_SOLANA_DECIMALS, 2) : '0'}</span>
          <span className="token-badge">ACRUX</span>
        </div>
        {quote && <small className="muted">At least {fmt(BigInt(quote.otherAmountThreshold), ACRUX_SOLANA_DECIMALS, 2)} ACRUX · price impact {impact.toFixed(2)}% · via Jupiter</small>}
      </div>
      {quote && impact >= 5 && <p className="error" style={{ marginBottom: 0 }}>Price impact is {impact.toFixed(1)}%: the ACRUX pool on Solana is small, so a big swap costs you. Splitting it into smaller swaps is cheaper.</p>}
      {problems.length > 0 && amt && <p className="error" style={{ marginBottom: 0 }}>{problems[0]}</p>}
      <button className="primary" style={{ width: '100%', height: 44, marginTop: 14 }} disabled={!!busy || problems.length > 0 || !quote} onClick={swap}>
        {busy ?? (quote ? `Swap ${amt} SOL for ACRUX` : 'Swap SOL for ACRUX')}
      </button>
      {done && <p className="up" style={{ margin: '10px 0 0', fontSize: 13 }}>Swapped for {fmt(done.out, ACRUX_SOLANA_DECIMALS, 2)} ACRUX · <a href={`https://solscan.io/tx/${done.sig}`} target="_blank" rel="noopener noreferrer">view</a>. Step 2 is filled in: bridge it below.</p>}
      {err && <p className="error">{err}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ the way back: Acrux -> Solana

/** Native ACRUX kept back on Acrux for the fee and the withdrawal record's rent. */
const OUT_RESERVE = 10_000_000n // 0.01 ACRUX

function BridgeOut({ sol, ext }: { sol: Connection; ext: SolWallet | null }) {
  const w = useWallet()
  const [amt, setAmt] = useState('')
  const [to, setTo] = useState('')
  const [editTo, setEditTo] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [sent, setSent] = useState<{ sig: string; amount: bigint; to: PublicKey; before: bigint; paid: boolean } | null>(null)

  // Where it lands: by default the same address on Solana (one key, both chains).
  const recipient = useMemo(() => {
    const s = to.trim()
    if (!editTo || !s) return w.publicKey
    try { return new PublicKey(s) } catch { return null }
  }, [to, editTo, w.publicKey?.toBase58()])
  const ata = recipient ? getAssociatedTokenAddressSync(ACRUX_SOLANA_MINT, recipient, true) : null

  const state = useAsync(async () => {
    if (!w.publicKey) return null
    const [native, ataInfo, solLamports] = await Promise.all([
      w.conn.getBalance(w.publicKey).then(BigInt),
      ata ? sol.getAccountInfo(ata).catch(() => undefined) : Promise.resolve(undefined),
      sol.getBalance(w.publicKey).then(BigInt).catch(() => 0n),
    ])
    const onSolana = ataInfo ? BigInt((await sol.getTokenAccountBalance(ata!).catch(() => null))?.value.amount ?? 0) : 0n
    // undefined = couldn't check, null = no account (payout would wait), object = ready.
    return { native, ataReady: ataInfo === undefined ? null : !!ataInfo, onSolana, solLamports }
  }, [w.publicKey?.toBase58(), ata?.toBase58(), tick])

  // After sending, watch the recipient's ACRUX on Solana until the payout lands.
  useEffect(() => {
    if (!sent || sent.paid) return
    const t = setInterval(async () => {
      const now = BigInt((await sol.getTokenAccountBalance(getAssociatedTokenAddressSync(ACRUX_SOLANA_MINT, sent.to, true)).catch(() => null))?.value.amount ?? 0)
      if (now >= sent.before + sent.amount) { setSent({ ...sent, paid: true }); setTick(x => x + 1); tap('success') }
    }, 5000)
    return () => clearInterval(t)
  }, [sent])

  if (!w.publicKey) return <div className="card"><NeedWallet /></div>

  const raw = parseAmount(amt, ACRUX_SOLANA_DECIMALS) // 6 decimals, as the bridge counts
  const maxRaw = state.data && state.data.native > OUT_RESERVE ? (state.data.native - OUT_RESERVE) / 1000n : 0n
  const ataMissing = state.data?.ataReady === false
  const problems = [
    !raw || raw <= 0n ? 'Enter an amount.' : null,
    raw && raw < ACRUX_MIN_WITHDRAWAL ? 'The bridge takes at least 1 ACRUX.' : null,
    raw && state.data && raw > maxRaw ? `You can send at most ${fmt(maxRaw, ACRUX_SOLANA_DECIMALS, 2)} ACRUX (a little stays back for the fee).` : null,
    !recipient ? 'That Solana address is not valid.' : null,
    ataMissing ? 'Open the ACRUX account on Solana first (below), or the payout has nowhere to land.' : null,
  ].filter(Boolean) as string[]

  // Opening the recipient's ACRUX token account on Solana: signed by this wallet's key
  // (same address on Solana) or by Phantom/Backpack, whoever pays the ~0.002 SOL.
  async function openAccount() {
    setErr(null); setBusy('Opening the account…')
    try {
      let payer: PublicKey
      if (w.signWithKey) payer = w.publicKey!
      else if (ext) payer = new PublicKey((await ext.connect()).publicKey.toString())
      else throw new Error('Needs a Solana wallet to pay about 0.002 SOL. Open this in Phantom, or use the app wallet.')
      const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer, ata!, recipient!, ACRUX_SOLANA_MINT))
      tx.feePayer = payer
      tx.recentBlockhash = (await sol.getLatestBlockhash('confirmed')).blockhash
      if (w.signWithKey && payer.equals(w.publicKey!)) {
        w.signWithKey(tx)
        const sig = await sol.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
        await confirmSolana(sol, sig)
      } else {
        await confirmSolana(sol, (await ext!.signAndSendTransaction(tx)).signature)
      }
      setTick(x => x + 1)
    } catch (e: any) {
      const m = e?.message ?? String(e)
      setErr(/insufficient|0x1|AccountNotFound/i.test(m) ? 'Not enough SOL to open it: send about 0.005 SOL to this address on Solana first.' : m)
    } finally { setBusy(null) }
  }

  async function withdraw() {
    setErr(null); setBusy('Sending…')
    try {
      const before = BigInt((await sol.getTokenAccountBalance(ata!).catch(() => null))?.value.amount ?? 0)
      const sequence = await acruxBridgeNextWithdrawal(w.conn)
      const sig = await w.send(new Transaction().add(acruxBridgeWithdrawNative({ owner: w.publicKey!, recipient: recipient!, amount: raw!, sequence })))
      setSent({ sig, amount: raw!, to: recipient!, before, paid: false })
      setAmt('')
      w.bump(); setTick(x => x + 1)
    } catch (e: any) {
      const m = e?.message ?? String(e)
      setErr(/already in use|ConstraintSeeds|2006/.test(m) ? 'Someone else bridged out at the same moment. Try again.' : m)
      tap('error')
    } finally { setBusy(null) }
  }

  const plain = (v: bigint) => fmt(v, ACRUX_SOLANA_DECIMALS, ACRUX_SOLANA_DECIMALS).replace(/,/g, '')
  return (
    <>
      <div className="card">
        <div className="token-box">
          <div className="token-box-head"><span>From Acrux</span>
            <button className="ghost" style={{ padding: 0 }} onClick={() => setAmt(plain(maxRaw))}>
              You have <span className="num">{state.data ? fmt(state.data.native, 9, 2) : '…'}</span> ACRUX
            </button>
          </div>
          <div className="token-box-row">
            <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0" aria-label="ACRUX to bridge back" />
            <span className="token-badge">ACRUX</span>
          </div>
        </div>
        <div className="flip" aria-hidden="true">↓</div>
        <div className="token-box">
          <div className="token-box-head"><span>To Solana</span><button className="ghost" style={{ padding: 0 }} onClick={() => setEditTo(x => !x)}>{editTo ? 'Use my address' : 'Send somewhere else'}</button></div>
          <div className="token-box-row">
            <span className="num" style={{ fontSize: 22 }}>{raw ? fmt(raw, ACRUX_SOLANA_DECIMALS, 2) : '0'}</span>
            <span className="token-badge">ACRUX</span>
          </div>
          {editTo
            ? <input className="mono" value={to} onChange={e => setTo(e.target.value)} placeholder="Solana address" spellCheck={false} style={{ marginTop: 8 }} />
            : <small className="muted">Arrives at <span className="mono">{short(w.publicKey, 6)}</span> on Solana, your same address{state.data && state.data.ataReady ? <> (holds <span className="num">{fmt(state.data.onSolana, ACRUX_SOLANA_DECIMALS, 2)}</span> ACRUX there now)</> : ''}.</small>}
        </div>
        {ataMissing && (
          <div className="notice" style={{ marginTop: 12 }}>
            <strong>This Solana address has no ACRUX account yet.</strong> The payout needs one to land in, or it waits.
            Opening it costs about 0.002 SOL on Solana{w.signWithKey ? <> from this wallet (it has <span className="num">{state.data ? fmt(state.data.solLamports, 9, 4) : '…'}</span> SOL there)</> : ''}.
            <button style={{ width: '100%', height: 40, marginTop: 10 }} disabled={!!busy} onClick={openAccount}>{busy === 'Opening the account…' ? busy : 'Open ACRUX account on Solana'}</button>
          </div>
        )}
        {problems.length > 0 && amt && <p className="error" style={{ marginBottom: 0 }}>{problems[0]}</p>}
        <button className="primary" style={{ width: '100%', height: 44, marginTop: 14 }} disabled={!!busy || problems.length > 0} onClick={withdraw}>
          {busy && busy !== 'Opening the account…' ? busy : `Bridge${raw ? ` ${fmt(raw, ACRUX_SOLANA_DECIMALS, 2)}` : ''} ACRUX to Solana`}
        </button>
        <p className="faint" style={{ fontSize: 12, margin: '10px 0 0' }}>Minimum 1 ACRUX · a little ACRUX stays back for the fee · sent through Acrux’s own bridge · this can’t be undone, so check the address</p>
        {err && <p className="error">{err}</p>}
      </div>
      {sent && (
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>{sent.paid ? 'Paid on Solana ✓' : 'On its way…'}</h2>
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Burned on Acrux · <a href={`#Explorer/${sent.sig}`}>view</a></li>
            <li>{sent.paid
              ? <>Paid <strong className="num">{fmt(sent.amount, ACRUX_SOLANA_DECIMALS, 2)} ACRUX</strong> to <span className="mono">{short(sent.to)}</span> on Solana · <a href={`https://solscan.io/account/${sent.to.toBase58()}`} target="_blank" rel="noopener noreferrer">Solscan</a></>
              : 'Waiting for Acrux to pay it out on Solana (usually about a minute). It’s recorded, so it pays out even if you close this page.'}</li>
          </ol>
        </div>
      )}
    </>
  )
}
