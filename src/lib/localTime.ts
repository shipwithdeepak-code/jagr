/** Arithmetic stays in the portable core; customer-facing formatting uses the browser's timezone. */
export * from '@/product/lib/time';

function format(iso: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

export function fmtTime(iso: string, withSeconds = false): string {
  return format(iso, { hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), timeZoneName: 'short' });
}
export function fmtDate(iso: string): string {
  return format(iso, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtDateTime(iso: string): string { return `${fmtDate(iso)}, ${fmtTime(iso)}`; }
export function fmt12h(iso: string): string { return format(iso, { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }); }
export function labelledTime(label: string, iso: string): string { return `${label} ${fmtDateTime(iso)}`; }
