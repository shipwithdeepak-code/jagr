import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConnectionView } from '@/product/connections/model';
import { checkoutConfig, checkoutMapping, type CheckoutMapping } from '@/product/view/checkoutWizard';
import { serverApi } from '@/state/serverApi';
import { Button } from './ui';

export function CheckoutMappingFields({ source, fields, onChange, disabled }: {
  source: string;
  fields: CheckoutMapping;
  onChange(fields: CheckoutMapping): void;
  disabled?: boolean;
}) {
  const input = (key: keyof CheckoutMapping, label: string, max?: number) => (
    <label className="block text-[13px]">
      {label}
      <input disabled={disabled} type={key === 'threshold' ? 'number' : 'text'}
        min={key === 'threshold' ? 0 : undefined} max={max} step="any"
        maxLength={key === 'query' ? 200 : undefined}
        value={fields[key]} onChange={e => onChange({ ...fields, [key]: e.target.value })}
        className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3" />
    </label>
  );
  return (
    <div className="space-y-3">
      {source === 'amplitude' ? <>
        {input('conversion', 'What counts as conversion? Amplitude event name')}
        {input('started', 'What counts as starting checkout? Amplitude event name')}
        {input('threshold', 'Conversion drop from baseline (%, above 0 and up to 100)', 100)}
        <p className="text-[12px] text-ink-3">Ratio of unique users for these two events, rather than an ordered funnel. Existing event filters are retained.</p>
      </> : <>
        {input('query', 'Checkout error filter (Sentry search; empty means all errors)')}
        {input('threshold', 'Error increase from baseline (%, above 0 and up to 1000)', 1000)}
      </>}
    </div>
  );
}

export function CheckoutMappingEditor({ connection, workspaceId, canManage, refresh, onPending }: {
  connection: ConnectionView;
  workspaceId: string;
  canManage: boolean;
  refresh(): Promise<void>;
  onPending(id: string, pending: boolean): void;
}) {
  const initial = checkoutMapping(connection);
  const [fields, setFields] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A new instance represents the saved configuration; the wizard retains instances between steps.
  useEffect(() => { onPending(connection.id, false); }, [connection.id]);
  if (!fields || !initial) return <p role="alert">The saved mapping cannot be edited here. Check this connection in <Link to="/sources" className="underline">Sources</Link>.</p>;
  const editable = canManage && connection.managedBy === 'workspace';
  const needsMapping = !(connection.config.metrics as { kind: string; area?: string; badDirection?: string }[])
    .some(m => m.area === 'checkout' && (connection.source === 'sentry' ? m.kind === 'errors' : m.kind === 'ratio' && m.badDirection === 'down'));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  let valid = true;
  try { checkoutConfig(connection, fields); } catch { valid = false; }

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await serverApi.connect(workspaceId, { provider: connection.provider, config: checkoutConfig(connection, fields) });
      await refresh();
      onPending(connection.id, false);
    } catch {
      setError('Mapping could not be saved and verified. Check Sources before continuing.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="font-medium">{connection.source === 'amplitude' ? 'Checkout conversion · Amplitude' : 'Technical errors · Sentry'}</h3>
      <CheckoutMappingFields source={connection.source} fields={fields} disabled={!editable || saving} onChange={next => {
        setFields(next);
        onPending(connection.id, JSON.stringify(next) !== JSON.stringify(initial));
        setError('');
      }} />
      <p className="text-[12px] text-ink-3">These source mappings are shared by all workspace watches. Other configured metrics matching this watch are also included.</p>
      {!editable && <p className="text-[12px]">{connection.managedBy === 'environment' ? 'This connection is managed by the deployment environment.' : 'An owner or admin can change this mapping.'}</p>}
      {editable && <Button disabled={saving || !valid || (!dirty && !needsMapping && !error)} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save source mapping'}
      </Button>}
      {!valid && <p role="alert" className="text-[13px]">Enter valid events and a positive threshold within the displayed limit; Sentry filters are limited to 200 characters.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
