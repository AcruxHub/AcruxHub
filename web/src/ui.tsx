import { useState, type ReactNode } from 'react'
import { tap } from './native.ts'

/** A button that runs an async action and shows its result or error underneath. */
export function Action({ label, run, disabled, primary = true, className }: { label: ReactNode; run: () => Promise<string | void>; disabled?: boolean; primary?: boolean; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  return (
    <div>
      <button
        className={className ?? (primary ? 'primary' : '')}
        style={{ width: '100%', height: 44 }}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true)
          setMsg(null)
          try {
            const r = await run()
            setMsg(r ? { ok: true, text: r } : null)
            tap('success')
          } catch (e: any) {
            setMsg({ ok: false, text: friendly(e) })
            tap('error')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Working…' : label}
      </button>
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </div>
  )
}

export function friendly(e: any): string {
  const code = e?.error?.errorCode?.code
  const m = e?.error?.errorMessage
  if (code) return `${code}: ${m ?? ''}`
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? []
  const anchorLine = logs.find(l => l.includes('Error Message:'))
  if (anchorLine) return anchorLine.split('Error Message:')[1].trim()
  return e?.message ?? String(e)
}

/** Click to copy, with a brief "Copied" confirmation. */
export function CopyButton({ text, label = 'Copy CA' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-btn"
      onClick={async e => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          // Fallback for browsers that block the async clipboard API.
          const t = document.createElement('textarea')
          t.value = text
          document.body.appendChild(t)
          t.select()
          document.execCommand('copy')
          t.remove()
        }
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ margin: '8px 0' }}>{children}</p>
}

export function NeedWallet() {
  return <Empty>Connect a wallet to continue.</Empty>
}

const SUBS = '₀₁₂₃₄₅₆₇₈₉'
/**
 * A price as text, with the zero count of tiny prices drawn as a real subscript
 * (0.0₇7766 -> 0.0<sub>7</sub>7766) so it reads at any font size.
 */
export function Price({ text }: { text: string }) {
  const m = text.match(/^0\.0([₀-₉]+)(\d+)$/)
  if (!m) return <>{text}</>
  const n = [...m[1]].map(c => SUBS.indexOf(c)).join('')
  return <>0.0<sub className="zeros">{n}</sub>{m[2]}</>
}
