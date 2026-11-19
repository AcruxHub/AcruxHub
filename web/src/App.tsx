import { useEffect, useState } from 'react'
import { useWallet } from './wallet.tsx'
import { KeyBackup, KeyImport } from './keys.tsx'
import { isNative } from './native.ts'
import { short, NETWORKS, refreshDemoTokens, LAUNCHES_PAUSED } from './net.ts'
import { useAsync, deployed } from './hooks.ts'
import { Swap } from './pages/Swap.tsx'
import { Pools } from './pages/Pools.tsx'
import { Launch } from './pages/Launch.tsx'
import { Bridge } from './pages/Bridge.tsx'
import { Explorer } from './pages/Explorer.tsx'
import { Portfolio } from './pages/Portfolio.tsx'
import { Docs } from './pages/Docs.tsx'

/** Official links. The X handle is set in one place so a rename is a one-line change. */
export const SOCIAL = {
  x: 'https://x.com/AcruxHub',
  github: 'https://github.com/AcruxHub/AcruxHub',
}

// Routes are hash-based. #Launch stays the coins route so links people already shared keep working.
const ROUTES = ['Launch', 'Swap', 'Pools', 'Bridge', 'Explorer', 'Portfolio', 'Docs'] as const
type Route = (typeof ROUTES)[number]
const NAV: { route: Route; label: string; icon: string }[] = [
  { route: 'Launch', label: 'Coins', icon: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3L18.7 8 12 11.7 5.3 8 12 4.3ZM5 9.7l6 3.3v6.7l-6-3.3V9.7Zm8 10v-6.7l6-3.3v6.7l-6 3.3Z' },
  { route: 'Swap', label: 'Swap', icon: 'M7 7h11l-3-3 1.4-1.4L21.8 8l-5.4 5.4L15 12l3-3H7V7Zm10 10H6l3 3-1.4 1.4L2.2 16l5.4-5.4L9 12l-3 3h11v2Z' },
  { route: 'Pools', label: 'Pools', icon: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3Zm6 11.4c-1.4.7-3.6 1.1-6 1.1s-4.6-.4-6-1.1V18c.2.3 2.4 1.5 6 1.5s5.8-1.2 6-1.5v-3.6Zm0-5c-1.4.7-3.6 1.1-6 1.1S7.4 10.1 6 9.4V12c.2.3 2.4 1.5 6 1.5s5.8-1.2 6-1.5V9.4ZM12 4.5C8.4 4.5 6.2 5.7 6 6c.2.3 2.4 1.5 6 1.5S17.8 6.3 18 6c-.2-.3-2.4-1.5-6-1.5Z' },
  { route: 'Explorer', label: 'Explorer', icon: 'M10 3a7 7 0 0 1 5.6 11.2l5.6 5.6-1.4 1.4-5.6-5.6A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z' },
  { route: 'Portfolio', label: 'Portfolio', icon: 'M4 6h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm1 2v10h14v-3h-4a2 2 0 0 1 0-4h4V8H5Zm10 5h4v-1h-4v1ZM6 3h12v2H6V3Z' },
  { route: 'Docs', label: 'Docs', icon: 'M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 12h10v-1.5H7V12Zm0 4h10v-1.5H7V16Zm0-8h5V6.5H7V8Z' },
]

function routeFromHash(): Route {
  const h = decodeURIComponent(location.hash.slice(1).split('/')[0])
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : 'Launch'
}

export function App() {
  const w = useWallet()
  const [route, setRoute] = useState<Route>(routeFromHash)
  useEffect(() => {
    const on = () => { setRoute(routeFromHash()); window.scrollTo(0, 0) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const live = useAsync(() => deployed(w.conn), [w.conn])
  // Demo-token mints can change when Acrux Net restarts: load the live ones.
  useEffect(() => { refreshDemoTokens(w.network).then(changed => { if (changed) w.bump() }) }, [w.network])

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#Launch">
          <img src="/logo.png" alt="" />
          <span>AcruxHub</span>
        </a>
        <nav aria-label="Main">
          {NAV.map(n => <a key={n.route} href={`#${n.route}`} className={n.route === route ? 'on' : ''}>{n.label}</a>)}
        </nav>
        <HeaderSearch />
        <div className="right">
          <Socials />
          {!LAUNCHES_PAUSED && <button className="primary" onClick={() => { location.hash = '#Launch/new' }}>Create coin</button>}
          <select value={w.network.id} onChange={e => w.setNetwork(e.target.value as any)} aria-label="Network">
            {Object.values(NETWORKS).filter(n => import.meta.env.DEV || n.id !== 'local').map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          <WalletButton />
        </div>
      </header>

      {live.data && !live.data.amm && (
        <div className="banner warn">
          AcruxHub programs are not deployed on {w.network.name} yet. Explorer and Portfolio work now; trading pages go live once the programs are deployed.
        </div>
      )}

      <main>
        {route === 'Launch' && <Launch />}
        {route === 'Swap' && <Swap />}
        {route === 'Pools' && <Pools />}
        {route === 'Bridge' && <Bridge />}
        {route === 'Explorer' && <Explorer />}
        {route === 'Portfolio' && <Portfolio />}
        {route === 'Docs' && <Docs />}
      </main>

      <footer>
        <div className="footer-links">
          <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer">X</a>
          <a href={SOCIAL.github} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="#Docs">Docs</a>
          <a href="#Docs/fees">Fees</a>
          <a href="#Docs/security">Security</a>
          <a href="#Bridge">Bridge</a>
        </div>
        <span>Independent project, not affiliated with Acrux. The code is unaudited: use it at your own risk, only with amounts you can afford to lose.</span>
      </footer>

      <nav className="mobile-nav" aria-label="Main">
        {NAV.slice(0, 5).map(n => (
          <a key={n.route} href={`#${n.route}`} className={n.route === route ? 'on' : ''}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d={n.icon} /></svg>
            {n.label}
          </a>
        ))}
      </nav>
    </div>
  )
}

/** Search coins by name, ticker or CA from anywhere: it opens the coins board filtered. */
function HeaderSearch() {
  const [q, setQ] = useState('')
  return (
    <form className="top-search" onSubmit={e => { e.preventDefault(); if (q.trim()) location.hash = `#Launch/q:${encodeURIComponent(q.trim())}` }}>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M10 3a7 7 0 0 1 5.6 11.2l5.6 5.6-1.4 1.4-5.6-5.6A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z" /></svg>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search coins or paste a CA" aria-label="Search coins" spellCheck={false} />
    </form>
  )
}

function Socials() {
  return (
    <div className="socials">
      <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label="AcruxHub on X" title="X">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>
      </a>
      <a href={SOCIAL.github} target="_blank" rel="noopener noreferrer" aria-label="AcruxHub on GitHub" title="GitHub">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z"/></svg>
      </a>
    </div>
  )
}

function WalletButton() {
  const w = useWallet()
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [modal, setModal] = useState<'backup' | 'import' | null>(null)
  const modals = <>{modal === 'backup' && <KeyBackup onClose={() => setModal(null)} />}{modal === 'import' && <KeyImport onClose={() => setModal(null)} />}</>
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.wallet')) setOpen(false) }
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [open])
  if (!w.publicKey) {
    return (
      <div className="wallet">
        <button onClick={() => setOpen(o => !o)}>Connect</button>
        {open && (
          <div className="menu">
            {!isNative && <button onClick={() => w.connectInjected().then(() => setOpen(false), e => setErr(e.message))}>Browser wallet <small>Phantom, Backpack…</small></button>}
            <button onClick={() => { w.connectTest(); setOpen(false) }}>{isNative ? 'App wallet' : 'Browser key'} <small>{isNative ? 'a key kept in this phone’s secure storage' : 'kept in this browser: small amounts only'}</small></button>
            <button onClick={() => { setModal('import'); setOpen(false) }}>Import a key <small>restore a backup, or move a wallet in</small></button>
            {err && <p className="error" style={{ padding: '0 12px' }}>{err}</p>}
          </div>
        )}
        {modals}
      </div>
    )
  }
  return (
    <div className="wallet">
      <button onClick={() => setOpen(o => !o)}><span className="num">{short(w.publicKey)}</span>{w.kind === 'test' && <small style={{ marginLeft: 6 }}>key</small>}</button>
      {open && (
        <div className="menu">
          <button onClick={() => { navigator.clipboard.writeText(w.publicKey!.toBase58()); setOpen(false) }}>Copy address</button>
          <button onClick={() => { location.hash = '#Portfolio'; setOpen(false) }}>Portfolio</button>
          {w.network.gateway && (
            <label className="toggle">
              <input type="checkbox" checked={w.privateMode} onChange={e => w.setPrivateMode(e.target.checked)} />
              Private sends <small>encrypted to 3 proposers, readable once 2 include it</small>
            </label>
          )}
          {w.kind === 'test' && <button onClick={() => { setModal('backup'); setOpen(false) }}>Back up key</button>}
          <button onClick={() => { w.disconnect(); setOpen(false) }}>Disconnect</button>
        </div>
      )}
      {modals}
    </div>
  )
}
