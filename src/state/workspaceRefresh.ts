/** Read-only refresh cadence. One read at a time, hidden tabs idle, cleanup cancels future reads. */
export function startWorkspaceRefresh(options: {
  visible(): boolean;
  pending(): boolean;
  read(): Promise<void>;
  onError(): void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const started = Date.now();
  const schedule = () => {
    if (stopped) return;
    const fast = options.pending() && Date.now() - started < 10 * 60_000;
    timer = setTimeout(async () => {
      if (stopped) return;
      if (options.visible()) {
        try { await options.read(); } catch { if (!stopped) options.onError(); }
      }
      schedule();
    }, fast ? 10_000 : 60_000);
  };
  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
