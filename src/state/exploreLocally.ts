import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProduct, type WorkspaceMode } from './productContext';
import { useServerSession } from './serverSession';

/**
 * Explore locally — open this browser's workspace. An existing one is reopened as it is (imports and
 * all); a new one is created only when there is none, or when someone asks for their own data and the
 * browser holds only the sample. Always an explicit choice to stay in this browser.
 */
export interface ExplorePlan {
  /** Create this browser's workspace in this mode first; undefined = reopen the existing one. */
  create?: WorkspaceMode;
  /** Where to go afterwards; undefined = stay on the current route. */
  navigate?: string;
}

export function explorePlan(localMode: WorkspaceMode | undefined, want: 'sample' | 'imported'): ExplorePlan {
  if (want === 'imported') return { create: localMode === 'imported' ? undefined : 'imported', navigate: '/sources?upload=1' };
  return { create: localMode ? undefined : 'sample' };
}

export function useExploreLocally(): (want?: 'sample' | 'imported') => void {
  const { localMode, createLocalWorkspace } = useProduct();
  const { useBrowserWorkspace } = useServerSession();
  const navigate = useNavigate();
  return useCallback(
    (want: 'sample' | 'imported' = 'sample') => {
      const plan = explorePlan(localMode, want);
      useBrowserWorkspace();
      if (plan.create) createLocalWorkspace(plan.create);
      if (plan.navigate) navigate(plan.navigate);
    },
    [localMode, createLocalWorkspace, useBrowserWorkspace, navigate],
  );
}
