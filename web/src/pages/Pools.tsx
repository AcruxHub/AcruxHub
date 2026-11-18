import { useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ammProgram, poolAddresses, depositQuote, withdrawQuote, BN } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync, tokenLabel, holdings } from '../hooks.ts'
import { loadPools, launchSymbols, decimalsOf, type PoolInfo } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, Empty } from '../ui.tsx'

export function Pools() {
  const w = useWallet()
  const pools = useAsync(() => loadPools(w.conn), [w.conn, w.refreshKey])
  const symbols = useAsync(() => launchSymbols(w.conn), [w.conn])
  const mine = useAsync(async () => (w.publicKey ? holdings(w.conn, w.publicKey) : []), [w.publicKey, w.conn, w.refreshKey])
  const [sel, setSel] = useState<string | null>(null)
  const label = (m: PublicKey) => tokenLabel(m.toBase58(), symbols.data)
  const pool = pools.data?.find(p => p.address.toBase58() === sel)

  return (
    <div className="grid">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h2>Pools</h2>
        {pools.loading && !pools.data && <Empty>Loading…</Empty>}
        {pools.error && <Empty>{pools.error}</Empty>}
        {pools.data && !pools.data.length && <Empty>No pools yet.</Empty>}
        {!!pools.data?.length && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Pair</th><th>Fee</th><th>Reserves</th><th>Swaps</th><th>Your share</th><th /></tr></thead>
              <tbody>
                {pools.data.map(p => {
                  const lp = mine.data?.find(h => h.mint === p.lpMint.toBase58())?.amount ?? 0n
                  const share = p.lpSupply > 0n ? Number((lp * 1_000_000n) / (p.lpSupply + 1000n)) / 10_000 : 0
                  return (
                    <tr key={p.address.toBase58()}>
                      <td>{label(p.mintA)} / {label(p.mintB)}<br /><small className="mono">{short(p.address)}</small></td>
                      <td>{(p.feeBps / 100).toFixed(2)}%</td>
                      <td>{fmt(p.reserveA, p.decimalsA, 2)} {label(p.mintA)}<br />{fmt(p.reserveB, p.decimalsB, 2)} {label(p.mintB)}</td>
                      <td>{p.swapCount}</td>
                      <td>{share ? share.toFixed(2) + '%' : '–'}</td>
                      <td><button onClick={() => setSel(p.address.toBase58())}>Manage</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pool && <ManagePool pool={pool} label={label} lp={mine.data?.find(h => h.mint === pool.lpMint.toBase58())?.amount ?? 0n} />}
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

function CreatePool() {
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
    <div className="card">
      <h2>Create a pool</h2>
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
    </div>
  )
}
