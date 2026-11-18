// Renders the AcruxHub profile picture (400x400) and X banner (1500x500) to PNG.
// Mark: the Southern Cross's five stars, each wired to a central hub ring.
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'

const sparkle = (x, y, r, fill) => {
  const i = r * 0.22
  return `<path d="M${x} ${y - r} Q${x + i} ${y - i} ${x + r} ${y} Q${x + i} ${y + i} ${x} ${y + r} Q${x - i} ${y + i} ${x - r} ${y} Q${x - i} ${y - i} ${x} ${y - r}Z" fill="${fill}"/>`
}

/** The mark centred at (cx, cy) scaled by s (s = 1 fits a 400 box). */
function mark(cx, cy, s) {
  const p = (dx, dy) => [cx + dx * s, cy + dy * s]
  const stars = [
    { at: p(0, -118), r: 26 }, // Gacrux (top)
    { at: p(0, 122), r: 34 }, // Acrux (foot, brightest)
    { at: p(-96, -6), r: 22 }, // Becrux (left)
    { at: p(92, -20), r: 18 }, // Delta (right)
    { at: p(52, 64), r: 11 }, // Epsilon
  ]
  const hub = p(0, 0)
  const lines = stars
    .map(({ at }) => `<line x1="${hub[0]}" y1="${hub[1]}" x2="${at[0]}" y2="${at[1]}" stroke="#8fb4ff" stroke-width="${3.2 * s}" stroke-linecap="round" opacity="0.85"/>`)
    .join('')
  const glows = stars.map(({ at, r }) => `<circle cx="${at[0]}" cy="${at[1]}" r="${r * 1.5 * s}" fill="url(#glow)"/>`).join('')
  const sparks = stars.map(({ at, r }) => sparkle(at[0], at[1], r * s, '#ffffff')).join('')
  return `
    ${lines}
    ${glows}
    <circle cx="${hub[0]}" cy="${hub[1]}" r="${30 * s}" fill="#0b1026" stroke="url(#ring)" stroke-width="${7 * s}"/>
    <circle cx="${hub[0]}" cy="${hub[1]}" r="${9 * s}" fill="#7cf3ff"/>
    ${sparks}`
}

const defs = `
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="75%">
      <stop offset="0" stop-color="#1a1f5c"/>
      <stop offset="0.55" stop-color="#0d1236"/>
      <stop offset="1" stop-color="#05071a"/>
    </radialGradient>
    <linearGradient id="wire" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7cf3ff"/>
      <stop offset="1" stop-color="#a77bff"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7cf3ff"/>
      <stop offset="1" stop-color="#b06bff"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0" stop-color="#9fe8ff" stop-opacity="0.65"/>
      <stop offset="1" stop-color="#9fe8ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="text" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#bfe9ff"/>
    </linearGradient>
  </defs>`

// Deterministic background star field.
function field(w, h, n, seed) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  return Array.from({ length: n }, () => {
    const r = rnd() < 0.9 ? 0.6 + rnd() * 0.9 : 1.6 + rnd()
    return `<circle cx="${(rnd() * w).toFixed(1)}" cy="${(rnd() * h).toFixed(1)}" r="${r.toFixed(2)}" fill="#ffffff" opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>`
  }).join('')
}

const pfp = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  ${defs}
  <rect width="400" height="400" fill="url(#bg)"/>
  ${field(400, 400, 70, 7)}
  ${mark(200, 200, 1)}
</svg>`

const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
  ${defs}
  <rect width="1500" height="500" fill="url(#bg)"/>
  ${field(1500, 500, 260, 42)}
  ${mark(1180, 250, 1.05)}
  <text x="560" y="235" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="104" font-weight="700" fill="url(#text)" letter-spacing="2">AcruxHub</text>
  <text x="560" y="300" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="32" fill="#9fb3ff" letter-spacing="3">PRIVATE SWAPS · LAUNCHPAD · BRIDGE · EXPLORER</text>
  <text x="560" y="350" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#7cf3ff" letter-spacing="6">BUILT ON ACRUX NET</text>
</svg>`

for (const [name, svg] of [['pfp', pfp], ['banner', banner]]) {
  writeFileSync(`${name}.svg`, svg)
  const png = new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng()
  writeFileSync(`${name}.png`, png)
  console.log(name, png.length, 'bytes')
}
