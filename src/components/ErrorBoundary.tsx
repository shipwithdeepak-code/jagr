import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';

/** Catches render errors (e.g. a workspace saved by an older build) and offers a clean reset. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-card">
        <TriangleAlert size={20} className="mx-auto text-high" />
        <div className="mt-3 text-[15px] font-semibold">This screen couldn’t be displayed</div>
        <p className="mt-1 text-[13px] text-ink-2">The saved demo workspace may be from an older version. Resetting restores the demo defaults in this browser only.</p>
        <p className="mt-2 font-mono text-[11.5px] text-ink-3">{this.state.error.message}</p>
        <div className="mt-4 flex justify-center gap-2">
          <a href="/" className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-[13px] font-medium hover:bg-subtle">
            Go to Overview
          </a>
          <button
            onClick={() => {
              try {
                Object.keys(localStorage)
                  .filter((k) => k.startsWith('nightwatch:workspace'))
                  .forEach((k) => localStorage.removeItem(k));
              } catch {
                /* ignore */
              }
              window.location.assign('/');
            }}
            className="inline-flex h-8 items-center rounded-lg bg-ink px-3 text-[13px] font-medium text-canvas"
          >
            Reset workspace
          </button>
        </div>
      </div>
    );
  }
}
