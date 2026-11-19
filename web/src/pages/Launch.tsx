import { useEffect, useMemo, useRef, useState } from 'react'
import { Keypair, ComputeBudgetProgram, type PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import {
  launchpadProgram, launchConfig, launchAddress, allAccounts, curveBuy, curveSell, curvePrice, curveProgress, stateOf, graduateAccounts, BN,
  graduateRaydiumAccounts, loadCpmmFeeTiers, cpmmPoolAddresses, CPMM_POOL_SIZE, RAYDIUM_CPMM_ID,
  type CurveState,
} from '@acruxhub/sdk'
import { useWallet, readProvider } from '../wallet.tsx'
import { useAsync, tokenLabel } from '../hooks.ts'
import { loadLaunchConfig, decimalsOf } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, Empty, CopyButton } from '../ui.tsx'
import { useMeta, safeUrl, uploadCoin, readImage, type CoinMeta } from '../meta.ts'

type LaunchRow = { publicKey: PublicKey; account: any }
type View = { kind: 'list' } | { kind: 'create' } | { kind: 'coin'; key: string }

export function Launch() {
  const w = useWallet()
  const config = useAsync(() => loadLaunchConfig(w.conn), [w.conn])
  const launches = useAsync(async () => {
    const lp = launchpadProgram(readProvider(w.conn))
    const all = (await allAccounts(lp, 'Launch')) as LaunchRow[]
    return all.sort((a, b) => b.account.index.cmp(a.account.index))
  }, [w.conn, w.refreshKey])
  const quoteDecimals = useAsync(async () => (config.data ? decimalsOf(w.conn, config.data.quoteMint) : 9), [config.data])
  // Deep link: #Launch/<launch address> opens that coin's page.
  const fromHash = (): View => {
    const key = decodeURIComponent(location.hash.split('/')[1] ?? '')
    return key ? { kind: 'coin', key } : { kind: 'list' }
  }
  const [view, setView] = useState<View>(fromHash)
  useEffect(() => {
    const on = () => { if (location.hash.startsWith('#Launch')) setView(fromHash()) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  if (config.loading && !config.data) return <div className="card">Loading…</div>
  if (!config.data) return <div className="card"><h2>Launchpad</h2><Empty>The launchpad isn't initialized on {w.network.name} yet.</Empty></div>
  const quoteMint = config.data.quoteMint
  const quoteSym = tokenLabel(quoteMint.toBase58())
  const qd = quoteDecimals.data ?? 9

  if (view.kind === 'create') {
    return <Create quoteSym={quoteSym} qd={qd} params={config.data.params} quoteMint={quoteMint} onDone={key => setView(key ? { kind: 'coin', key } : { kind: 'list' })} />
  }
  if (view.kind === 'coin') {
    const l = launches.data?.find(x => x.publicKey.toBase58() === view.key)
    if (!l) return <div className="card narrow">{launches.loading ? 'Loading…' : <Empty>Coin not found.</Empty>}<button onClick={() => setView({ kind: 'list' })}>← Back</button></div>
    return <Coin l={l} quoteMint={quoteMint} quoteSym={quoteSym} qd={qd} onBack={() => setView({ kind: 'list' })} />
  }

  return (
    <>
      <div className="launch-hero">
        <button className="primary big" onClick={() => setView({ kind: 'create' })}>Start a new coin</button>
        <small>Free to create · fixed supply, no presale, no creator allocation · liquidity locked forever on graduation</small>
      </div>
      {launches.error && <p className="error">Could not load coins: {launches.error}</p>}
      {launches.loading && !launches.data && <Empty>Loading coins…</Empty>}
      {launches.data && !launches.data.length && <Empty>No coins yet. Be the first.</Empty>}
      <div className="coin-grid">
        {launches.data?.map(l => <CoinCard key={l.publicKey.toBase58()} l={l} quoteSym={quoteSym} qd={qd} onOpen={() => setView({ kind: 'coin', key: l.publicKey.toBase58() })} />)}
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

function CoinCard({ l, quoteSym, qd, onOpen }: { l: LaunchRow; quoteSym: string; qd: number; onOpen: () => void }) {
  const a = l.account
  const s = stateOf(a)
  const meta = useMeta(a.uri)
  return (
    <button className="coin-card" onClick={onOpen}>
      <CoinImage meta={meta} symbol={a.symbol} size={84} />
      <div className="coin-body">
        <div className="coin-title"><strong>{a.name}</strong> <span className="muted">${a.symbol}</span></div>
        {meta?.description && <p className="coin-desc">{meta.description}</p>}
        <div className="row" style={{ marginTop: 'auto' }}>
          <small>{fmt(s.realQuote, qd, 2)} / {fmt(s.graduationQuote, qd, 0)} {quoteSym}</small>
          <span className="fixed">{a.graduated ? <span className="pill good">on DEX</span> : a.complete ? <span className="pill cyan">ready</span> : <small>{(curveProgress(s) * 100).toFixed(1)}%</small>}</span>
        </div>
        <div className="bar"><div style={{ width: `${curveProgress(s) * 100}%` }} /></div>
      </div>
    </button>
  )
}

function Links({ meta }: { meta: CoinMeta | null }) {
  const links = [
    ['X', safeUrl(meta?.links?.x)],
    ['Telegram', safeUrl(meta?.links?.telegram)],
    ['Website', safeUrl(meta?.links?.website)],
  ].filter(([, u]) => u) as [string, string][]
  if (!links.length) return null
  return (
    <div className="links">
      {links.map(([label, url]) => <a key={label} className="pill" href={url} target="_blank" rel="noopener noreferrer nofollow">{label} ↗</a>)}
    </div>
  )
}

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

function Create({ quoteSym, qd, params, quoteMint, onDone }: { quoteSym: string; qd: number; params: any; quoteMint: PublicKey; onDone: (key?: string) => void }) {
  const w = useWallet()
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

  const buyRaw = firstBuy ? parseAmount(firstBuy, qd) : 0n
  const buyQuote = buyRaw ? curveBuy(freshCurve(params), buyRaw) : null
  const pick = (f: File | undefined) => {
    if (!f) return
    setImgErr(null)
    readImage(f).then(setImage, e => setImgErr(e.message))
  }

  return (
    <div className="card narrow">
      <p><button onClick={() => onDone()}>← Back</button></p>
      <h2>Start a new coin</h2>

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
        {image ? <img src={image} alt="Coin image preview" /> : <span>Drop an image here or click to upload<br /><small>PNG, JPG, GIF or WebP · up to 1 MB · square looks best</small></span>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={e => pick(e.target.files?.[0])} />
      </div>
      {imgErr && <p className="error">{imgErr}</p>}

      <div className="row">
        <div className="field"><label>Name</label><input maxLength={32} value={name} onChange={e => setName(e.target.value)} placeholder="My Coin" /></div>
        <div className="field fixed" style={{ width: 130 }}><label>Ticker</label><input maxLength={10} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9$]/g, ''))} placeholder="COIN" /></div>
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

      <div className="field">
        <label>Buy at launch (optional, {quoteSym})</label>
        <input inputMode="decimal" value={firstBuy} onChange={e => setFirstBuy(e.target.value)} placeholder="0" />
        {buyQuote && <small>≈ {fmt(buyQuote.tokensOut, 6, 0)} {symbol || 'tokens'} at the opening price, same terms as everyone else</small>}
      </div>

      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>Supply</dt><dd>{fmt(BigInt(params.totalSupply.toString()), 6, 0)}, fixed</dd>
        <dt>Graduates at</dt><dd>{fmt(BigInt(params.graduationQuote.toString()), qd)} {quoteSym} raised</dd>
        <dt>Trade fee</dt><dd>{params.feeBps / 100}%</dd>
      </dl>

      <Action
        label="Create coin"
        disabled={!w.publicKey || !name || !symbol || !image || (firstBuy !== '' && !buyQuote)}
        run={async () => {
          const { uri } = await uploadCoin({ name, symbol, description, image: image!, x, telegram, website })
          const lp = launchpadProgram(w.provider!)
          const mint = Keypair.generate()
          const launch = launchAddress(mint.publicKey)
          const create = await lp.methods.createLaunch(name, symbol, uri)
            .accountsPartial({ creator: w.publicKey!, config: launchConfig(), mint: mint.publicKey, quoteMint })
            .instruction()
          const feeRecipient = params.feeRecipient as PublicKey
          const post = buyQuote
            ? [
                createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, feeRecipient, true), feeRecipient, quoteMint),
                await lp.methods.buy(new BN(buyRaw!.toString()), new BN(buyQuote.tokensOut.toString()))
                  .accountsPartial({
                    user: w.publicKey!, launch, mint: mint.publicKey, quoteMint,
                    curveTokens: getAssociatedTokenAddressSync(mint.publicKey, launch, true),
                    curveQuote: getAssociatedTokenAddressSync(quoteMint, launch, true),
                    userTokens: getAssociatedTokenAddressSync(mint.publicKey, w.publicKey!),
                    userQuote: getAssociatedTokenAddressSync(quoteMint, w.publicKey!),
                    feeQuote: getAssociatedTokenAddressSync(quoteMint, feeRecipient, true),
                  })
                  .instruction(),
              ]
            : []
          const tx = new (await import('@solana/web3.js')).Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            create,
            ...post,
          )
          await w.send(tx, [mint])
          w.bump()
          onDone(launch.toBase58())
        }}
      />
      {!w.publicKey && <small>Connect a wallet to create a coin.</small>}
    </div>
  )
}

function Coin({ l, quoteMint, quoteSym, qd, onBack }: { l: LaunchRow; quoteMint: PublicKey; quoteSym: string; qd: number; onBack: () => void }) {
  const w = useWallet()
  const a = l.account
  const s = stateOf(a)
  const meta = useMeta(a.uri)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amt, setAmt] = useState('')
  const raw = parseAmount(amt, side === 'buy' ? qd : 6)
  const q = useMemo(() => (raw ? (side === 'buy' ? curveBuy(s, raw) : curveSell(s, raw)) : null), [raw, side, l])
  const fee = a.feeRecipient as PublicKey

  const accounts = () => ({
    user: w.publicKey!, launch: l.publicKey, mint: a.mint, quoteMint, curveTokens: a.curveTokens, curveQuote: a.curveQuote,
    userTokens: getAssociatedTokenAddressSync(a.mint, w.publicKey!),
    userQuote: getAssociatedTokenAddressSync(quoteMint, w.publicKey!),
    feeQuote: getAssociatedTokenAddressSync(quoteMint, fee, true),
  })
  const pre = () => [
    createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, fee, true), fee, quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(quoteMint, w.publicKey!), w.publicKey!, quoteMint),
  ]

  return (
    <div className="grid">
      <div className="card">
        <p><button onClick={onBack}>← All coins</button></p>
        <div className="coin-head">
          <CoinImage meta={meta} symbol={a.symbol} size={96} />
          <div>
            <h2 style={{ margin: 0 }}>{a.name} <span className="muted">${a.symbol}</span></h2>
            <small>created by <span className="mono">{short(a.creator)}</span></small>
            <Links meta={meta} />
          </div>
        </div>
        {meta?.description && <p style={{ whiteSpace: 'pre-wrap' }}>{meta.description}</p>}
        <dl className="kv">
          <dt>Price</dt><dd>{curvePrice(s).toExponential(4)} {quoteSym}</dd>
          <dt>Raised</dt><dd>{fmt(s.realQuote, qd)} / {fmt(s.graduationQuote, qd)} {quoteSym}</dd>
          <dt>Left on curve</dt><dd>{fmt(s.realTokens, 6, 0)}</dd>
          <dt>Mint</dt><dd className="mono">{short(a.mint, 6)}</dd>
        </dl>
        <div className="bar" style={{ marginTop: 10 }}><div style={{ width: `${curveProgress(s) * 100}%` }} /></div>
        <div className="ca-row">
          <small>CA <span className="mono">{a.mint.toBase58()}</span></small>
          <CopyButton text={a.mint.toBase58()} />
        </div>
      </div>

      <div className="card">
        {a.graduated ? (
          <GraduatedNote pool={a.pool} mint={a.mint} />
        ) : a.complete ? (
          <GraduatePanel a={a} quoteMint={quoteMint} />
        ) : (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <button className={side === 'buy' ? 'primary' : ''} onClick={() => setSide('buy')}>Buy</button>
              <button className={side === 'sell' ? 'primary' : ''} onClick={() => setSide('sell')}>Sell</button>
            </div>
            <div className="field">
              <label>{side === 'buy' ? `${quoteSym} to spend (fee included)` : `${a.symbol} to sell`}</label>
              <input inputMode="decimal" value={amt} onChange={e => setAmt(e.target.value)} placeholder="0.0" />
            </div>
            {q && 'tokensOut' in q && <p className="muted">≈ {fmt(q.tokensOut, 6)} {a.symbol}{q.completes ? ' · completes the curve' : ''}</p>}
            {q && 'quoteOut' in q && <p className="muted">≈ {fmt(q.quoteOut, qd)} {quoteSym} after fee</p>}
            <Action
              label={side === 'buy' ? 'Buy' : 'Sell'}
              disabled={!w.publicKey || !q}
              run={async () => {
                const lp = launchpadProgram(w.provider!)
                const tx = side === 'buy'
                  ? await lp.methods.buy(new BN(raw!.toString()), new BN((((q as any).tokensOut * 99n) / 100n).toString())).accountsPartial(accounts()).preInstructions(pre()).transaction()
                  : await lp.methods.sell(new BN(raw!.toString()), new BN((((q as any).quoteOut * 99n) / 100n).toString())).accountsPartial(accounts()).preInstructions(pre()).transaction()
                const sig = await w.send(tx)
                setAmt('')
                w.bump()
                return `Done. ${sig}`
              }}
            />
          </>
        )}
        <small>Launch account <span className="mono">{launchAddress(a.mint).toBase58()}</span></small>
      </div>
    </div>
  )
}

/** Which kind of pool a graduated coin went to, read from the pool account's owner. */
function GraduatedNote({ pool, mint }: { pool: PublicKey; mint: PublicKey }) {
  const w = useWallet()
  const owner = useAsync(async () => (await w.conn.getAccountInfo(pool))?.owner ?? null, [pool.toBase58(), w.conn])
  const venue = owner.data?.equals(RAYDIUM_CPMM_ID) ? 'a Raydium CPMM pool' : 'the AcruxHub DEX'
  return (
    <p className="ok">
      Graduated: trading on {owner.loading ? 'its pool' : venue} with liquidity locked forever. Pool <span className="mono">{short(pool)}</span>.{' '}
      <a href={`#Swap/${mint.toBase58()}`}>Trade it on Swap →</a>
    </p>
  )
}

/** A completed curve can graduate into either venue, once. */
function GraduatePanel({ a, quoteMint }: { a: any; quoteMint: PublicKey }) {
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
      <h3 style={{ marginTop: 0 }}>Ready to graduate</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        The curve is complete. Anyone can graduate it, once: all the raised quote and the matching tokens go into a pool at the curve's final price, every LP token is burned so the liquidity is locked forever, and leftover tokens are burned.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={venue === 'raydium' ? 'primary' : ''} onClick={() => setVenue('raydium')}>Raydium pool</button>
        <button className={venue === 'acruxhub' ? 'primary' : ''} onClick={() => setVenue('acruxhub')}>AcruxHub DEX</button>
      </div>
      {venue === 'raydium' ? (
        <>
          <div className="field">
            <label>Raydium fee tier</label>
            <select value={tier ? String(tier.index) : ''} onChange={e => setTierIdx(e.target.value)} disabled={!allowed.length}>
              {allowed.map(t => <option key={t.index} value={String(t.index)}>{pctOf(t.tradeFeeRate)} trade fee (tier {t.index})</option>)}
            </select>
          </div>
          <dl className="kv">
            <dt>You pay</dt><dd>{cost != null && tier ? `${fmt(cost, 9, 4)} ACRUX (${fmt(tier.createPoolFee, 9)} Raydium fee + pool rent)` : '–'}</dd>
            {acrux.data != null && <><dt>Your ACRUX</dt><dd>{fmt(acrux.data, 9, 4)}</dd></>}
          </dl>
          {taken.data && <small className="error">A Raydium pool for this coin already exists on this tier, so graduation there would fail. Pick another tier, or graduate to the AcruxHub DEX.</small>}
          {short_ && <small className="error">You need about {cost != null ? fmt(cost + 20_000_000n, 9, 3) : '0.21'} ACRUX for this.</small>}
          <p className="muted" style={{ fontSize: 13 }}>Raydium pools use Raydium's own program, so Raydium-compatible tools can trade the coin too. About 16% of a Raydium pool's trading fee goes to Raydium.</p>
          <Action
            label="Graduate to Raydium"
            disabled={!w.publicKey || !tier || !!taken.data || short_}
            run={async () => {
              const lp = launchpadProgram(w.provider!)
              const tx = await lp.methods.graduateRaydium()
                .accountsPartial({ payer: w.publicKey!, ...graduateRaydiumAccounts(a, quoteMint, tier!.address) })
                .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
                .transaction()
              const sig = await w.send(tx)
              w.bump()
              return `Graduated into a Raydium pool. ${sig}`
            }}
          />
        </>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13 }}>An AcruxHub AMM pool with a 0.30% fee. You pay only the pool's rent, and every trading fee stays in the pool.</p>
          <Action
            label="Graduate to AcruxHub DEX"
            disabled={!w.publicKey}
            run={async () => {
              const lp = launchpadProgram(w.provider!)
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
