/**
 * Unique ids for records written at the same instant (audit entries, notification claims). Time alone
 * is not unique: several watches run at the same due time, and a manual clock repeats in tests.
 */
let seq = 0;
export function uniqueId(prefix: string, at: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${at}-${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
