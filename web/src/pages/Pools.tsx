import { useState } from 'react'
import { PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  ammProgram, poolAddresses, depositQuote, withdrawQuote, BN,
  loadCpmmFeeTiers, cpmmPoolAddresses, cpmmInitializeInstruction, cpmmInitialLp, cpmmDepositQuote, cpmmLpToTokens,
  cpmmDepositInstruction, cpmmWithdrawInstruction, CPMM_LP_DECIMALS, CPMM_POOL_SIZE,
} from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync, tokenLabel, holdings } from '../hooks.ts'
import { loadMarkets, launchSymbols, decimalsOf, type PoolInfo, type Market } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, Empty } from '../ui.tsx'

// Fee rates are parts per million; show 3 decimals only when needed (0.005%).
const pct = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(ppm % 100n ? 3 : 2)}%`
const lpMintOf = (m: Market) => (m.kind === 'raydium' ? m.raydium!.pool.lpMint : m.amm!.lpMint)

export function Pools() {
  const w = useWallet()
  const markets = useAsync(() => loadMarkets(w.conn), [w.conn, w.refreshKey])
  const symbols = useAsync(() => launchSymbols(w.conn), [w.conn])
  const mine = useAsync(async () => (w.publicKey ? holdings(w.conn, w.publicKey) : []), [w.publicKey, w.conn, w.refreshKey])
  const [sel, setSel] = useState<string | null>(null)
  const label = (m: PublicKey) => tokenLabel(m.toBase58(), symbols.data)
  const market = markets.data?.find(p => p.address.toBase58() === sel)
  const lpOf = (m: Market) => mine.data?.find(h => h.mint === lpMintOf(m).toBase58())?.amount ?? 0n

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>Pools</h2>
        <p className="muted" style={{ marginTop: 0 }}>AcruxHub pools and Raydium CPMM pools on Acrux, side by side. Add liquidity to either, or create a new one below.</p>
        {markets.loading && !markets.data && <Empty>Loading…</Empty>}
        {markets.error && <Empty>{markets.error}</Empty>}
        {markets.data && !markets.data.length && <Empty>No pools yet.</Empty>}
        {!!markets.data?.length && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pair</th><th>Type</th><th>Fee</th><th>Reserves</th><th>Your share</th><th /></tr></thead>
              <tbody>
                {markets.data.map(m => {
                  const lp = lpOf(m)
                  const supply = m.kind === 'raydium' ? m.raydium!.pool.lpSupply : m.amm!.lpSupply + 1000n
                  const share = supply > 0n ? Number((lp * 1_000_000n) / supply) / 10_000 : 0
                  return (
                    <tr key={m.address.toBase58()}>
                      <td>{label(m.mintA)} / {label(m.mintB)}<br /><small className="mono">{short(m.address)}</small></td>
                      <td><span className={m.kind === 'raydium' ? 'pill cyan' : 'pill'}>{m.kind === 'raydium' ? 'Raydium' : 'AcruxHub'}</span></td>
                      <td>{pct(m.feePpm)}</td>
                      <td>{fmt(m.reserveA, m.decimalsA, 2)} {label(m.mintA)}<br />{fmt(m.reserveB, m.decimalsB, 2)} {label(m.mintB)}</td>
                      <td>{share ? share.toFixed(2) + '%' : '–'}</td>
                      <td><button onClick={() => setSel(m.address.toBase58())}>Manage</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {market?.kind === 'acruxhub' && <ManagePool key={sel} pool={market.amm!} label={label} lp={lpOf(market)} />}
      {market?.kind === 'raydium' && <ManageRaydium key={sel} market={market} label={label} lp={lpOf(market)} />}
      <CreatePool />
    </div>
  )
}

function ManagePool({ pool, label, lp }: { pool: PoolInfo; label: (m: PublicKey) => string; lp: bigint }) {
  const w = useWallet()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [rm, setRm] = useState('')
  const rawA = parseAmount(a, pool.decimalsA)
  const rawB = parseAmount(b, pool.decimalsB)
  const dq = rawA && rawB ? depositQuote(pool.reserveA, pool.reserveB, pool.lpSupply, rawA, rawB) : null
  const rawLp = parseAmount(rm, 6)
  const wq = rawLp && rawLp <= lp ? withdrawQuote(pool.reserveA, pool.reserveB, pool.lpSupply, rawLp) : null

  // Typing one side fills the other at the pool ratio.
  const syncB = (v: string) => {
    setA(v)
    const x = parseAmount(v, pool.decimalsA)
    if (x && pool.reserveA > 0n) setB(fmt((x * pool.reserveB) / pool.reserveA, pool.decimalsB).replace(/,/g, ''))
  }

  return (
    <div className="card">
      <h2>{label(pool.mintA)} / {label(pool.mintB)}</h2>
      <h3>Add liquidity</h3>
      <div className="field"><label>{label(pool.mintA)}</label><input value={a} onChange={e => syncB(e.target.value)} placeholder="0.0" /></div>
      <div className="field"><label>{label(pool.mintB)}</label><input value={b} onChange={e => setB(e.target.value)} placeholder="0.0" /></div>
      {dq && <p className="muted">Deposits {fmt(dq.amountA, pool.decimalsA)} + {fmt(dq.amountB, pool.decimalsB)} for {fmt(dq.lp, 6)} LP</p>}
      <Action
        label="Add liquidity"
        disabled={!w.publicKey || !dq || dq.lp === 0n}
        run={async () => {
          const amm = ammProgram(w.provider!)
          const tx = await amm.methods
            .addLiquidity(new BN(rawA!.toString()), new BN(rawB!.toString()), new BN(((dq!.lp * 995n) / 1000n).toString()))
            .accountsPartial({
              payer: w.publicKey!, owner: w.publicKey!, pool: pool.address, mintA: pool.mintA, mintB: pool.mintB,
              vaultA: pool.vaultA, vaultB: pool.vaultB, lpMint: pool.lpMint,
              ownerA: getAssociatedTokenAddressSync(pool.mintA, w.publicKey!), ownerB: getAssociatedTokenAddressSync(pool.mintB, w.publicKey!),
            })
            .transaction()
          const sig = await w.send(tx)
          w.bump()
          return `Added. ${sig}`
        }}
      />
      <h3>Remove liquidity</h3>
      <div className="field"><label>LP tokens (you hold {fmt(lp, 6)})</label><input value={rm} onChange={e => setRm(e.target.value)} placeholder="0.0" /></div>
      {wq && <p className="muted">Returns {fmt(wq.amountA, pool.decimalsA)} {label(pool.mintA)} + {fmt(wq.amountB, pool.decimalsB)} {label(pool.mintB)}</p>}
      <Action
        label="Remove"
        primary={false}
        disabled={!w.publicKey || !wq}
        run={async () => {
          const amm = ammProgram(w.provider!)
          const tx = await amm.methods
            .removeLiquidity(new BN(rawLp!.toString()), new BN(((wq!.amountA * 995n) / 1000n).toString()), new BN(((wq!.amountB * 995n) / 1000n).toString()))
            .accountsPartial({
              owner: w.publicKey!, pool: pool.address, vaultA: pool.vaultA, vaultB: pool.vaultB, lpMint: pool.lpMint,
              ownerA: getAssociatedTokenAddressSync(pool.mintA, w.publicKey!), ownerB: getAssociatedTokenAddressSync(pool.mintB, w.publicKey!),
              ownerLp: getAssociatedTokenAddressSync(pool.lpMint, w.publicKey!),
            })
            .preInstructions(await ensureAtas(w, [pool.mintA, pool.mintB]))
            .transaction()
          const sig = await w.send(tx)
          w.bump()
          return `Removed. ${sig}`
        }}
      />
    </div>
  )
}

async function ensureAtas(w: ReturnType<typeof useWallet>, mints: PublicKey[]) {
  const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token')
  return mints.map(m => createAssociatedTokenAccountIdempotentInstruction(w.publicKey!, getAssociatedTokenAddressSync(m, w.publicKey!), w.publicKey!, m))
}

function CreateAmmPool() {
  const w = useWallet()
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [fee, setFee] = useState('30')
  const [ax, setAx] = useState('')
  const [ay, setAy] = useState('')
  const valid = (s: string) => { try { return new PublicKey(s.trim()) } catch { return null } }
  const mx = valid(x)
  const my = valid(y)
  return (
    <>
      <div className="field"><label>Token mint</label><input className="mono" value={x} onChange={e => setX(e.target.value)} placeholder="mint address" /></div>
      <div className="field"><label>Other token mint</label><input className="mono" value={y} onChange={e => setY(e.target.value)} placeholder="mint address" /></div>
      <div className="row">
        <div className="field"><label>Fee (bps)</label>
          <select value={fee} onChange={e => setFee(e.target.value)}>
            <option value="5">0.05%</option><option value="30">0.30%</option><option value="100">1.00%</option>
          </select>
        </div>
      </div>
      <div className="row">
        <div className="field"><label>Initial amount (first)</label><input value={ax} onChange={e => setAx(e.target.value)} placeholder="0.0" /></div>
        <div className="field"><label>Initial amount (other)</label><input value={ay} onChange={e => setAy(e.target.value)} placeholder="0.0" /></div>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>The first deposit sets the price. A tiny amount of LP (1,000 units) is locked forever so the pool can never be emptied or share-inflated.</p>
      <Action
        label="Create and fund pool"
        disabled={!w.publicKey || !mx || !my || mx.equals(my) || !ax || !ay}
        run={async () => {
          const feeBps = Number(fee)
          const p = poolAddresses(mx!, my!, feeBps)
          const [dx, dy] = await Promise.all([decimalsOf(w.conn, mx!), decimalsOf(w.conn, my!)])
          const rx = parseAmount(ax, dx)
          const ry = parseAmount(ay, dy)
          if (!rx || !ry) throw new Error('Enter both initial amounts.')
          const swapped = !p.mintA.equals(mx!)
          const [amtA, amtB] = swapped ? [ry, rx] : [rx, ry]
          const amm = ammProgram(w.provider!)
          const exists = await w.conn.getAccountInfo(p.pool)
          const create = exists ? [] : [await amm.methods.createPool(feeBps).accountsPartial({ payer: w.publicKey!, mintA: p.mintA, mintB: p.mintB }).instruction()]
          const q = depositQuote(0n, 0n, 0n, amtA, amtB)
          const tx = await amm.methods
            .addLiquidity(new BN(amtA.toString()), new BN(amtB.toString()), new BN(q.lp.toString()))
            .accountsPartial({
              payer: w.publicKey!, owner: w.publicKey!, pool: p.pool, mintA: p.mintA, mintB: p.mintB, vaultA: p.vaultA, vaultB: p.vaultB, lpMint: p.lpMint,
              ownerA: getAssociatedTokenAddressSync(p.mintA, w.publicKey!), ownerB: getAssociatedTokenAddressSync(p.mintB, w.publicKey!),
            })
            .preInstructions(create)
            .transaction()
          const sig = await w.send(tx)
          w.bump()
          return `Pool ${short(p.pool)} created. ${sig}`
        }}
      />
    </>
  )
}

function CreatePool() {
  const [kind, setKind] = useState<'raydium' | 'acruxhub'>('raydium')
  return (
    <div className="card">
      <h2>Create a pool</h2>
      <div className="field">
        <label>Pool type</label>
        <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
          <option value="raydium">Raydium CPMM (Raydium's program, many fee tiers)</option>
          <option value="acruxhub">AcruxHub AMM (0.05%, 0.30% or 1.00%)</option>
        </select>
      </div>
      {kind === 'raydium' ? <CreateRaydiumPool /> : <CreateAmmPool />}
    </div>
  )
}

/** Mint program + decimals for any SPL Token or Token-2022 mint. */
async function mintInfo(conn: ReturnType<typeof useWallet>['conn'], mint: PublicKey) {
  const info = await conn.getAccountInfo(mint)
  if (!info) throw new Error(`${short(mint)} is not a token on this network.`)
  const m = await getMint(conn, mint, 'confirmed', info.owner)
  return { program: info.owner, decimals: m.decimals }
}

function CreateRaydiumPool() {
  const w = useWallet()
  const tiers = useAsync(() => loadCpmmFeeTiers(w.conn), [w.conn])
  const rent = useAsync(async () => {
    // Pool state, observation, two vaults, the LP mint and your LP account.
    const sizes = [CPMM_POOL_SIZE, 4075, 165, 165, 82, 165]
    const each = await Promise.all(sizes.map(n => w.conn.getMinimumBalanceForRentExemption(n)))
    return each.reduce((s, x) => s + BigInt(x), 0n)
  }, [w.conn])
  const acrux = useAsync(async () => (w.publicKey ? BigInt(await w.conn.getBalance(w.publicKey)) : null), [w.publicKey, w.conn, w.refreshKey])
  const [x, setX] = useState('')
  const [y, setY] = useState('')
  const [tierIdx, setTierIdx] = useState('0')
  const [ax, setAx] = useState('')
  const [ay, setAy] = useState('')
  const valid = (s: string) => { try { return s.trim() ? new PublicKey(s.trim()) : null } catch { return null } }
  const mx = valid(x)
  const my = valid(y)
  const open = tiers.data?.filter(t => !t.disableCreatePool) ?? []
  const tier = open.find(t => String(t.index) === tierIdx) ?? open[0]
  const infos = useAsync(async () => (mx && my && !mx.equals(my) ? Promise.all([mintInfo(w.conn, mx), mintInfo(w.conn, my)]) : null), [mx?.toBase58(), my?.toBase58(), w.conn])
  const exists = useAsync(async () => {
    if (!mx || !my || mx.equals(my) || !tier) return false
    return !!(await w.conn.getAccountInfo(cpmmPoolAddresses(tier.address, mx, my).pool))
  }, [mx?.toBase58(), my?.toBase58(), tier?.address.toBase58(), w.conn, w.refreshKey])
  const [ix, iy] = infos.data ?? []
  const rx = ix ? parseAmount(ax, ix.decimals) : null
  const ry = iy ? parseAmount(ay, iy.decimals) : null
  const cost = tier && rent.data != null ? tier.createPoolFee + rent.data : null
  const price = rx && ry && ix && iy ? (Number(ry) / 10 ** iy.decimals) / (Number(rx) / 10 ** ix.decimals) : null
  const short4 = (k: PublicKey | null) => (k ? tokenLabel(k.toBase58()) : '')

  return (
    <>
      <div className="field"><label>Token mint</label><input className="mono" value={x} onChange={e => setX(e.target.value)} placeholder="mint address" spellCheck={false} /></div>
      <div className="field"><label>Other token mint</label><input className="mono" value={y} onChange={e => setY(e.target.value)} placeholder="mint address" spellCheck={false} /></div>
      {infos.error && <small className="error">{infos.error}</small>}
      {mx && my && mx.equals(my) && <small className="error">Pick two different tokens.</small>}
      <div className="field">
        <label>Fee tier</label>
        <select value={tier ? String(tier.index) : ''} onChange={e => setTierIdx(e.target.value)} disabled={!open.length}>
          {open.map(t => <option key={t.index} value={String(t.index)}>{pct(t.tradeFeeRate)} trade fee (tier {t.index})</option>)}
        </select>
      </div>
      <div className="row">
        <div className="field"><label>Initial amount {short4(mx)}</label><input inputMode="decimal" value={ax} onChange={e => setAx(e.target.value)} placeholder="0.0" /></div>
        <div className="field"><label>Initial amount {short4(my)}</label><input inputMode="decimal" value={ay} onChange={e => setAy(e.target.value)} placeholder="0.0" /></div>
      </div>
      <dl className="kv">
        <dt>Opening price</dt><dd>{price ? `1 ${short4(mx)} = ${price.toPrecision(6)} ${short4(my)}` : '–'}</dd>
        <dt>Cost</dt><dd>{cost != null && tier ? `${fmt(cost, 9, 4)} ACRUX (${fmt(tier.createPoolFee, 9)} Raydium fee + rent)` : '–'}</dd>
        {acrux.data != null && <><dt>Your ACRUX</dt><dd>{fmt(acrux.data, 9, 4)}</dd></>}
      </dl>
      {exists.data && <small className="error">A Raydium pool for this pair already exists on this fee tier. Add liquidity to it from the list above, or pick another tier.</small>}
      <p className="muted" style={{ fontSize: 13 }}>
        The first deposit sets the price. Raydium locks a tiny amount of LP in every pool forever. The pool opens for swaps about a second after it's created and shows up on Swap right away.
      </p>
      <Action
        label="Create Raydium pool"
        disabled={!w.publicKey || !tier || !ix || !iy || !rx || !ry || !!exists.data || (cost != null && acrux.data != null && acrux.data < cost)}
        run={async () => {
          const user = w.publicKey!
          const p = cpmmPoolAddresses(tier!.address, mx!, my!)
          const xIs0 = p.mint0.equals(mx!)
          const [i0, i1] = xIs0 ? [ix!, iy!] : [iy!, ix!]
          const [amount0, amount1] = xIs0 ? [rx!, ry!] : [ry!, rx!]
          const user0 = getAssociatedTokenAddressSync(p.mint0, user, false, i0.program)
          const user1 = getAssociatedTokenAddressSync(p.mint1, user, false, i1.program)
          const checks: [PublicKey, bigint, PublicKey, number][] = [[user0, amount0, p.mint0, i0.decimals], [user1, amount1, p.mint1, i1.decimals]]
          for (const [acct, need, mint, dec] of checks) {
            let have = 0n
            try { have = BigInt((await w.conn.getTokenAccountBalance(acct)).value.amount) } catch { /* no account */ }
            if (have < need) throw new Error(`Not enough ${tokenLabel(mint.toBase58())}: you have ${fmt(have, dec)}, the pool needs ${fmt(need, dec)}.`)
          }
          const tx = new Transaction().add(cpmmInitializeInstruction({
            creator: user, config: tier!.address, mint0: p.mint0, mint1: p.mint1, program0: i0.program, program1: i1.program,
            user0, user1, userLp: getAssociatedTokenAddressSync(p.lpMint, user), amount0, amount1,
          }))
          const sig = await w.send(tx)
          w.bump()
          return `Raydium pool ${short(p.pool)} created; you received ${fmt(cpmmInitialLp(amount0, amount1), CPMM_LP_DECIMALS, 9)} LP. ${sig}`
        }}
      />
    </>
  )
}

function ManageRaydium({ market, label, lp }: { market: Market; label: (m: PublicKey) => string; lp: bigint }) {
  const w = useWallet()
  const pool = market.raydium!.pool
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [side, setSide] = useState<0 | 1>(0)
  const [rm, setRm] = useState('')
  const [slip, setSlip] = useState('1')
  const slipBps = BigInt(Math.round(Number(slip) * 100) || 0)
  const raw = side === 0 ? parseAmount(a, market.decimalsA) : parseAmount(b, market.decimalsB)
  const dq = raw ? cpmmDepositQuote(raw, side, pool.lpSupply, market.reserveA, market.reserveB) : null
  const rawLp = parseAmount(rm, CPMM_LP_DECIMALS)
  const wq = rawLp && rawLp <= lp ? cpmmLpToTokens(rawLp, pool.lpSupply, market.reserveA, market.reserveB, false) : null
  const up = (v: bigint) => (v * (10_000n + slipBps) + 9_999n) / 10_000n
  const down = (v: bigint) => (v * (10_000n - slipBps)) / 10_000n
  const plain = (v: bigint, d: number) => fmt(v, d, d).replace(/,/g, '')
  const slipOk = slipBps >= 0n && slipBps <= 5000n

  const accounts = () => {
    const owner = w.publicKey!
    return {
      pool, owner,
      userLp: getAssociatedTokenAddressSync(pool.lpMint, owner),
      user0: getAssociatedTokenAddressSync(pool.mintA, owner, false, pool.programA),
      user1: getAssociatedTokenAddressSync(pool.mintB, owner, false, pool.programB),
    }
  }
  const atas = (acc: ReturnType<typeof accounts>, withLp: boolean) => [
    ...(withLp ? [createAssociatedTokenAccountIdempotentInstruction(acc.owner, acc.userLp, acc.owner, pool.lpMint, TOKEN_PROGRAM_ID)] : []),
    createAssociatedTokenAccountIdempotentInstruction(acc.owner, acc.user0, acc.owner, pool.mintA, pool.programA),
    createAssociatedTokenAccountIdempotentInstruction(acc.owner, acc.user1, acc.owner, pool.mintB, pool.programB),
  ]

  return (
    <div className="card">
      <h2>{label(market.mintA)} / {label(market.mintB)} <span className="pill cyan">Raydium</span></h2>
      <p className="muted" style={{ marginTop: 0 }}>{pct(market.feePpm)} fee · <span className="mono">{short(market.address)}</span> · you hold {fmt(lp, CPMM_LP_DECIMALS, 9)} LP</p>
      <h3>Add liquidity</h3>
      <div className="field"><label>{label(market.mintA)}</label>
        <input inputMode="decimal" value={side === 0 ? a : dq ? plain(dq.amount0, market.decimalsA) : ''} onChange={e => { setSide(0); setA(e.target.value) }} placeholder="0.0" /></div>
      <div className="field"><label>{label(market.mintB)}</label>
        <input inputMode="decimal" value={side === 1 ? b : dq ? plain(dq.amount1, market.decimalsB) : ''} onChange={e => { setSide(1); setB(e.target.value) }} placeholder="0.0" /></div>
      <div className="field"><label>Max slippage %</label><input inputMode="decimal" value={slip} onChange={e => setSlip(e.target.value)} /></div>
      {dq && <p className="muted">Deposits {fmt(dq.amount0, market.decimalsA)} {label(market.mintA)} + {fmt(dq.amount1, market.decimalsB)} {label(market.mintB)} for {fmt(dq.lp, CPMM_LP_DECIMALS, 9)} LP</p>}
      <Action
        label="Add liquidity"
        disabled={!w.publicKey || !dq || dq.lp === 0n || !slipOk}
        run={async () => {
          const acc = accounts()
          const tx = new Transaction().add(...atas(acc, true), cpmmDepositInstruction({ ...acc, lp: dq!.lp, max0: up(dq!.amount0), max1: up(dq!.amount1) }))
          const sig = await w.send(tx)
          setA(''); setB('')
          w.bump()
          return `Added ${fmt(dq!.lp, CPMM_LP_DECIMALS, 9)} LP. ${sig}`
        }}
      />
      <h3>Remove liquidity</h3>
      <div className="field"><label>LP tokens (you hold {fmt(lp, CPMM_LP_DECIMALS, 9)})</label>
        <div className="row" style={{ gap: 8 }}>
          <input inputMode="decimal" value={rm} onChange={e => setRm(e.target.value)} placeholder="0.0" />
          <button onClick={() => setRm(plain(lp, CPMM_LP_DECIMALS))} disabled={!lp}>Max</button>
        </div>
      </div>
      {rawLp != null && rawLp > lp && <small className="error">You hold {fmt(lp, CPMM_LP_DECIMALS, 9)} LP.</small>}
      {wq && <p className="muted">Returns {fmt(wq.amount0, market.decimalsA)} {label(market.mintA)} + {fmt(wq.amount1, market.decimalsB)} {label(market.mintB)}</p>}
      <Action
        label="Remove"
        primary={false}
        disabled={!w.publicKey || !wq || !slipOk}
        run={async () => {
          const acc = accounts()
          const tx = new Transaction().add(...atas(acc, false), cpmmWithdrawInstruction({ ...acc, lp: rawLp!, min0: down(wq!.amount0), min1: down(wq!.amount1) }))
          const sig = await w.send(tx)
          setRm('')
          w.bump()
          return `Removed. ${sig}`
        }}
      />
    </div>
  )
}
