import { createContext, useContext } from 'react';

export const ShellContext = createContext<{ startRun: () => void; requestDemo: () => void; running: boolean }>({ startRun: () => {}, requestDemo: () => {}, running: false });

/** Lets any page trigger Run Overnight / Demo Mode with the same flow as the header. */
export function useShellActions() {
  return useContext(ShellContext);
}
