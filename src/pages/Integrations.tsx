import { Cpu, Info } from 'lucide-react';
import type { SourceKind } from '@/domain/types';
import { INTEGRATIONS } from '@/domain/defaults';
import { useWorkspace } from '@/state/workspace';
import { Badge, Card, cx, Mono, PageHeader, SOURCE_ICON, Toggle } from '@/components/ui';
import { useToast } from '@/components/toast';

export function IntegrationsPage() {
  const { state, updateSettings } = useWorkspace();
  const toast = useToast();

  const setStatus = (kind: SourceKind, connected: boolean) => {
    const settings = { ...state.settings, integrations: { ...state.settings.integrations, [kind]: connected ? 'connected' : 'unavailable' } } as typeof state.settings;
    updateSettings(settings, `${INTEGRATIONS.find((i) => i.kind === kind)?.name} simulated as ${connected ? 'connected' : 'unavailable'}`);
    toast({ tone: 'info', title: connected ? 'Adapter reconnected' : 'Outage simulated', body: 'Applies to the next overnight run.' });
  };

  return (
    <>
      <PageHeader title="Demo night integrations" description="The original agent reaches every system through a typed adapter interface. In Demo night each adapter is backed by deterministic simulation data. Your workspace’s own sources are in Sources." />

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-dashed border-line-strong bg-surface px-4 py-3 text-[13px]">
        <Info size={15} className="mt-0.5 shrink-0 text-ink-2" />
        <div>
          <span className="font-medium">Demo night uses simulation adapters. Production connectors would replace them.</span>{' '}
          <span className="text-ink-2">No external system is connected. The orchestrator, evaluation suite and UI don’t change when a real connector implements the same interface.</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {INTEGRATIONS.map((i) => {
          const Icon = SOURCE_ICON[i.kind];
          const connected = state.settings.integrations[i.kind] === 'connected';
          return (
            <Card key={i.kind}>
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-subtle text-ink-2">
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold">{i.name}</span>
                    <Badge tone={connected ? 'ok' : 'crit'} dot>
                      {connected ? '✓ Simulation connected' : 'Unavailable (simulated outage)'}
                    </Badge>
                  </div>
                  <Mono className="text-ink-3">{i.adapter}</Mono>
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-[13px] text-ink-2">
                {i.capabilities.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-ink-3" />
                    {c}
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <div className="text-[12px] text-ink-3">
                  Production connector candidates: <span className="text-ink-2">{i.productionCandidates.join(', ')}</span>
                </div>
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  Connected
                  <Toggle checked={connected} onChange={(v) => setStatus(i.kind, v)} label={`${i.name} connected`} />
                </label>
              </div>
            </Card>
          );
        })}

        <Card>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-subtle text-ink-2">
              <Cpu size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-semibold">Reasoning engine</span>
                <Badge tone="info">Deterministic · simulation mode</Badge>
              </div>
              <Mono className="text-ink-3">ReasoningEngine</Mono>
            </div>
          </div>
          <p className="mt-3 text-[13px] text-ink-2">
            Hypotheses come from a local deterministic reasoner, so the product works with no API key and the demo is identical every time. A model-backed reasoner is implemented behind the same interface: structured JSON output, schema validation, rejection of any cited evidence id that doesn’t exist, a timeout, and automatic fallback. It isn’t wired to a key here because a browser app shouldn’t hold one — it needs a small server-side proxy.
          </p>
          <div className={cx('mt-4 border-t border-line pt-3 text-[12px] text-ink-3')}>Confidence is always computed by the deterministic scorer, whichever engine proposes hypotheses.</div>
        </Card>
      </div>
    </>
  );
}
