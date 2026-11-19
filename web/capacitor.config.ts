// The iPhone and Android apps: the same site, built into the app (not loaded from
// acruxhub.com), so it opens offline-fast and passes store review as a real app.
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.acruxhub.app',
  appName: 'AcruxHub',
  webDir: 'dist',
  backgroundColor: '#08090c',
  android: {
    // Never allow plain-http content inside the app.
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'never',
    scheme: 'AcruxHub',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#08090c',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#08090c',
      overlaysWebView: false,
    },
  },
}

export default config
