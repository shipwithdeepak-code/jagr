import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useProduct } from '@/state/productContext';
import { executionStatusText } from '@/product/view/executionStatus';

export function ManualCheckStatus() {
  const { state, server } = useProduct();
  const [refreshing, setRefreshing] = useState(false);
  const entries = Object.entries(server?.executionStatuses ?? {});
  if (!server || !entries.length) return null;
  return <section aria-label="Requested checks" className="my-4 rounded-lg border border-line bg-surface p-4">
    <div className="flex items-center justify-between"><h2 className="font-medium">Requested checks</h2><button type="button" className="interactive text-accent" onClick={async () => {
      if (refreshing) return;
      setRefreshing(true);
      try { await server.refreshExecutionStatus(); }
      finally { setRefreshing(false); }
    }} disabled={refreshing} aria-busy={refreshing}>{refreshing ? 'Refreshing status…' : 'Refresh status'}</button></div>
    {server.executionStatusError && <p role="status">Status unavailable — refresh to try again. Last known states are shown.</p>}
    <ul>{entries.map(([key, status]) => <li key={key} className="mt-3">
      <span>{state.watches.find((watch) => watch.id === status?.watchId)?.name ?? 'Requested check'}: </span><span aria-live="polite">{executionStatusText(status)}</span>
      {status?.execution.nextAttemptAt && <p>Retry scheduled for {status.execution.nextAttemptAt}</p>}
      {status?.result?.disposition === 'checked' && <div>{status.result.investigationIds.map((id) => <Link className="mr-3 text-accent underline" key={id} to={`/investigations/w/${encodeURIComponent(id)}`}>Open investigation</Link>)}{status.result.truncated && <p>Additional investigation references were omitted from this bounded status response.</p>}</div>}
    </li>)}</ul>
    <p className="mt-3 text-sm text-ink-2">Execution status is separate from investigation evidence and confidence.</p>
  </section>;
}
