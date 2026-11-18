// Acrux Net client: the gateway's native JSON-RPC (object params) and private
// (threshold) sends.
//
// A private send encrypts the signed transaction with ChaCha20-Poly1305 under a
// fresh key, erasure-codes the ciphertext into n shards (any t rebuild it) and
// Shamir-splits the key the same way, one fragment per proposer of the target
// slot. No single proposer can read the swap before t fragments are included,
// so none can front-run or sandwich it. Implemented from the published wire
// format (acrux.computer/docs/reference/wire-formats) and checked against the
// node's own Rust test vectors in tests/vectors.

import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import bs58 from 'bs58'

export const ACRUX_RPC = 'https://rpc.acrux.computer'
export const ACRUX_API = 'https://api.acrux.computer'

export type TxHeader = {
  id: string
  feePayer: string
  priorityFeePerCu: string
  computeLimit: number
  writableAccounts: string[]
  targetSlot: number
}

export type FragmentSubmission = {
  header: TxHeader
  n: number
  t: number
  index: number
  receiver: number
  fragment: string
  keyShare: string
  headerSignature: string
}

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

// ---------------------------------------------------------------- GF(256)

type Mul = (a: number, b: number) => number
const field = (reduce: number): Mul => (a, b) => {
  let p = 0
  for (; b; b >>= 1) {
    if (b & 1) p ^= a
    a = a & 0x80 ? ((a << 1) ^ reduce) & 0xff : a << 1
  }
  return p
}
/** Reed-Solomon field, polynomial 0x11d. */
const rs = field(0x1d)
/** Shamir field, polynomial 0x11b. */
const gf = field(0x1b)
const pow = (mul: Mul, a: number, n: number) => {
  let r = 1
  while (n-- > 0) r = mul(r, a)
  return r
}
const inv = (mul: Mul, a: number) => pow(mul, a, 254)

function matmul(a: number[][], b: number[][]): number[][] {
  return a.map(row => b[0].map((_, c) => row.reduce((s, v, k) => s ^ rs(v, b[k][c]), 0)))
}

function invert(m: number[][]): number[][] {
  const n = m.length
  const w = m.map((row, r) => [...row, ...row.map((_, c) => (r === c ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    const p = w.findIndex((row, r) => r >= c && row[c] !== 0)
    if (p < 0) throw new Error('singular matrix')
    ;[w[c], w[p]] = [w[p], w[c]]
    const s = inv(rs, w[c][c])
    w[c] = w[c].map(v => rs(v, s))
    for (let r = 0; r < n; r++) {
      const f = w[r][c]
      if (r !== c && f) w[r] = w[r].map((v, k) => v ^ rs(f, w[c][k]))
    }
  }
  return w.map(row => row.slice(n))
}

/** Systematic encoding matrix: Vandermonde times the inverse of its top t x t square. */
function encodingMatrix(t: number, n: number): number[][] {
  const v = Array.from({ length: n }, (_, r) => Array.from({ length: t }, (_, c) => pow(rs, r, c)))
  return matmul(v, invert(v.slice(0, t)))
}

const combine = (rows: number[][], shards: Uint8Array[]) =>
  rows.map(row => Uint8Array.from(shards[0], (_, j) => row.reduce((s, f, k) => s ^ rs(f, shards[k][j]), 0)))

// ---------------------------------------------------------------- header

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'

/** The public header the node derives from a signed transaction's wire bytes. */
export function deriveHeader(bytes: Uint8Array, targetSlot: number): TxHeader {
  let at = 0
  const take = (len: number) => {
    if (at + len > bytes.length) throw new Error('Not a signed Solana transaction.')
    return bytes.subarray(at, (at += len))
  }
  const compact = () => {
    let v = 0
    for (let shift = 0; ; shift += 7) {
      const b = take(1)[0]
      v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v
    }
  }
  take(compact() * 64)
  const message = bytes.subarray(at)
  if (take(1)[0] < 0x80) at -= 1 // legacy message: no version byte
  const [signers, roSigned, roUnsigned] = take(3)
  const keys = Array.from({ length: compact() }, () => bs58.encode(take(32)))
  take(32) // blockhash
  let limit: number | undefined
  let price = 0n
  let instructions = 0
  const programs = new Set<number>()
  for (let count = compact(); count > 0; count--) {
    const program = take(1)[0]
    take(compact())
    const data = take(compact())
    programs.add(program)
    if (keys[program] !== COMPUTE_BUDGET) instructions += 1
    else {
      const view = new DataView(data.buffer, data.byteOffset, data.length)
      if (data[0] === 2 && data.length === 5) limit = view.getUint32(1, true)
      if (data[0] === 3 && data.length === 9) price = view.getBigUint64(1, true)
    }
  }
  if (!keys.length) throw new Error('Not a signed Solana transaction.')
  const demote = !keys.includes(UPGRADEABLE_LOADER)
  const writable = (i: number) =>
    (i < signers - roSigned || (i >= signers && i < keys.length - roUnsigned)) && !(demote && programs.has(i))
  return {
    id: bytesToHex(sha256(message)),
    feePayer: keys[0],
    priorityFeePerCu: price.toString(),
    computeLimit: limit ?? Math.min(instructions * 200_000, 1_400_000),
    writableAccounts: keys.filter((_, i) => writable(i)),
    targetSlot,
  }
}

/** Compact JSON in the fixed field order: what the fee payer signs, and the AEAD's associated data. */
export function headerBytes(h: TxHeader): Uint8Array {
  const { id, feePayer, priorityFeePerCu, computeLimit, writableAccounts, targetSlot } = h
  return new TextEncoder().encode(JSON.stringify({ id, feePayer, priorityFeePerCu, computeLimit, writableAccounts, targetSlot }))
}

// ---------------------------------------------------------------- seal / open

export function seal(tx: Uint8Array, header: TxHeader, headerSignature: Uint8Array, t: number, receivers: number[]): FragmentSubmission[] {
  const n = receivers.length
  if (t < 1 || t > n || n > 3) throw new Error('Require 1 <= t <= n <= 3.')
  const key = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = chacha20poly1305(key, nonce, headerBytes(header)).encrypt(tx)

  const size = Math.ceil(ct.length / t)
  const data = Array.from({ length: t }, (_, i) => {
    const s = new Uint8Array(size)
    s.set(ct.subarray(i * size, (i + 1) * size))
    return s
  })
  const shards = [...data, ...combine(encodingMatrix(t, n).slice(t), data)]

  const coeffs = Array.from(key, b => [b, ...crypto.getRandomValues(new Uint8Array(t - 1))])
  const prefix = new Uint8Array(17)
  prefix[0] = 1
  prefix.set(nonce, 1)
  new DataView(prefix.buffer).setUint32(13, ct.length, true)
  const sig = bs58.encode(headerSignature)

  return receivers.map((receiver, index) => {
    const x = index + 1
    const share = coeffs.map(c => c.reduceRight((acc, coef) => gf(acc, x) ^ coef, 0))
    return {
      header, n, t, index, receiver,
      fragment: toBase64(Uint8Array.of(...prefix, ...shards[index])),
      keyShare: toBase64(Uint8Array.of(1, x, ...share)),
      headerSignature: sig,
    }
  })
}

/** Rebuilds the signed transaction from any t fragments of one seal, as validators do. */
export function open(fragments: FragmentSubmission[]): Uint8Array {
  const { header, n, t } = fragments[0]
  const chosen = fragments.slice(0, t)
  if (chosen.length < t || new Set(chosen.map(f => f.index)).size < t) throw new Error(`Need ${t} distinct fragments.`)
  const env = chosen.map(f => fromBase64(f.fragment))
  const len = new DataView(env[0].buffer, env[0].byteOffset).getUint32(13, true)
  const rows = encodingMatrix(t, n)
  const data = combine(invert(chosen.map(f => rows[f.index])), env.map(e => e.subarray(17)))
  const ct = Uint8Array.from(data.flatMap(s => [...s])).subarray(0, len)

  const key = new Uint8Array(32)
  chosen.forEach((f, i) => {
    const x = f.index + 1
    const basis = chosen.reduce((p, o, j) => (i === j ? p : gf(p, gf(o.index + 1, inv(gf, x ^ (o.index + 1))))), 1)
    fromBase64(f.keyShare).subarray(2).forEach((v, b) => { key[b] ^= gf(v, basis) })
  })
  return chacha20poly1305(key, env[0].subarray(1, 13), headerBytes(header)).decrypt(ct)
}

// ---------------------------------------------------------------- gateway

export class AcruxGateway {
  constructor(readonly rpcUrl = ACRUX_RPC, readonly apiUrl = ACRUX_API) {}

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = await res.json()
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.data?.error?.code ?? body.error.code })
    return body.result as T
  }

  /** Faucet grant: 2 test ACRUX plus demo tokens. */
  async faucet(address: string): Promise<unknown> {
    const res = await fetch(`${this.apiUrl}/v1/faucet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    if (!res.ok) throw new Error(`Faucet: HTTP ${res.status} ${await res.text()}`)
    return res.json()
  }
}

/** Signs bytes as the fee payer: a secret key or a wallet's signMessage. */
export type HeaderSigner = Uint8Array | ((message: Uint8Array) => Promise<Uint8Array> | Uint8Array)

const TARGET_LEAD = 4

/**
 * Sends a signed transaction privately (t-of-n threshold). Returns the transaction id
 * (hex SHA-256 of the message) and the target slot. With t = 1 it goes in the clear.
 */
export async function privateSend(
  gw: AcruxGateway,
  signedTx: Uint8Array,
  signer: HeaderSigner,
  { n = 3, t = 2 }: { n?: number; t?: number } = {},
): Promise<{ id: string; targetSlot: number }> {
  const [slots, current, schedule] = await Promise.all([
    gw.call<{ slot: number }[]>('getRecentSlots', { limit: 1 }),
    gw.call<any>('getCurrentWindow', {}),
    gw.call<any[]>('getSchedule', { limit: 8 }),
  ])
  const header = deriveHeader(signedTx, (slots.at(-1)?.slot ?? 0) + TARGET_LEAD)
  const windows = [current, ...schedule]
  const w = windows.find((x: any) => x.firstSlot <= header.targetSlot && header.targetSlot <= x.lastSlot)
  const receivers: number[] = w
    ? [...w.proposers.filter((p: any) => p.status === 'online'), ...w.proposers.filter((p: any) => p.status !== 'online')]
        .slice(0, n)
        .map((p: any) => p.index)
    : [1, 2, 3].slice(0, n)

  if (t === 1) {
    await gw.call('submitTransaction', { header, transaction: toBase64(signedTx), receivers })
    return { id: header.id, targetSlot: header.targetSlot }
  }
  const msg = headerBytes(header)
  const sig = typeof signer === 'function' ? await signer(msg) : ed25519.sign(msg, signer.subarray(0, 32))
  if (!ed25519.verify(sig, msg, bs58.decode(header.feePayer))) throw new Error('Signer is not the fee payer.')

  const fragments = seal(signedTx, header, sig, t, receivers)
  const submit = (f: FragmentSubmission) => gw.call('submitFragment', f).then(() => null, (e: unknown) => e)
  let failures = await Promise.all(fragments.map(submit))
  failures = await Promise.all(failures.map((e, i) => (e ? submit(fragments[i]) : null)))
  const failed = failures.filter(e => e !== null)
  if (n - failed.length < t) throw failed[0]
  return { id: header.id, targetSlot: header.targetSlot }
}

/** Polls until the transaction executes, fails or expires. */
export async function waitForTx(gw: AcruxGateway, id: string, timeoutMs = 30_000): Promise<string> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const tx = await gw.call<any>('getTransaction', { id }).catch(() => null)
    const state = tx?.state
    if (state && ['executed', 'finalized', 'failed', 'expired'].includes(state)) return state
    await new Promise(r => setTimeout(r, 250))
  }
  return 'timeout'
}

export { fromBase64, toBase64 }
