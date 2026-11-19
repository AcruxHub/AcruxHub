// What changes when the site runs inside the iPhone/Android app (Capacitor):
//  - API calls go to acruxhub.com, since the app's own origin has no /api.
//  - The wallet key lives in the iOS Keychain / Android Keystore instead of web
//    storage, which the OS may clear and other code in the page could read.
//  - Status bar, splash screen and the Android back button behave natively.
import { Capacitor } from '@capacitor/core'

export const isNative = Capacitor.isNativePlatform()
export const platform = Capacitor.getPlatform() as 'web' | 'ios' | 'android'

/** Prefix for the site's own /api routes. */
export const API_BASE = isNative ? 'https://acruxhub.com' : ''

/** Keys kept in secure storage when native. Everything else stays in localStorage. */
const SECURE_KEYS = new Set(['acruxhub.testWallet'])
const mem = new Map<string, string>()
let secureStorage: typeof import('@aparajita/capacitor-secure-storage').SecureStorage | null = null

const local = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}

/**
 * Storage the wallet uses. Reads are synchronous (from memory, loaded at start by
 * initNative); writes to secure keys go through to the Keychain/Keystore.
 */
export const store = {
  get(k: string): string | null {
    if (isNative && SECURE_KEYS.has(k)) return mem.get(k) ?? null
    return local.get(k)
  },
  set(k: string, v: string) {
    if (isNative && SECURE_KEYS.has(k)) {
      mem.set(k, v)
      secureStorage?.set(k, v).catch(e => console.error('secure storage write failed', e))
      return
    }
    local.set(k, v)
  },
  del(k: string) {
    if (isNative && SECURE_KEYS.has(k)) {
      mem.delete(k)
      secureStorage?.remove(k).catch(() => {})
      return
    }
    local.del(k)
  },
}

/** Runs before the app renders. A no-op on the website. */
export async function initNative() {
  if (!isNative) return
  document.documentElement.classList.add('native', `native-${platform}`)

  const { SecureStorage } = await import('@aparajita/capacitor-secure-storage')
  secureStorage = SecureStorage
  await SecureStorage.setKeyPrefix('acruxhub_')
  for (const k of SECURE_KEYS) {
    let v = (await SecureStorage.get(k).catch(() => null)) as string | null
    // Move anything an older build left in web storage into secure storage.
    const old = local.get(k)
    if (!v && old) { await SecureStorage.set(k, old); v = old }
    if (old) local.del(k)
    if (v) mem.set(k, typeof v === 'string' ? v : JSON.stringify(v))
  }

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
  document.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin) {
      e.preventDefault()
      window.open(url.href, '_system')
    }
  }, true)

  requestAnimationFrame(() => SplashScreen.hide().catch(() => {}))
}

/** A light tap on supported phones; silent everywhere else. */
export async function tap(kind: 'light' | 'success' | 'error' = 'light') {
  if (!isNative) return
  const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics')
  if (kind === 'light') await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
  else await Haptics.notification({ type: kind === 'success' ? NotificationType.Success : NotificationType.Error }).catch(() => {})
}
