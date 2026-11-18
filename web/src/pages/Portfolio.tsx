import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { withdrawQuote } from '@acruxhub/sdk'
import { useWallet } from '../wallet.tsx'
import { useAsync, holdings, tokenLabel } from '../hooks.ts'
import { loadPools, launchSymbols } from '../data.ts'
import { fmt } from '../net.ts'
import { Action, Empty, NeedWallet } from '../ui.tsx'

export function Portfolio() {
  const w = useWallet()
  const data = useAsync(async () => {
    if (!w.publicKey) return null
    const [lamports, toks, pools, symbols] = await Promise.all([
      w.conn.getBalance(w.publicKey),
      holdings(w.conn, w.publicKey),
      loadPools(w.conn).catch(() => []),
      launchSymbols(w.conn),
    ])
    return { lamports, toks, pools, symbols }
  }, [w.publicKey, w.conn, w.refreshKey])

  if (!w.publicKey) return <div className="card narrow"><h2>Portfolio</h2><NeedWallet /></div>
  if (data.loading && !data.data) return <div className="card narrow">Loading…</div>
  if (data.error || !data.data) return <div className="card narrow"><Empty>{data.error}</Empty></div>
  const { lamports, toks, pools, symbols } = data.data
  const lpMints = new Map(pools.map(p => [p.lpMint.toBase58(), p]))
  const plain = toks.filter(t => !lpMints.has(t.mint) && t.amount > 0n)
  const lps = toks.filter(t => lpMints.has(t.mint) && t.amount > 0n)

  return (
    <div className="grid">
      <div className="card">
        <h2>Wallet</h2>
        <p className="stat">{(lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 6 })} {w.network.explorerNative}</p>
        <small className="mono">{w.publicKey.toBase58()}</small>
        {w.network.gateway && (
          <div style={{ marginTop: 12 }}>
            {/* The faucet API only accepts browser calls from acrux.computer, so send people there. */}
            <button
              style={{ width: '100%' }}
              onClick={() => {
                navigator.clipboard?.writeText(w.publicKey!.toBase58()).catch(() => {})
                window.open('https://acrux.computer/faucet', '_blank', 'noopener')
              }}
            >
              Get test funds (opens the Acrux faucet, address copied)
            </button>
            <small>2 ACRUX + 100 AXA + 100 AXB per grant. Paste your address there, then come back and refresh.</small>
          </div>
        )}
        <h3>Tokens</h3>
        {plain.length ? plain.map(t => (
          <div key={t.account} className="row" style={{ marginBottom: 4 }}>
            <span>{tokenLabel(t.mint, symbols)}</span><span className="fixed">{fmt(t.amount, t.decimals)}</span>
          </div>
        )) : <Empty>No tokens yet.</Empty>}
      </div>
      <div className="card">
        <h2>Liquidity positions</h2>
        {lps.length ? lps.map(t => {
          const p = lpMints.get(t.mint)!
          const q = withdrawQuote(p.reserveA, p.reserveB, p.lpSupply, t.amount)
          const share = Number((t.amount * 1_000_000n) / (p.lpSupply + 1000n)) / 10_000
          return (
            <div key={t.account} style={{ marginBottom: 12 }}>
              <strong>{tokenLabel(p.mintA.toBase58(), symbols)} / {tokenLabel(p.mintB.toBase58(), symbols)}</strong> <span className="pill">{share.toFixed(2)}% of pool</span>
              <dl className="kv" style={{ marginTop: 6 }}>
                <dt>{tokenLabel(p.mintA.toBase58(), symbols)}</dt><dd>{fmt(q.amountA, p.decimalsA)}</dd>
                <dt>{tokenLabel(p.mintB.toBase58(), symbols)}</dt><dd>{fmt(q.amountB, p.decimalsB)}</dd>
              </dl>
            </div>
          )
        }) : <Empty>No LP positions. Add liquidity on the Pools tab.</Empty>}
      </div>
    </div>
  )
}
