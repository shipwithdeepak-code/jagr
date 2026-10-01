/** A page of immutable-key history. Cursors belong to one organization, workspace and collection. */
export interface HistoryScope { organizationId: string; workspaceId: string }
export interface HistoryPage<T> { items: T[]; nextCursor: string | null }
export interface HistoryQuery { limit?: number; cursor?: string }
export const HISTORY_PAGE_LIMIT = 100;
/** A technical bound for JSON documents assembled in one API response; not a retention policy. */
export const FULL_DOCUMENT_CHAR_LIMIT = 8_000_000;
export class HistorySizeError extends Error { constructor() { super('This workspace history is too large for a single response. Nothing partial was returned.'); } }
export interface HistoryReadBudget { remainingChars: number }

interface Position extends HistoryScope { v: 1; collection: string; key: string; id: string }
export class HistoryCursorError extends Error { constructor() { super('Invalid history cursor.'); } }

export function pageSize(requested?: number): number {
  return Number.isInteger(requested) && requested! > 0 ? Math.min(requested!, HISTORY_PAGE_LIMIT) : HISTORY_PAGE_LIMIT;
}

export function encodeHistoryCursor(scope: HistoryScope, collection: string, key: string, id: string): string {
  return encodeURIComponent(JSON.stringify({ v: 1, ...scope, collection, key, id } satisfies Position));
}

export function decodeHistoryCursor(cursor: string | undefined, scope: HistoryScope, collection: string): Pick<Position, 'key' | 'id'> | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(cursor));
    if (!value || typeof value !== 'object') throw new Error();
    const p = value as Partial<Position>;
    if (p.v !== 1 || p.organizationId !== scope.organizationId || p.workspaceId !== scope.workspaceId || p.collection !== collection || typeof p.key !== 'string' || typeof p.id !== 'string' || !p.key || !p.id) throw new Error();
    return { key: p.key, id: p.id };
  } catch {
    throw new HistoryCursorError();
  }
}

export function historyPage<T>(items: T[], scope: HistoryScope, collection: string, keyOf: (item: T) => string, idOf: (item: T) => string, requested?: number): HistoryPage<T> {
  const limit = pageSize(requested);
  const page = items.slice(0, limit);
  return { items: page, nextCursor: items.length > limit ? encodeHistoryCursor(scope, collection, keyOf(page[page.length - 1]!), idOf(page[page.length - 1]!)) : null };
}

/** Traverses every keyset page; a shared budget fails closed before assembling an oversized response. */
export async function readAllHistory<T>(scope: HistoryScope, page: (scope: HistoryScope, query: HistoryQuery) => Promise<HistoryPage<T>>, idOf: (item: T) => string, budget?: HistoryReadBudget): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const batch = await page(scope, { limit: HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    for (const item of batch.items) {
      const id = idOf(item);
      if (seen.has(id)) throw new Error('History page repeated a record.');
      seen.add(id);
      if (budget) {
        budget.remainingChars -= JSON.stringify(item).length;
        if (budget.remainingChars < 0) throw new HistorySizeError();
      }
      out.push(item);
    }
    if (batch.nextCursor && (!batch.items.length || batch.nextCursor === cursor)) throw new Error('History cursor did not advance.');
    cursor = batch.nextCursor;
  } while (cursor);
  return out;
}
