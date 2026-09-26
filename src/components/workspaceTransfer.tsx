import { Download, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ImportPlan } from '@/product/export/workspace';
import { useProduct } from '@/state/productContext';
import { Button, Card } from './ui';
import { useToast } from './toast';

/**
 * Jagr Workspace Export v1 for a browser workspace: download it (backup, or to move it to an
 * account later) and import one — dry run, report, confirmation, then write. Nothing is replaced
 * until the user confirms what the report says.
 */
export function WorkspaceTransfer() {
  const { exportWorkspace, previewImport, applyImport } = useProduct();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const server = useServerAccount();

  const download = async () => {
    try {
      const doc = await exportWorkspace();
      const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `jagr-workspace-${doc.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast({ tone: 'warning', title: 'Export refused', body: (e as Error).message });
    }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setPlan(previewImport(await f.text()));
    if (file.current) file.current.value = '';
  };

  const r = plan?.report;
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">Workspace export</div>
          <p className="mt-0.5 max-w-prose text-[13px] text-ink-3">
            A portable copy of this workspace — watches, imports and their rejected rows, investigations with their evidence and trace, and your decisions. It never contains credentials, sessions or email addresses. Demo night is not included.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" icon={Download} onClick={download}>
            Download export
          </Button>
          <Button size="sm" icon={Upload} onClick={() => file.current?.click()}>
            Import an export…
          </Button>
          <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </div>
      {server.available && <MoveToAccount server={server} exportDoc={exportWorkspace} />}
      {r && (
        <div className="mt-4 rounded-lg border border-line bg-subtle px-4 py-3 text-[13px]" role="status">
          {r.ok ? (
            <>
              <div className="font-medium text-ink">
                Dry run: “{r.workspaceName}” can be imported{r.fromVersion ? ` (export version ${r.fromVersion})` : ''}.
              </div>
              <div className="mt-1 text-ink-2">
                {r.counts.watches} watches · {r.counts.imports} imports ({r.counts.importedRecords} records, {r.counts.rejectedRows} rejected rows) · {r.counts.investigations} investigations · {r.counts.actions} actions · {r.counts.approvals} decisions · {r.counts.notifications} notifications
              </div>
              {r.warnings.map((w) => (
                <div key={w} className="mt-1 text-high">
                  {w}
                </div>
              ))}
              <div className="mt-2 text-ink-3">Importing replaces this browser’s workspace. Download an export first if you want to keep it.</div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    applyImport(plan!);
                    setPlan(null);
                    toast({ tone: 'success', title: 'Workspace imported', body: `${r.counts.investigations} investigations and ${r.counts.watches} watches restored.` });
                  }}
                >
                  Replace this workspace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="font-medium text-crit">This file cannot be imported. Nothing was changed.</div>
              <ul className="mt-1 space-y-0.5 text-ink-2">
                {r.problems.slice(0, 8).map((p) => (
                  <li key={p.path + p.message}>
                    <code className="font-mono text-[12px]">{p.path}</code> — {p.message}
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => setPlan(null)}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Backend (optional): when this deployment has the Jagr API, a signed-in user can copy the browser
// workspace into their account — same export, same dry run, same confirmation.
// ─────────────────────────────────────────────────────────────

interface ServerAccount {
  available: boolean;
  signIn: string[];
  user?: { displayName: string };
}

function useServerAccount(): ServerAccount {
  const [s, setS] = useState<ServerAccount>({ available: false, signIn: [] });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const h = await fetch('/api/health');
        if (!h.ok) return;
        const health = (await h.json()) as { ok?: boolean; signIn?: string[] };
        if (!health.ok) return;
        const me = await fetch('/api/me');
        const user = me.ok ? ((await me.json()) as { user: { displayName: string } }).user : undefined;
        if (live) setS({ available: true, signIn: health.signIn ?? [], user });
      } catch {
        /* no backend: browser-local only */
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return s;
}

const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('jagr_csrf='))?.slice('jagr_csrf='.length) ?? '';
const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jagr-csrf': decodeURIComponent(csrf()) }, body: JSON.stringify(body) });

function MoveToAccount({ server, exportDoc }: { server: ServerAccount; exportDoc: () => unknown }) {
  const [state, setState] = useState<{ report?: ImportPlan['report']; doc?: unknown; done?: string; error?: string }>({});
  const label: Record<string, string> = { google: 'Google', github: 'GitHub' };
  if (!server.user) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <span>Keep this workspace in an account (monitoring then runs without this tab open):</span>
        {server.signIn.map((p) => (
          <a key={p} className="font-medium text-accent hover:underline" href={`/api/auth/${p}/start?returnTo=/sources`}>
            Sign in with {label[p] ?? p}
          </a>
        ))}
        {!server.signIn.length && <span className="text-ink-3">No sign-in provider is configured on this server.</span>}
      </div>
    );
  }
  const plan = async () => {
    const doc = exportDoc();
    const r = await post('/api/import/plan', { doc });
    const body = (await r.json()) as { report?: ImportPlan['report']; error?: string };
    setState({ report: body.report, doc, error: body.report ? undefined : body.error });
  };
  const commit = async () => {
    const r = await post('/api/import/commit', { doc: state.doc, confirm: true });
    const body = (await r.json()) as { workspace?: { name: string }; error?: string };
    setState(r.ok ? { done: body.workspace?.name } : { ...state, error: body.error ?? 'The server refused the import.' });
  };
  return (
    <div className="mt-4 rounded-lg border border-line px-4 py-3 text-[13px]">
      <div className="text-ink-2">
        Signed in as <span className="font-medium text-ink">{server.user.displayName}</span>.{' '}
        {state.done ? (
          <span className="text-ok">Copied to your account as “{state.done}”. This browser’s copy is kept until you delete it.</span>
        ) : (
          <Button size="sm" onClick={() => void plan()}>
            Copy this workspace to my account…
          </Button>
        )}
      </div>
      {state.error && <div className="mt-2 text-crit">{state.error}</div>}
      {state.report && !state.done && (
        <div className="mt-2 text-ink-2">
          {state.report.ok ? (
            <>
              Dry run: {state.report.counts.watches} watches, {state.report.counts.investigations} investigations, {state.report.counts.approvals} decisions.{' '}
              {state.report.warnings.join(' ')}{' '}
              <Button size="sm" variant="primary" onClick={() => void commit()}>
                Confirm copy
              </Button>
            </>
          ) : (
            <span className="text-crit">{state.report.problems.map((p) => p.message).join(' ')}</span>
          )}
        </div>
      )}
    </div>
  );
}
