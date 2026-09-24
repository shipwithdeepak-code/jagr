export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path d="M19.5 7.5a9 9 0 1 0 5 15.9A10 10 0 0 1 19.5 7.5Z" fill="var(--canvas)" />
      <circle cx="21.5" cy="12" r="1.6" fill="var(--accent)" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      <span className="text-[14px] font-semibold tracking-tight text-ink">JAGR</span>
    </div>
  );
}
