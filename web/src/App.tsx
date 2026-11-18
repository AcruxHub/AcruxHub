import { useEffect, useState } from 'react'
import { useWallet } from './wallet.tsx'
import { short, NETWORKS, refreshDemoTokens } from './net.ts'
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
  x: 'https://x.com/AruxHub',
  github: 'https://github.com/acruxhub/acruxhub',
}

const TABS = ['Swap', 'Pools', 'Launch', 'Bridge', 'Explorer', 'Portfolio', 'Docs'] as const
type Tab = (typeof TABS)[number]

function tabFromHash(): Tab {
  const h = decodeURIComponent(location.hash.slice(1).split('/')[0])
  return (TABS as readonly string[]).includes(h) ? (h as Tab) : 'Swap'
}

export function App() {
  const w = useWallet()
  const [tab, setTab] = useState<Tab>(tabFromHash)
  useEffect(() => {
    const on = () => setTab(tabFromHash())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const live = useAsync(() => deployed(w.conn), [w.conn])
  // Demo-token mints can change when Acrux Net restarts: load the live ones.
  useEffect(() => { refreshDemoTokens(w.network).then(changed => { if (changed) w.bump() }) }, [w.network])

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#Swap">
          <img src="/logo.png" alt="" />
          <span>AcruxHub</span>
        </a>
        <nav>
          {TABS.map(t => (
            <a key={t} href={`#${t}`} className={t === tab ? 'on' : ''}>{t}</a>
          ))}
        </nav>
        <div className="right">
          <Socials />
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
        {tab === 'Swap' && <Swap />}
        {tab === 'Pools' && <Pools />}
        {tab === 'Launch' && <Launch />}
        {tab === 'Bridge' && <Bridge />}
        {tab === 'Explorer' && <Explorer />}
        {tab === 'Portfolio' && <Portfolio />}
        {tab === 'Docs' && <Docs />}
      </main>

      <footer>
        <div className="footer-links">
          <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer">X</a>
          <a href={SOCIAL.github} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="#Docs">Docs</a>
          <a href="#Docs/security">Security</a>
        </div>
        Independent project, not affiliated with Acrux. Test network: tokens here have no value. Code is unaudited.
      </footer>
    </div>
  )
}

function Socials() {
  return (
    <div className="socials">
      <a href={SOCIAL.x} target="_blank" rel="noopener noreferrer" aria-label="AcruxHub on X" title="X">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>
      </a>
      <a href={SOCIAL.github} target="_blank" rel="noopener noreferrer" aria-label="AcruxHub on GitHub" title="GitHub">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z"/></svg>
      </a>
    </div>
  )
}

function WalletButton() {
  const w = useWallet()
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!w.publicKey) {
    return (
      <div className="wallet">
        <button className="primary" onClick={() => setOpen(o => !o)}>Connect</button>
        {open && (
          <div className="menu">
            <button onClick={() => { w.connectTest(); setOpen(false) }}>Test wallet <small>kept in this browser, faucet funds only</small></button>
            <button onClick={() => w.connectInjected().then(() => setOpen(false), e => setErr(e.message))}>Browser wallet <small>Phantom, Backpack…</small></button>
            {err && <p className="error">{err}</p>}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="wallet">
      <button onClick={() => setOpen(o => !o)}>{short(w.publicKey)} <small>{w.kind === 'test' ? 'test' : ''}</small></button>
      {open && (
        <div className="menu">
          <button onClick={() => navigator.clipboard.writeText(w.publicKey!.toBase58())}>Copy address</button>
          {w.network.gateway && (
            <label className="toggle">
              <input type="checkbox" checked={w.privateMode} onChange={e => w.setPrivateMode(e.target.checked)} />
              Private sends <small>encrypted to 3 proposers, readable once 2 include it</small>
            </label>
          )}
          <button onClick={() => { w.disconnect(); setOpen(false) }}>Disconnect</button>
        </div>
      )}
    </div>
  )
}
