// Unit tests for the pair keeper's decision rules (scripts/pair-rules.ts).
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, liquidityOf, pairParams, unsafeReason, DEFAULT_RULES, type TokenInfo, type KeeperState } from '../scripts/pair-rules.ts'

const Q = 9 // default quote decimals (wrapped ACRUX)
const whole = (n: number) => BigInt(Math.round(n * 10 ** Q))
const safe = (mint: string): TokenInfo => ({ mint, classic: true, mintAuthority: null, freezeAuthority: null, decimals: 6 })
const defaults = { virtualQuote: whole(30), graduationQuote: whole(20) }
const rules = { ...DEFAULT_RULES, minLiquidity: 2000, delistLiquidity: 1000, sustainHours: 24, maxPairs: 2 }
const t0 = new Date('2026-12-01T00:00:00Z')
const at = (h: number) => new Date(t0.getTime() + h * 3_600_000)
const empty: KeeperState = { mints: {}, managed: [] }
// A pool holding `quote` whole quote tokens against `tokens` whole tokens (6 decimals).
const pool = (quote: number, tokens: number, id = 'p') => ({ pool: id, quoteReserve: whole(quote), tokenReserve: BigInt(tokens * 1e6) })

test('liquidity is 2 x the quote side, summed over pools', () => {
  assert.equal(liquidityOf([pool(600, 1), pool(400, 1)], Q), 2000)
})

test('unsafe tokens are refused', () => {
  assert.equal(unsafeReason(safe('a')), null)
  assert.match(unsafeReason({ ...safe('a'), mintAuthority: 'x' })!, /mint authority/)
  assert.match(unsafeReason({ ...safe('a'), freezeAuthority: 'x' })!, /freeze/)
  assert.match(unsafeReason({ ...safe('a'), classic: false })!, /classic/)
})

test('pair params are worth the same as the default curve at the pool price', () => {
  // 1,000 quote : 50,000 tokens -> 1 quote = 50 tokens.
  const p = pairParams([pool(1000, 50_000)], defaults)!
  assert.equal(p.graduationQuote, 20n * 50n * 1_000_000n)
  assert.equal(p.virtualQuote, 30n * 50n * 1_000_000n)
  // The deepest pool sets the price.
  const q = pairParams([pool(10, 10), pool(1000, 50_000)], defaults)!
  assert.equal(q.graduationQuote, 20n * 50n * 1_000_000n)
  assert.equal(pairParams([pool(0, 0)], defaults), null)
})

test('approves only after liquidity holds for the sustain period', () => {
  const pools = { A: [pool(1500, 75_000)] } // 3,000 liquidity
  const tokens = { A: safe('A') }
  let r = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools, tokens, pairs: {}, state: empty })
  assert.equal(r.actions.length, 0, 'not yet: just crossed the line')
  r = decide({ now: at(23), rules, quoteDecimals: Q, defaults, pools, tokens, pairs: {}, state: r.state })
  assert.equal(r.actions.length, 0, 'not yet: 23h')
  r = decide({ now: at(24), rules, quoteDecimals: Q, defaults, pools, tokens, pairs: {}, state: r.state })
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].type, 'approve')
  assert.deepEqual(r.state.managed, ['A'])
})

test('a dip below the line resets the clock', () => {
  const tokens = { A: safe('A') }
  let r = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools: { A: [pool(1500, 1)] }, tokens, pairs: {}, state: empty })
  r = decide({ now: at(12), rules, quoteDecimals: Q, defaults, pools: { A: [pool(500, 1)] }, tokens, pairs: {}, state: r.state }) // 1,000 < 2,000
  r = decide({ now: at(25), rules, quoteDecimals: Q, defaults, pools: { A: [pool(1500, 1)] }, tokens, pairs: {}, state: r.state })
  assert.equal(r.actions.length, 0, 'clock restarted at 25h')
  r = decide({ now: at(49), rules, quoteDecimals: Q, defaults, pools: { A: [pool(1500, 1)] }, tokens, pairs: {}, state: r.state })
  assert.equal(r.actions.length, 1)
})

test('unsafe tokens are skipped even when liquid', () => {
  const r0 = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools: { B: [pool(5000, 1)] }, tokens: { B: { ...safe('B'), freezeAuthority: 'x' } }, pairs: {}, state: empty })
  const r = decide({ now: at(24), rules, quoteDecimals: Q, defaults, pools: { B: [pool(5000, 1)] }, tokens: { B: { ...safe('B'), freezeAuthority: 'x' } }, pairs: {}, state: r0.state })
  assert.equal(r.actions.length, 0)
  assert.match(r.notes.join(), /freeze/)
})

test('disables a keeper pair after sustained low liquidity, never an admin pair', () => {
  const tokens = { A: safe('A'), M: safe('M') }
  const pools = { A: [pool(400, 1)], M: [pool(400, 1)] } // 800 < 1,000
  const pairs = { A: { enabled: true, managed: true }, M: { enabled: true, managed: false } }
  let r = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools, tokens, pairs, state: { mints: {}, managed: ['A'] } })
  assert.equal(r.actions.length, 0)
  r = decide({ now: at(24), rules, quoteDecimals: Q, defaults, pools, tokens, pairs, state: r.state })
  assert.deepEqual(r.actions.map(x => [x.type, x.mint]), [['disable', 'A']])
})

test('between the two lines nothing changes (no flapping)', () => {
  const pools = { A: [pool(750, 1)] } // 1,500: below approve, above delist
  const pairs = { A: { enabled: true, managed: true } }
  let r = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools, tokens: { A: safe('A') }, pairs, state: { mints: {}, managed: ['A'] } })
  r = decide({ now: at(100), rules, quoteDecimals: Q, defaults, pools, tokens: { A: safe('A') }, pairs, state: r.state })
  assert.equal(r.actions.length, 0)
})

test('maxPairs caps keeper pairs; the deepest qualify first', () => {
  const pools = { A: [pool(1100, 1)], B: [pool(3000, 1)], C: [pool(2000, 1)] }
  const tokens = { A: safe('A'), B: safe('B'), C: safe('C') }
  const r0 = decide({ now: at(0), rules, quoteDecimals: Q, defaults, pools, tokens, pairs: {}, state: empty })
  const r = decide({ now: at(24), rules, quoteDecimals: Q, defaults, pools, tokens, pairs: {}, state: r0.state })
  assert.deepEqual(r.actions.map(x => x.mint), ['B', 'C'])
  assert.match(r.notes.join(), /maxPairs/)
})
