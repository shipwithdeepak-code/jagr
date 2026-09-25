import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'info' | 'warning';
interface ToastItem {
  id: number;
  title: string;
  body?: string;
  tone: ToastTone;
}

const Ctx = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : t.tone === 'warning' ? TriangleAlert : Info;
          return (
            <div key={t.id} className="animate-fade-up pointer-events-auto flex gap-2.5 rounded-lg border border-line bg-surface p-3 shadow-pop">
              <Icon size={16} className={t.tone === 'success' ? 'mt-0.5 text-ok' : t.tone === 'warning' ? 'mt-0.5 text-high' : 'mt-0.5 text-info'} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-ink">{t.title}</div>
                {t.body && <div className="mt-0.5 text-[13px] text-ink-2">{t.body}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
