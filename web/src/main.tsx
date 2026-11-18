import { Buffer } from 'buffer'
;(globalThis as any).Buffer ??= Buffer

const { createRoot } = await import('react-dom/client')
const { App } = await import('./App.tsx')
const { WalletProvider } = await import('./wallet.tsx')
await import('./styles.css')

createRoot(document.getElementById('root')!).render(
  <WalletProvider>
    <App />
  </WalletProvider>,
)
