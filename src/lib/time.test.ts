import { afterEach, expect, it, vi } from 'vitest';
import { fmtDateTime, fmtTime } from './localTime';
const DateTimeFormat = Intl.DateTimeFormat;
afterEach(() => vi.restoreAllMocks());
it.each(['Asia/Kolkata', 'Europe/Berlin'])('formats customer time in %s, including local date and daylight-saving offset', (timeZone) => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (_locale, options) { return new DateTimeFormat('en-GB', { ...options, timeZone }); });
  const at = '2026-10-05T20:00:00Z';
  expect(fmtTime(at)).toBe(new DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone }).format(new Date(at)));
  expect(fmtDateTime(at)).toContain(timeZone === 'Asia/Kolkata' ? '6 Oct 2026' : '5 Oct 2026');
  expect(fmtTime(at)).not.toContain('UTC');
});
it('renders missing or malformed historical time safely', () => {
  expect(fmtTime('invalid')).toBe('Time unavailable');
});
