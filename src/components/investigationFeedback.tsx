import { useState, type FormEvent } from 'react';
import { FEEDBACK_REASONS, type InvestigationFeedbackInput } from '@/product/investigationFeedback';
import { serverApi } from '@/state/serverApi';
import { Button } from './ui';

export function InvestigationFeedbackForm({ workspaceId, investigationId }: { workspaceId?: string; investigationId: string }) {
  const [usefulness, setUsefulness] = useState<InvestigationFeedbackInput['usefulness'] | ''>('');
  const [reasons, setReasons] = useState<InvestigationFeedbackInput['reasons']>([]);
  const [missing, setMissing] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !usefulness || status !== 'idle') return;
    setError(undefined); setStatus('saving');
    try {
      await serverApi.investigationFeedback(workspaceId, investigationId, { usefulness, reasons, missing });
      setStatus('saved');
    } catch {
      setStatus('idle'); setError('Feedback was not saved. Please try again.');
    }
  };
  if (!workspaceId) return <p className="text-[13px] text-ink-3">Feedback is available for investigations stored in a signed-in server workspace.</p>;
  if (status === 'saved') return <p role="status" className="text-[14px] text-ok">Feedback saved to this workspace. Thank you.</p>;
  return <form onSubmit={(event) => void submit(event)} className="space-y-3">
    <fieldset disabled={status === 'saving'} className="space-y-3">
      <legend className="text-[16px] font-semibold">Was this useful?</legend>
      <div className="flex flex-wrap gap-4">{(['very_useful', 'somewhat_useful', 'not_useful'] as const).map((value) => <label key={value} className="flex items-center gap-2 text-[13px]"><input type="radio" name={`usefulness-${investigationId}`} value={value} checked={usefulness === value} onChange={() => setUsefulness(value)} required />{value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())}</label>)}</div>
      <fieldset><legend className="text-[13px] text-ink-2">What could be better? (optional)</legend><div className="mt-2 flex flex-wrap gap-4">{FEEDBACK_REASONS.map((reason) => <label key={reason} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={reasons.includes(reason)} onChange={(e) => setReasons((current) => e.target.checked ? [...current, reason] : current.filter((r) => r !== reason))} />{reason.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())}</label>)}</div></fieldset>
      <label className="block text-[13px]">What was missing? (optional)<textarea maxLength={500} value={missing} onChange={(e) => setMissing(e.target.value)} className="mt-1 w-full rounded border border-line bg-surface p-2" /></label>
      <p className="text-[12px] text-ink-3">Stored as your assessment, not proof of cause. Do not include credentials or personal customer information.</p>
      <Button type="submit" disabled={!usefulness || status === 'saving'}>{status === 'saving' ? 'Saving feedback…' : 'Save feedback'}</Button>
    </fieldset>
    {error && <p role="alert" className="text-[13px] text-crit">{error}</p>}
  </form>;
}
