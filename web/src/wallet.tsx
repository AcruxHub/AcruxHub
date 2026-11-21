// Wallet + network context. Two wallet kinds:
//  - "key wallet": a keypair kept on this device (browser storage on the site, the
//    Keychain/Keystore in the app)
//  - an injected Solana wallet (Phantom, Backpack, ...) via window.solana
// Transactions on Acrux Net can go out "private" (threshold-encrypted to the
// slot's proposers) so no single proposer can read them before ordering.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { store } from './native.ts'
import * as anchor from '@coral-xyz/anchor'
import { privateSend, waitForTx } from '@acruxhub/sdk'
import { NETWORKS, connectionFor, type Network } from './net.ts'

type Injected = {
  publicKey?: PublicKey
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }>
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
  /** The key wallet's secret key, base58 (the format Phantom and Backpack import). */
  exportTestKey(): string | null
  /** Use a secret key (base58, or a JSON byte array) as the key wallet. */
  importTestKey(secret: string): void
  privateMode: boolean
  setPrivateMode(v: boolean): void
  provider: anchor.AnchorProvider | null
  /** Signs a transaction for ANOTHER chain (Solana, for the bridge) with the key wallet:
   * the same key is the same address on Solana and Acrux. Null for injected wallets. */
  signWithKey: ((tx: Transaction) => Transaction) | null
  /** Signs and sends; returns a signature or Acrux tx id. */
  send(tx: Transaction, extraSigners?: Keypair[]): Promise<string>
  refreshKey: number
  bump(): void
}

const WalletContext = createContext<Ctx | null>(null)
const KEY_STORE = 'acruxhub.testWallet'
const NET_STORE = 'acruxhub.network'
/** Which wallet the visitor last chose: 'key' | 'injected' | 'none'. */
const CHOICE_STORE = 'acruxhub.walletChoice'


function injected(): Injected | null {
  const w = window as any
  return w.phantom?.solana ?? w.backpack ?? w.solana ?? null
}

/** The key wallet saved on this device, if any. */
function storedKey(): Keypair | null {
  const raw = store.get(KEY_STORE)
  try { return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))) : null } catch { return null }
}

/** Address of the key wallet saved on this device, if any. */
export function storedKeyAddress(): string | null {
  return storedKey()?.publicKey.toBase58() ?? null
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [netId, setNetId] = useState<Network['id']>(() => (store.get(NET_STORE) as Network['id']) || 'acrux')
  // Production builds only talk to Acrux Net; the local chain is a dev tool.
  const network = (import.meta.env.DEV && NETWORKS[netId]) || NETWORKS.acrux
  const conn = useMemo(() => connectionFor(network), [network])
  // The wallet this visitor last chose ('key' | 'injected' | 'none'). Before this was kept,
  // a saved browser key always reconnected on load, so Phantom users had to disconnect it
  // and reconnect Phantom on every visit. Visitors from before (no choice saved) keep their key.
  const [test, setTest] = useState<Keypair | null>(() => (['injected', 'none'].includes(store.get(CHOICE_STORE) ?? '') ? null : storedKey()))
  const [inj, setInj] = useState<{ w: Injected; pk: PublicKey } | null>(null)
  // Chose Phantom/Backpack last time: reconnect quietly (onlyIfTrusted shows no popup).
  useEffect(() => {
    if (store.get(CHOICE_STORE) !== 'injected') return
    const w = injected()
    if (!w) return
    let live = true
    w.connect({ onlyIfTrusted: true }).then(({ publicKey }) => { if (live) setInj({ w, pk: new PublicKey(publicKey.toString()) }) }, () => {})
    return () => { live = false }
  }, [])
  const [privateMode, setPrivateMode] = useState(true)
  const [refreshKey, setRefresh] = useState(0)

  const kind: Ctx['kind'] = inj ? 'injected' : test ? 'test' : null
  // Keypair.publicKey builds a new object on every read; key the memo on its string
  // so effects and memos that depend on the wallet don't re-run every render.
  const pkString = inj?.pk.toBase58() ?? test?.publicKey.toBase58() ?? null
  const publicKey = useMemo(() => (pkString ? new PublicKey(pkString) : null), [pkString])

  const setNetwork = (id: Network['id']) => { store.set(NET_STORE, id); setNetId(id) }

  const connectTest = useCallback(() => {
    // Reconnect to the saved key if there is one: Disconnect only forgets the session,
    // and a fresh key here would overwrite the old one and strand its funds.
    const kp = test ?? storedKey() ?? Keypair.generate()
    store.set(KEY_STORE, JSON.stringify(Array.from(kp.secretKey)))
    store.set(CHOICE_STORE, 'key')
    setInj(null)
    setTest(kp)
  }, [test])

  const importTestKey = useCallback((secret: string) => {
    const s = secret.trim()
    let bytes: Uint8Array
    try {
      bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)
    } catch {
      throw new Error("That doesn't look like a secret key.")
    }
    if (bytes.length !== 64) throw new Error(`A secret key is 64 bytes; this one is ${bytes.length}.`)
    const kp = Keypair.fromSecretKey(bytes)
    store.set(KEY_STORE, JSON.stringify(Array.from(kp.secretKey)))
    store.set(CHOICE_STORE, 'key')
    setInj(null)
    setTest(kp)
  }, [])

  const connectInjected = useCallback(async () => {
    const w = injected()
    if (!w) throw new Error('No Solana wallet extension found. Use the test wallet, or install Phantom or Backpack.')
    const { publicKey } = await w.connect()
    store.set(CHOICE_STORE, 'injected')
    // Phantom now owns the session: the saved browser key stays saved (Browser key brings it back) but isn't active.
    setTest(null)
    setInj({ w, pk: new PublicKey(publicKey.toString()) })
  }, [])

  const disconnect = useCallback(() => {
    inj?.w.disconnect?.().catch(() => {})
    store.set(CHOICE_STORE, 'none')
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
    exportTestKey: () => (test ? bs58.encode(test.secretKey) : null),
    importTestKey,
    signWithKey: !inj && test ? (tx: Transaction) => { tx.partialSign(test); return tx } : null,
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
