// What changes when the site runs inside an app instead of a browser:
//
// iPhone/Android app (Capacitor):
//  - API calls go to acruxhub.com, since the app's own origin has no /api.
//  - The wallet key lives in the iOS Keychain / Android Keystore.
//  - Status bar, splash screen and the Android back button behave natively.
//
// Telegram Mini App (opened from the AcruxHub bot):
//  - The wallet key lives in Telegram's SecureStorage, which is the phone's own
//    Keychain/Keystore: neither Telegram's servers nor our bot can read it.
//  - The bot's start parameter (e.g. Launch_<mint>) picks the page to open.
//
// Everywhere else (the website) the key stays in browser storage, as before.
import { Capacitor } from '@capacitor/core'
import bs58 from 'bs58'

export const isNative = Capacitor.isNativePlatform()
export const platform = Capacitor.getPlatform() as 'web' | 'ios' | 'android'
/** Opened inside Telegram: Telegram adds its launch data to the URL hash. */
export const isTelegram = !isNative && /tgWebApp(Data|Version|Platform)=/.test(location.hash + location.search)
/** Running inside an app (no browser wallet extensions available). */
export const inApp = isNative || isTelegram
/** True once the wallet key is kept in the device's secure storage (set by initNative). */
export let secureWallet = false

/** Prefix for the site's own /api routes. */
export const API_BASE = isNative ? 'https://acruxhub.com' : ''

/** Keys kept in secure storage when there is one. Everything else stays in localStorage. */
const WALLET_KEY = 'acruxhub.testWallet'
const SECURE_KEYS = new Set([WALLET_KEY])
const mem = new Map<string, string>()

type Secure = { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; remove(k: string): Promise<void> }
let secure: Secure | null = null

const local = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}

/**
 * Storage the wallet uses. Reads are synchronous (from memory, loaded at start by
 * initNative); writes to secure keys go through to secure storage.
 */
export const store = {
  get(k: string): string | null {
    if (secure && SECURE_KEYS.has(k)) return mem.get(k) ?? null
    return local.get(k)
  },
  set(k: string, v: string) {
    if (secure && SECURE_KEYS.has(k)) {
      mem.set(k, v)
      secure.set(k, v).catch(e => console.error('secure storage write failed', e))
      return
    }
    local.set(k, v)
  },
  del(k: string) {
    if (secure && SECURE_KEYS.has(k)) {
      mem.delete(k)
      secure.remove(k).catch(() => {})
      return
    }
    local.del(k)
  },
}

/** Loads secure keys into memory, moving any left in web storage into secure storage. */
async function loadSecure(s: Secure) {
  for (const k of SECURE_KEYS) {
    let v = await s.get(k).catch(() => null)
    const old = local.get(k)
    if (!v && old) { await s.set(k, old); v = old }
    if (old) local.del(k)
    if (v) mem.set(k, v)
  }
  secure = s
  secureWallet = true
}

/** Runs before the app renders. A no-op on the website. */
export async function initNative() {
  if (isTelegram) return initTelegram()
  if (!isNative) return
  document.documentElement.classList.add('native', `native-${platform}`)

  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage')
  await SecureStorage.setKeyPrefix('acruxhub_')
  await loadSecure({
    get: async k => { const v = await SecureStorage.get(k); return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v) },
    set: async (k, v) => { await SecureStorage.set(k, v) },
    remove: async k => { await SecureStorage.remove(k) },
  })

  const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
    import('@capacitor/status-bar'),
    import('@capacitor/splash-screen'),
    import('@capacitor/app'),
  ])
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {})
  if (platform === 'android') StatusBar.setBackgroundColor({ color: '#08090c' }).catch(() => {})

  // Android back button: go back a page, or leave the app from the home screen.
  App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && location.hash && location.hash !== '#Launch') history.back()
    else App.exitApp()
  })
  // Links to other sites (X, explorers, docs) open in the system browser, not inside the app.
  externalLinks(url => window.open(url, '_system'))

  requestAnimationFrame(() => SplashScreen.hide().catch(() => {}))
}

function externalLinks(open: (url: string) => void) {
  document.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin) {
      e.preventDefault()
      open(url.href)
    }
  }, true)
}

/** Pages the bot may open, as Route or Route_part_part (Telegram's startapp alphabet has
 * no slash): an address, new/send/receive/buy/sell, or a whole-number amount. */
const START = /^(Launch|Swap|Pools|Bridge|Explorer|Portfolio|Docs|Wallet|Locks)(_([1-9A-HJ-NP-Za-km-z]{32,44}|new|send|receive|buy|sell|native|\d{1,12}(p\d{1,9})?))*$/

async function initTelegram() {
  document.documentElement.classList.add('telegram')
  // Telegram's Mini App script, only inside Telegram. It reads its launch data from
  // the URL hash, so the hash is only switched to our route after it has loaded.
  await new Promise<void>((resolve) => {
    const s = document.createElement('script')
    s.src = 'https://telegram.org/js/telegram-web-app.js?59'
    s.onload = () => resolve()
    s.onerror = () => resolve()
    document.head.appendChild(s)
  })
  const tg = (window as any).Telegram?.WebApp
  // t.me links pass the page as start_param; the bot's in-chat buttons pass it as ?r=.
  const start: string = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('r') || ''
  history.replaceState(null, '', `#${START.test(start) ? start.replace(/_/g, '/') : 'Launch'}`)
  if (!tg) return
  tg.ready()
  tg.expand()
  try { tg.setHeaderColor('#08090c'); tg.setBackgroundColor('#08090c') } catch { /* older clients */ }

  // Telegram links stay in Telegram; other sites open in its in-app browser.
  externalLinks(url => (/^https:\/\/t\.me\//.test(url) ? tg.openTelegramLink(url) : tg.openLink(url)))

  // The wallet key goes in SecureStorage (device Keychain/Keystore) when the client
  // supports it. Stored as base58 (88 chars) rather than a 64-number JSON list.
  const ss = tg.SecureStorage
  if (!ss || !tg.isVersionAtLeast?.('9.0')) return
  // Every call times out: a client that never answers must not leave the app blank.
  const call = <T,>(fn: (cb: (err: string | null, v: T) => void) => void, ms = 2500) =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new Error('SecureStorage did not answer')), ms)
      fn((err, v) => { clearTimeout(t); if (err) rej(new Error(err)); else res(v) })
    })
  const toB58 = (v: string) => (v.startsWith('[') ? bs58.encode(Uint8Array.from(JSON.parse(v))) : v)
  const fromB58 = (v: string) => JSON.stringify(Array.from(bs58.decode(v)))
  const s: Secure = {
    get: async k => { const v = await call<string | null>(cb => ss.getItem(k, cb)); return v ? fromB58(v) : null },
    set: async (k, v) => { await call<boolean>(cb => ss.setItem(k, toB58(v), cb)) },
    remove: async k => { await call<boolean>(cb => ss.removeItem(k, cb)) },
  }
  try {
    // Probe: UNSUPPORTED (e.g. Telegram Desktop) means keep the browser-storage key.
    await call<string | null>(cb => ss.getItem(WALLET_KEY, cb))
    await loadSecure(s)
  } catch (e) {
    console.warn('Telegram SecureStorage unavailable; the key stays in browser storage', e)
  }
}

/** A light tap on supported phones; silent everywhere else. */
export async function tap(kind: 'light' | 'success' | 'error' = 'light') {
  if (isTelegram) {
    const h = (window as any).Telegram?.WebApp?.HapticFeedback
    if (kind === 'light') h?.impactOccurred?.('light')
    else h?.notificationOccurred?.(kind)
    return
  }
  if (!isNative) return
  const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics')
  if (kind === 'light') await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
  else await Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error }).catch(() => {})
}

/** Inside Telegram: tell the bot this user's wallet address (public, never the key),
 * so /wallet can show their balances in chat. Telegram signs the user's identity
 * (initData), and the server checks that signature before saving anything. */
let linked = ''
export async function linkTelegramWallet(address: string) {
  const initData: string = (window as any).Telegram?.WebApp?.initData ?? ''
  if (!initData || linked === address) return
  linked = address
  await fetch(`${API_BASE || location.origin}/api/telegram?op=link`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData, address }),
  }).catch(() => { linked = '' })
}
