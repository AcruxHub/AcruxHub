import { useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { bridgeProgram, bridgeConfig, bridgeCustody, outboundAddress, consumedAddress, CHAIN, BN, allAccounts, OUTBOUND_SENDER_OFFSET } from '@acruxhub/sdk'
import { useWallet, readProvider } from '../wallet.tsx'
import { useAsync, tokenLabel } from '../hooks.ts'
import { decimalsOf } from '../data.ts'
import { fmt, parseAmount, short } from '../net.ts'
import { Action, Empty } from '../ui.tsx'

const CHAIN_NAME: Record<number, string> = { [CHAIN.solana]: 'Solana', [CHAIN.acrux]: 'Acrux Net' }

/** The other side of the bridge for each network (where to check delivery). */
const PEER: Record<string, string | null> = {
  acrux: null, // Solana side stays undeployed until the bridge is audited
  local: 'http://127.0.0.1:8899',
}

export function Bridge() {
  const w = useWallet()
  const peerRpc = PEER[w.network.id]
  const data = useAsync(async () => {
    const b = bridgeProgram(readProvider(w.conn))
    const config = await b.account.config.fetchNullable(bridgeConfig())
    if (!config) return null
    const routes = await allAccounts<any>(b, 'Route')
    const decimals = Object.fromEntries(await Promise.all(routes.map(async r => [r.account.localMint.toBase58(), await decimalsOf(w.conn, r.account.localMint)] as const)))
    const mine = w.publicKey
      ? (await allAccounts<any>(b, 'Outbound', { match: d => d.subarray(OUTBOUND_SENDER_OFFSET, OUTBOUND_SENDER_OFFSET + 32).equals(w.publicKey!.toBuffer()) })).sort((x, y) => y.account.nonce.cmp(x.account.nonce))
      : []
    return { config, routes, decimals, mine }
  }, [w.conn, w.publicKey, w.refreshKey])

  const delivered = useAsync(async () => {
    if (!peerRpc || !data.data?.mine.length) return {}
    const peer = new Connection(peerRpc, 'confirmed')
    const keys = data.data.mine.map(o => consumedAddress(o.account.sourceChain, BigInt(o.account.nonce.toString())))
    const infos = await peer.getMultipleAccountsInfo(keys)
    return Object.fromEntries(data.data.mine.map((o, i) => [o.account.nonce.toString(), !!infos[i]]))
  }, [data.data, peerRpc])

  const [routeIdx, setRouteIdx] = useState(0)
  const [amount, setAmount] = useState('')
  const [to, setTo] = useState('')

  if (data.loading && !data.data) return <div className="card narrow">Loading…</div>
  if (!data.data) {
    return (
      <div className="card narrow">
        <h2>Bridge</h2>
        <Empty>The bridge isn't live on {w.network.name}. It goes live once its Solana side is deployed, and that waits for an independent security review, because a bridge is where real money sits.</Empty>
      </div>
    )
  }
  const { config, routes, decimals, mine } = data.data
  const route = routes[routeIdx]?.account
  const dec = route ? decimals[route.localMint.toBase58()] : 6
  const raw = parseAmount(amount, dec)
  const recipient = (() => { try { return to.trim() ? new PublicKey(to.trim()) : w.publicKey } catch { return null } })()

  return (
    <div className="grid">
      <div className="card">
        <h2>Bridge</h2>
        {config.paused && <p className="error">The bridge is paused by a guardian.</p>}
        {!routes.length ? <Empty>No tokens registered yet.</Empty> : (
          <>
            <div className="field">
              <label>Token</label>
              <select value={routeIdx} onChange={e => setRouteIdx(Number(e.target.value))}>
                {routes.map((r, i) => (
                  <option key={r.publicKey.toBase58()} value={i}>
                    {tokenLabel(r.account.localMint.toBase58())} → {CHAIN_NAME[r.account.remoteChain] ?? `chain ${r.account.remoteChain}`} ({r.account.native ? 'lock' : 'burn'})
                  </option>
                ))}
              </select>
            </div>
            <div className="field"><label>Amount</label><input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0" /></div>
            <div className="field"><label>Recipient on {CHAIN_NAME[route.remoteChain]} (defaults to your address)</label><input className="mono" value={to} onChange={e => setTo(e.target.value)} placeholder={w.publicKey?.toBase58() ?? ''} /></div>
            <dl className="kv">
              <dt>Guardians</dt><dd>{config.threshold} of {config.guardians.length} must approve</dd>
              <dt>Daily cap</dt><dd>{fmt(BigInt(route.dailyCap.toString()), dec)}</dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              <Action
                label="Bridge"
                disabled={!w.publicKey || !raw || !recipient || config.paused}
                run={async () => {
                  const b = bridgeProgram(w.provider!)
                  const fresh = await b.account.config.fetch(bridgeConfig())
                  const tx = await b.methods.send(new BN(raw!.toString()), recipient!)
                    .accountsPartial({
                      user: w.publicKey!, mint: route.localMint,
                      userTokens: getAssociatedTokenAddressSync(route.localMint, w.publicKey!),
                      custody: route.native ? bridgeCustody(route.localMint) : null,
                      outbound: outboundAddress(BigInt(fresh.nextNonce.toString())),
                    })
                    .transaction()
                  const sig = await w.send(tx)
                  setAmount('')
                  w.bump()
                  return `Sent as transfer #${fresh.nextNonce.toString()}. Guardians deliver it after the source chain finalizes. ${sig}`
                }}
              />
            </div>
          </>
        )}
      </div>
      <div className="card">
        <h2>Your transfers</h2>
        {!mine.length ? <Empty>None yet.</Empty> : (
          <table>
            <thead><tr><th>#</th><th>Amount</th><th>To</th><th>Status</th></tr></thead>
            <tbody>
              {mine.map(o => {
                const n = o.account.nonce.toString()
                const done = delivered.data?.[n]
                return (
                  <tr key={n}>
                    <td>{n}</td>
                    <td>{fmt(BigInt(o.account.amount.toString()), 6)}</td>
                    <td>{CHAIN_NAME[o.account.destChain]}<br /><small className="mono">{short(o.account.recipient)}</small></td>
                    <td>{done === undefined ? '…' : done ? <span className="pill good">delivered</span> : <span className="pill cyan">awaiting guardians</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
