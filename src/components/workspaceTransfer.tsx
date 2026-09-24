import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
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

  const download = () => {
    try {
      const doc = exportWorkspace();
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
          <p className="mt-0.5 max-w-prose text-[12.5px] text-ink-3">
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
      {r && (
        <div className="mt-4 rounded-lg border border-line bg-subtle px-4 py-3 text-[12.5px]" role="status">
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
                    <code className="font-mono text-[11.5px]">{p.path}</code> — {p.message}
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
