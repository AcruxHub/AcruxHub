// Catches a crash in one page so it shows a message instead of blanking the whole app.
import { Component, type ReactNode } from 'react'

export class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('page crashed', error) }
  componentDidUpdate(prev: { resetKey: string }) {
    // Moving to another page gives it a fresh start.
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card narrow">
        <h2>Something went wrong on this page</h2>
        <p className="muted">{this.state.error.message}</p>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button onClick={() => { location.hash = '#Launch' }}>Back to coins</button>
        </div>
      </div>
    )
  }
}
