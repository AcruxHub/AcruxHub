// Checks our independent threshold sealer against the Acrux node's Rust encoder
// test vectors. The vectors belong to the Acrux project, so they are not
// redistributed here: the first run downloads them from
// github.com/AcruxComputer/acrux (sdk/test/vectors) into tests/vectors/ (git-ignored).

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import bs58 from 'bs58'
import { ed25519 } from '@noble/curves/ed25519'
import { deriveHeader, headerBytes, open, seal, fromBase64, type FragmentSubmission } from '../sdk/src/acrux.ts'

const VECTORS = ['rust-2-of-2', 'rust-2-of-3', 'rust-3-of-3']
const SOURCE = 'https://raw.githubusercontent.com/AcruxComputer/acrux/main/sdk/test/vectors'
const dir = new URL('./vectors/', import.meta.url)
for (const name of VECTORS) {
  const file = new URL(`${name}.json`, dir)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const res = await fetch(`${SOURCE}/${name}.json`)
    if (!res.ok) throw new Error(`could not download test vector ${name}: HTTP ${res.status}`)
    const text = await res.text()
    JSON.parse(text) // data only: refuse anything that isn't JSON
    writeFileSync(file, text)
  }
}


const vector = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'))
const subsets = <T>(items: T[], size: number): T[][] =>
  size === 0 ? [[]] : items.flatMap((item, i) => subsets(items.slice(i + 1), size - 1).map(rest => [item, ...rest]))

for (const [n, t] of [[2, 2], [3, 2], [3, 3]]) {
  const rust = vector(`rust-${t}-of-${n}`)
  const bytes = fromBase64(rust.plain.transaction)

  test(`${t}-of-${n}: derived header equals the node's and its signature verifies`, () => {
    const header = deriveHeader(bytes, rust.plain.header.targetSlot)
    assert.deepEqual(header, rust.plain.header)
    assert.ok(ed25519.verify(bs58.decode(rust.fragments[0].headerSignature), headerBytes(header), bs58.decode(header.feePayer)))
  })

  test(`${t}-of-${n}: any ${t} of the node's fragments open with our decoder`, () => {
    for (const chosen of subsets<FragmentSubmission>(rust.fragments, t)) {
      assert.deepEqual(open(chosen), bytes)
      assert.deepEqual(open([...chosen].reverse()), bytes)
    }
  })

  test(`${t}-of-${n}: our fragments have the node's layout and open from any ${t}`, () => {
    const sig = bs58.decode(rust.fragments[0].headerSignature)
    const sealed = seal(bytes, rust.plain.header, sig, t, rust.plain.receivers)
    assert.equal(sealed.length, n)
    for (const f of sealed) {
      const r = rust.fragments[f.index]
      assert.equal(f.fragment.length, r.fragment.length)
      assert.equal(f.keyShare.length, r.keyShare.length)
      assert.equal(f.receiver, r.receiver)
      assert.equal(f.headerSignature, r.headerSignature)
    }
    for (const chosen of subsets(sealed, t)) assert.deepEqual(open(chosen), bytes)
    if (t > 1) assert.throws(() => open(sealed.slice(0, t - 1)))
    // A tampered header fails authentication.
    assert.throws(() => open(sealed.slice(0, t).map(f => ({ ...f, header: { ...f.header, targetSlot: f.header.targetSlot + 1 } }))))
  })
}

test('parity shard matches the reed-solomon-erasure galois_8 row [3, 2]', () => {
  const rust = vector('rust-2-of-3')
  const bytes = fromBase64(rust.plain.transaction)
  const sealed = seal(bytes, rust.plain.header, bs58.decode(rust.fragments[0].headerSignature), 2, [1, 2, 3])
  const mul = (a: number, b: number) => { let p = 0; for (; b; b >>= 1) { if (b & 1) p ^= a; a = a & 0x80 ? ((a << 1) ^ 0x1d) & 0xff : a << 1 } return p }
  for (const frags of [rust.fragments, sealed]) {
    const [d0, d1, parity] = frags.map((f: FragmentSubmission) => fromBase64(f.fragment).subarray(17))
    assert.deepEqual(parity, Uint8Array.from(d0, (b: number, i: number) => mul(3, b) ^ mul(2, d1[i])))
  }
})
