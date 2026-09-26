import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerSession } from '@/state/serverSession';
import { useToast } from './toast';

/**
 * The one sign-out. Every Sign out control uses it, wherever it is (account menu, Settings, workspace
 * gate), so the result is always the same:
 *   the server confirms → the remembered workspace is forgotten, "exit" is recorded, and the person
 *                         lands on the public landing at exactly `/` (no hash, no query; the current
 *                         history entry is replaced). A refresh stays there; nothing reopens.
 *   it does not         → nothing changes: still signed in, a clear message, no navigation.
 */
export interface SignOutDeps {
  /** Ends the session on the server; throws when it was not confirmed. */
  signOut(): Promise<void>;
  navigate(to: '/', options: { replace: true }): void;
  failed(message: string): void;
}

export async function signOutFlow(deps: SignOutDeps): Promise<boolean> {
  try {
    await deps.signOut();
  } catch (e) {
    deps.failed((e as Error).message || 'The server did not respond.');
    return false;
  }
  deps.navigate('/', { replace: true });
  return true;
}

export function useSignOut(): () => Promise<boolean> {
  const { signOut } = useServerSession();
  const navigate = useNavigate();
  const toast = useToast();
  return useCallback(
    () =>
      signOutFlow({
        signOut,
        navigate: (to, options) => void navigate(to, options),
        failed: (message) => toast({ tone: 'warning', title: 'You are still signed in', body: `Jagr could not sign you out: ${message} Try again.` }),
      }),
    [signOut, navigate, toast],
  );
}
