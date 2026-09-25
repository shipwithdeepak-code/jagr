import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { WorkspaceProvider } from '@/state/store';
import { ToastProvider } from '@/components/toast';
import { AppShell } from '@/components/AppShell';
import { EmptyState } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProductProvider } from '@/state/product';
import { ServerSessionProvider } from '@/state/serverSession';
import { ProductOverviewPage } from '@/pages/ProductOverview';

// Secondary screens load on demand to keep the first paint small.
const InvestigationsPage = lazy(() => import('@/pages/Investigations').then((m) => ({ default: m.InvestigationsPage })));
const InvestigationDetailPage = lazy(() => import('@/pages/Investigations').then((m) => ({ default: m.InvestigationDetailPage })));
const TasksPage = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.TasksPage })));
const SignalsPage = lazy(() => import('@/pages/Signals').then((m) => ({ default: m.SignalsPage })));
const TracePage = lazy(() => import('@/pages/Trace').then((m) => ({ default: m.TracePage })));
const ApprovalsPage = lazy(() => import('@/pages/Approvals').then((m) => ({ default: m.ApprovalsPage })));
const EvaluationsPage = lazy(() => import('@/pages/Evaluations').then((m) => ({ default: m.EvaluationsPage })));
const IntegrationsPage = lazy(() => import('@/pages/Integrations').then((m) => ({ default: m.IntegrationsPage })));
const SettingsPage = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })));
const DemoNightPage = lazy(() => import('@/pages/Overview').then((m) => ({ default: m.OverviewPage })));
const WatchesPage = lazy(() => import('@/pages/Watches').then((m) => ({ default: m.WatchesPage })));
const SourcesPage = lazy(() => import('@/pages/Sources').then((m) => ({ default: m.SourcesPage })));
const SourceRecordPage = lazy(() => import('@/pages/Sources').then((m) => ({ default: m.SourceRecordPage })));
const BriefsPage = lazy(() => import('@/pages/Briefs').then((m) => ({ default: m.BriefsPage })));
const WatchInvestigationPage = lazy(() => import('@/pages/WatchInvestigation').then((m) => ({ default: m.WatchInvestigationPage })));
const AboutPage = lazy(() => import('@/pages/About').then((m) => ({ default: m.AboutPage })));

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/investigations': 'Investigations',
  '/watches': 'Watches',
  '/sources': 'Sources',
  '/briefs': 'Briefs',
  '/demo': 'Demo night',
  '/tasks': 'Tasks',
  '/signals': 'Signals',
  '/trace': 'Agent Trace',
  '/approvals': 'Approvals',
  '/evaluations': 'Evaluations',
  '/integrations': 'Integrations',
  '/settings': 'Settings',
  '/about': 'About this build',
};

function ScrollAndTitle() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
    const key = '/' + (pathname.split('/')[1] ?? '');
    document.title = `${TITLES[key] ?? 'Investigation'} · JAGR`;
  }, [pathname, hash]);
  return null;
}

function Screens() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={<div className="py-20 text-center text-[13px] text-ink-3">Loading…</div>}>
        <Routes>
              <Route path="/" element={<ProductOverviewPage />} />
              <Route path="/demo" element={<DemoNightPage />} />
              <Route path="/watches" element={<WatchesPage />} />
              <Route path="/sources" element={<SourcesPage />} />
              <Route path="/sources/:provider/:kind/:id" element={<SourceRecordPage />} />
              <Route path="/briefs" element={<BriefsPage />} />
              <Route path="/investigations" element={<InvestigationsPage />} />
              <Route path="/investigations/w/:id" element={<WatchInvestigationPage />} />
              <Route path="/investigations/:id" element={<InvestigationDetailPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/signals" element={<SignalsPage />} />
              <Route path="/trace" element={<TracePage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/evaluations" element={<EvaluationsPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route
                path="*"
                element={
                  <EmptyState icon={Compass} title="Page not found" action={<Link to="/" className="text-[13px] font-medium text-accent">Go to Overview</Link>}>
                    This page doesn’t exist.
                  </EmptyState>
                }
              />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <WorkspaceProvider>
          <ServerSessionProvider>
            <ProductProvider>
              <ScrollAndTitle />
              <AppShell>
                <Screens />
              </AppShell>
            </ProductProvider>
          </ServerSessionProvider>
        </WorkspaceProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
