// Renders the markdown in /docs (the same files GitHub shows). The content is our
// own, bundled at build time, so it isn't user input.
import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'

const files = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

type Page = { slug: string; title: string; html: string }

const PAGES: Page[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, md]) => {
    const slug = path.split('/').pop()!.replace(/^\d+-/, '').replace(/\.md$/, '')
    const title = md.match(/^#\s+(.+)$/m)?.[1] ?? slug
    // Links between docs: (#Docs/fees) stays in-app; external links open in a new tab.
    const html = (marked.parse(md, { async: false }) as string).replace(
      /<a href="(https?:[^"]+)"/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer"',
    )
    return { slug, title, html }
  })

export function Docs() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const slug = decodeURIComponent(hash.split('/')[1] ?? '') || PAGES[0]?.slug
  const page = useMemo(() => PAGES.find(p => p.slug === slug) ?? PAGES[0], [slug])
  useEffect(() => { window.scrollTo(0, 0) }, [page])
  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Docs">
        {PAGES.map(p => (
          <a key={p.slug} href={`#Docs/${p.slug}`} className={p.slug === page.slug ? 'on' : ''}>{p.title}</a>
        ))}
      </nav>
      <article className="card docs-body" dangerouslySetInnerHTML={{ __html: page.html }} />
    </div>
  )
}
