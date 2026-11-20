// Back up and import the key wallet. In the app this is the main wallet, so a
// backup is the only way to get funds back after deleting the app or losing the phone.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useWallet, storedKeyAddress } from './wallet.tsx'
import { secureWallet } from './native.ts'

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Portal to <body>: the sticky header's backdrop-filter would otherwise trap a fixed overlay.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function KeyBackup({ onClose }: { onClose: () => void }) {
  const w = useWallet()
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const secret = w.exportTestKey()
  if (!secret) return null
  return (
    <Modal title="Back up your key" onClose={onClose}>
      <p className="notice warn" style={{ marginTop: 0 }}>
        Anyone with this key controls the wallet and everything in it. Never share it, and never paste it into a site or chat.
        AcruxHub will never ask you for it.
      </p>
      <p className="muted">
        {secureWallet ? 'It lives only on this phone. ' : 'It lives only in this browser. '}
        Write it down or store it in a password manager. You can import it into Phantom or Backpack, or back into AcruxHub.
      </p>
      <div className={`secret mono ${shown ? '' : 'blur'}`} aria-hidden={!shown}>{secret}</div>
      <div className="row" style={{ marginTop: 12 }}>
        {!shown
          ? <button className="primary" style={{ flex: 1 }} onClick={() => setShown(true)}>Show key</button>
          : <button className="primary" style={{ flex: 1 }} onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true) }}>{copied ? 'Copied ✓' : 'Copy key'}</button>}
      </div>
    </Modal>
  )
}

export function KeyImport({ onClose }: { onClose: () => void }) {
  const w = useWallet()
  const [v, setV] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const existing = storedKeyAddress()
  const [replaceOk, setReplaceOk] = useState(false)
  return (
    <Modal title="Import a key" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Paste a secret key (base58, or the JSON number list from a keypair file). It's stored {secureWallet ? 'in this phone’s secure storage' : 'in this browser'} and never sent anywhere.
      </p>
      <textarea className="mono" rows={4} value={v} onChange={e => { setV(e.target.value); setErr(null) }} placeholder="Secret key" spellCheck={false} autoComplete="off" autoCapitalize="off" />
      {existing && (
        <label className="toggle" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={replaceOk} onChange={e => setReplaceOk(e.target.checked)} />
          Replace the key wallet already saved here ({existing.slice(0, 4)}…{existing.slice(-4)}). <small>I've backed it up, or it's empty.</small>
        </label>
      )}
      {err && <p className="error">{err}</p>}
      <button className="primary" style={{ width: '100%', marginTop: 12 }} disabled={!v.trim() || (!!existing && !replaceOk)} onClick={() => {
        try { w.importTestKey(v); onClose() } catch (e: any) { setErr(e.message) }
      }}>Import</button>
    </Modal>
  )
}
