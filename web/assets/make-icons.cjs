// Draws the AcruxHub mark as SVG and renders the store icon + splash PNGs that
// `npx @capacitor/assets generate` turns into every iOS/Android size.
// Run: npx -y -p sharp@0.33.5 node assets/make-icons.cjs
const sharp = require('sharp')
const path = require('path')
const out = f => path.join(__dirname, f)

const star = (x, y, r) => `<g transform="translate(${x} ${y})"><circle r="${r * 1.9}" fill="url(#glow)"/><path d="M0 ${-r}Q0 0 ${r} 0Q0 0 0 ${r}Q0 0 ${-r} 0Q0 0 0 ${-r}Z" fill="#fff"/></g>`
const STARS = [[200, 82, 30], [103, 193, 23], [292, 180, 19], [200, 322, 36], [252, 264, 11]]
// Fixed "random" background specks so every run draws the same icon.
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const specks = Array.from({ length: 70 }, () => `<circle cx="${(rnd() * 400).toFixed(1)}" cy="${(rnd() * 400).toFixed(1)}" r="${(0.5 + rnd() * 1.1).toFixed(2)}" fill="#fff" opacity="${(0.25 + rnd() * 0.5).toFixed(2)}"/>`).join('')

function mark({ background = true, scale = 1 } = {}) {
  const t = `translate(200 200) scale(${scale}) translate(-200 -200)`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#1c1f63"/><stop offset="1" stop-color="#0a0b2b"/></radialGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6ee7f9"/><stop offset="1" stop-color="#a78bfa"/></linearGradient>
  </defs>
  ${background ? `<rect width="400" height="400" fill="url(#bg)"/>${specks}` : ''}
  <g transform="${t}">
    <g stroke="#8fb4ff" stroke-width="3" stroke-linecap="round" opacity=".85">
      ${STARS.map(([x, y]) => `<line x1="200" y1="200" x2="${x}" y2="${y}"/>`).join('')}
    </g>
    ${STARS.map(s => star(...s)).join('')}
    <circle cx="200" cy="200" r="30" fill="#0c0e2e" stroke="url(#ring)" stroke-width="7"/>
    <circle cx="200" cy="200" r="10" fill="#6ee7f9"/>
  </g>
</svg>`
}

const png = (svg, size, file) => sharp(Buffer.from(svg), { density: 72 * size / 400 }).resize(size, size).png().toFile(out(file))

;(async () => {
  await png(mark(), 1024, 'icon-only.png')
  await sharp(out('icon-only.png')).flatten({ background: '#0a0b2b' }).toFile(out('icon-store.png')) // no alpha (Apple)
  // Android adaptive icon: the mark inside the safe zone on a separate background.
  await png(mark({ background: false, scale: 0.62 }), 1024, 'icon-foreground.png')
  await png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><radialGradient id="bg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#1c1f63"/><stop offset="1" stop-color="#0a0b2b"/></radialGradient></defs><rect width="400" height="400" fill="url(#bg)"/></svg>`, 1024, 'icon-background.png')
  // Splash: the mark small and centred on the app background.
  const s = 2732, m = 560
  const logo = await sharp(Buffer.from(mark({ background: false })), { density: 72 * m / 400 }).resize(m, m).png().toBuffer()
  for (const f of ['splash.png', 'splash-dark.png'])
    await sharp({ create: { width: s, height: s, channels: 4, background: '#08090c' } }).composite([{ input: logo, gravity: 'center' }]).png().toFile(out(f))
  await png(mark(), 512, 'play-store-icon-512.png')
  console.log('done')
})()
