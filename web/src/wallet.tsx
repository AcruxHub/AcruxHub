// Wallet + network context. Two wallet kinds:
//  - "test wallet": a keypair kept in this browser, for faucet funds only
//  - an injected Solana wallet (Phantom, Backpack, ...) via window.solana
// Transactions on Acrux Net can go out "private" (threshold-encrypted to the
// slot's proposers) so no single proposer can read them before ordering.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import { privateSend, waitForTx } from '@acruxhub/sdk'
import { NETWORKS, connectionFor, type Network } from './net.ts'

type Injected = {
  publicKey?: PublicKey
  connect(): Promise<{ publicKey: PublicKey }>
  disconnect?(): Promise<void>
  signTransaction(tx: Transaction): Promise<Transaction>
  signMessage?(msg: Uint8Array): Promise<{ signature: Uint8Array } | Uint8Array>
}

type Ctx = {
  network: Network
  setNetwork(id: Network['id']): void
  conn: Connection
  publicKey: PublicKey | null
  kind: 'test' | 'injected' | null
  connectTest(): void
  connectInjected(): Promise<void>
  disconnect(): void
  exportTestKey(): string | null
  privateMode: boolean
  setPrivateMode(v: boolean): void
  provider: anchor.AnchorProvider | null
  /** Signs and sends; returns a signature or Acrux tx id. */
  send(tx: Transaction, extraSigners?: Keypair[]): Promise<string>
  refreshKey: number
  bump(): void
}

const WalletContext = createContext<Ctx | null>(null)
const KEY_STORE = 'acruxhub.testWallet'
const NET_STORE = 'acruxhub.network'

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}

function injected(): Injected | null {
  const w = window as any
  return w.phantom?.solana ?? w.backpack ?? w.solana ?? null
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [netId, setNetId] = useState<Network['id']>(() => (store.get(NET_STORE) as Network['id']) || 'acrux')
  // Production builds only talk to Acrux Net; the local chain is a dev tool.
  const network = (import.meta.env.DEV && NETWORKS[netId]) || NETWORKS.acrux
  const conn = useMemo(() => connectionFor(network), [network])
  const [test, setTest] = useState<Keypair | null>(() => {
    const raw = store.get(KEY_STORE)
    return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null
  })
  const [inj, setInj] = useState<{ w: Injected; pk: PublicKey } | null>(null)
  const [privateMode, setPrivateMode] = useState(true)
  const [refreshKey, setRefresh] = useState(0)

  const kind: Ctx['kind'] = inj ? 'injected' : test ? 'test' : null
  // Keypair.publicKey builds a new object on every read; key the memo on its string
  // so effects and memos that depend on the wallet don't re-run every render.
  const pkString = inj?.pk.toBase58() ?? test?.publicKey.toBase58() ?? null
  const publicKey = useMemo(() => (pkString ? new PublicKey(pkString) : null), [pkString])

  const setNetwork = (id: Network['id']) => { store.set(NET_STORE, id); setNetId(id) }

  const connectTest = useCallback(() => {
    const kp = test ?? Keypair.generate()
    store.set(KEY_STORE, JSON.stringify(Array.from(kp.secretKey)))
    setInj(null)
    setTest(kp)
  }, [test])

  const connectInjected = useCallback(async () => {
    const w = injected()
    if (!w) throw new Error('No Solana wallet extension found. Use the test wallet, or install Phantom or Backpack.')
    const { publicKey } = await w.connect()
    setInj({ w, pk: new PublicKey(publicKey.toString()) })
  }, [])

  const disconnect = useCallback(() => {
    inj?.w.disconnect?.().catch(() => {})
    setInj(null)
    setTest(null)
  }, [inj])

  const signTx = useCallback(async (tx: Transaction) => {
    if (inj) return inj.w.signTransaction(tx)
    if (test) { tx.partialSign(test); return tx }
    throw new Error('Connect a wallet first.')
  }, [inj, test])

  const signHeader = useCallback(async (msg: Uint8Array): Promise<Uint8Array> => {
    if (test) return (await import('@noble/curves/ed25519')).ed25519.sign(msg, test.secretKey.subarray(0, 32))
    if (inj?.w.signMessage) {
      const r = await inj.w.signMessage(msg)
      return r instanceof Uint8Array ? r : r.signature
    }
    throw new Error('This wallet cannot sign messages, so private sends are unavailable. Turn off Private mode.')
  }, [inj, test])

  const send = useCallback(async (tx: Transaction, extraSigners: Keypair[] = []) => {
    if (!publicKey) throw new Error('Connect a wallet first.')
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    tx.feePayer = publicKey
    tx.recentBlockhash = blockhash
    if (extraSigners.length) tx.partialSign(...extraSigners)
    const signed = await signTx(tx)
    const bytes = signed.serialize()

    if (network.gateway && privateMode) {
      const { id } = await privateSend(network.gateway, bytes, signHeader, { n: 3, t: 2 })
      const state = await waitForTx(network.gateway, id)
      if (state !== 'executed' && state !== 'finalized') throw new Error(`Private send ${state}. Check it in the Explorer: ${id}`)
      const sig = signed.signatures[0]?.signature
      return sig ? (await import('bs58')).default.encode(sig) : id
    }
    const sig = await conn.sendRawTransaction(bytes, { skipPreflight: false })
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`)
    return sig
  }, [conn, network, privateMode, publicKey, signHeader, signTx])

  const provider = useMemo(() => {
    if (!publicKey) return null
    const wallet = {
      publicKey,
      signTransaction: async (t: any) => signTx(t),
      signAllTransactions: async (ts: any[]) => Promise.all(ts.map(t => signTx(t))),
    }
    return new anchor.AnchorProvider(conn, wallet as any, { commitment: 'confirmed' })
  }, [conn, publicKey, signTx])

  useEffect(() => { setRefresh(r => r + 1) }, [network, publicKey])

  const value: Ctx = {
    network, setNetwork, conn, publicKey, kind, connectTest, connectInjected, disconnect,
    exportTestKey: () => (test ? JSON.stringify(Array.from(test.secretKey)) : null),
    privateMode: privateMode && !!network.gateway, setPrivateMode,
    provider, send, refreshKey, bump: () => setRefresh(r => r + 1),
  }
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
  const c = useContext(WalletContext)
  if (!c) throw new Error('useWallet outside provider')
  return c
}

/** Read-only provider for fetching program accounts without a wallet. */
export function readProvider(conn: Connection) {
  // anchor.Wallet is Node-only; reads never sign, so a stub wallet is enough.
  const wallet = {
    publicKey: Keypair.generate().publicKey,
    signTransaction: async () => { throw new Error('read-only') },
    signAllTransactions: async () => { throw new Error('read-only') },
  }
  return new anchor.AnchorProvider(conn, wallet as any, { commitment: 'confirmed' })
}
