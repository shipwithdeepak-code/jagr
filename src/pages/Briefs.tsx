import { Inbox, Mail, Moon } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MorningBriefDoc } from '@/product/types';
import { useProduct } from '@/state/productContext';
import { fmtDate, fmtTime } from '@/lib/time';
import { AttentionBadge, EmailPreview } from '@/components/product';
import { Card, cx, EmptyState, Eyebrow, PageHeader, Tabs, Toggle } from '@/components/ui';

const TIMEZONES = ['UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata'];

export function BriefsPage() {
  const { state, setBrief } = useProduct();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'briefs' | 'outbox') ?? 'briefs';
  const r = state.result;
  const emails = r?.emails ?? [];
  const selected = emails.find((e) => e.id === params.get('email')) ?? emails[0];

  return (
    <>
      <PageHeader
        title="Briefs"
        description="The morning brief summarises what Jagr found overnight — investigations, not metrics. Alerts that couldn't wait are in the outbox."
        actions={
          <Tabs
            value={tab}
            onChange={(v) => setParams(v === 'briefs' ? {} : { tab: v })}
            items={[
              { value: 'briefs', label: 'Morning briefs' },
              { value: 'outbox', label: `Email outbox (${emails.length})` },
            ]}
          />
        }
      />

      {tab === 'briefs' ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            {r?.briefs.length ? r.briefs.map((b) => <BriefDoc key={b.id} brief={b} />) : <EmptyState icon={Moon} title="No brief yet">The brief is generated at {state.brief.time} after overnight monitoring.</EmptyState>}
          </div>
          <Card className="h-fit">
            <Eyebrow className="mb-3">Brief schedule</Eyebrow>
            <div className="flex items-center justify-between">
              <span className="text-[13.5px] font-medium">Send a morning brief</span>
              <Toggle checked={state.brief.enabled} onChange={(v) => setBrief({ ...state.brief, enabled: v })} label="Morning brief" />
            </div>
            <label className="mt-3 block text-[12.5px] text-ink-3">
              Time
              <input type="time" value={state.brief.time} onChange={(e) => e.target.value && setBrief({ ...state.brief, time: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[14px] text-ink" />
            </label>
            <label className="mt-3 block text-[12.5px] text-ink-3">
              Timezone
              <select value={state.brief.timezone} onChange={(e) => setBrief({ ...state.brief, timezone: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink">
                {TIMEZONES.map((tz) => (
                  <option key={tz}>{tz}</option>
                ))}
              </select>
            </label>
            <p className="mt-3 text-[12px] text-ink-3">Separate from each watch’s monitoring frequency. The simulated night runs 18:00–08:05 UTC; a brief scheduled outside that window won’t appear until the next simulated night.</p>
          </Card>
        </div>
      ) : emails.length === 0 ? (
        <EmptyState icon={Inbox} title="No emails sent">
          Jagr only emails when something matters: HIGH findings once confirmed, CRITICAL immediately.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
          <Card padded={false} className="h-fit overflow-hidden">
            {emails.map((e) => (
              <button key={e.id} onClick={() => setParams({ tab: 'outbox', email: e.id })} className={cx('flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-subtle', selected?.id === e.id && 'bg-subtle')}>
                <span className="flex items-center gap-2 text-[12px] text-ink-3">
                  <Mail size={12} /> {fmtDate(e.sentAt)} {fmtTime(e.sentAt)} {e.attention && <AttentionBadge level={e.attention} className="ml-auto" />}
                </span>
                <span className="text-[13px] font-medium">{e.subject}</span>
              </button>
            ))}
          </Card>
          {selected && <EmailPreview email={selected} />}
        </div>
      )}
    </>
  );
}

export function BriefDoc({ brief }: { brief: MorningBriefDoc }) {
  return (
    <Card>
      <Eyebrow>
        {fmtDate(brief.generatedAt)} · {fmtTime(brief.generatedAt)} · covers {fmtTime(brief.window.start)}–{fmtTime(brief.window.end)}
      </Eyebrow>
      <h2 className="mt-2 text-[26px] font-semibold tracking-[-0.02em]">Good morning.</h2>
      <p className="mt-1 text-[16px] text-ink-2">{brief.headline}</p>

      {brief.items.length > 0 && (
        <div className="mt-5 space-y-2">
          {brief.items.map((it) => (
            <Link key={it.investigationId} to={`/investigations/w/${it.investigationId}`} className="block rounded-xl border border-line p-4 hover:border-line-strong">
              <div className="flex flex-wrap items-center gap-2">
                <AttentionBadge level={it.attention} />
                <span className="text-[15px] font-semibold">{it.title}</span>
                <span className="ml-auto text-[12px] text-ink-3">{it.emailedAt ? `Emailed ${fmtTime(it.emailedAt)}` : 'New in this brief'}</span>
              </div>
              <p className="mt-1.5 text-[13px] text-ink-2">{it.summary}</p>
              <p className="mt-1 text-[12px] text-ink-3">From {it.watchNames.join(' + ')} · {it.status.toLowerCase()}</p>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-5 rounded-xl bg-subtle px-4 py-3">
        <Eyebrow className="mb-1">Quiet</Eyebrow>
        <p className="text-[13.5px]">
          {brief.quiet.note}
          {brief.quiet.watchNames.length > 0 && <span className="text-ink-3"> ({brief.quiet.watchNames.join(', ')})</span>}
        </p>
        {brief.deduplicated.map((d) => (
          <p key={d.watchName} className="mt-1 text-[12.5px] text-ink-2">
            {d.watchName}: its findings were linked to “{d.linkedTo}” instead of reported twice.
          </p>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-ink-3">
        {brief.stats.watchRuns} watch runs · {brief.stats.sourcesChecked} sources · {brief.stats.emailsSent} {brief.stats.emailsSent === 1 ? 'email' : 'emails'} sent overnight · {brief.stats.dismissed} fluctuations dismissed
      </p>
    </Card>
  );
}
