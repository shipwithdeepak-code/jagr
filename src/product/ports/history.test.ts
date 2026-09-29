import { describe, expect, it } from 'vitest';
import { HistorySizeError, readAllHistory } from './history';

describe('complete history traversal', () => {
  it('fails explicitly before returning a partial oversized document', async () => {
    const scope = { organizationId: 'org-a', workspaceId: 'ws-a' };
    const page = async (_scope: typeof scope, query: { cursor?: string }) => query.cursor
      ? { items: [{ id: 'second', data: '123456' }], nextCursor: null }
      : { items: [{ id: 'first', data: '123456' }], nextCursor: 'second-page' };
    const budget = { remainingChars: 50 };
    await expect(readAllHistory(scope, page, (item) => item.id, budget)).rejects.toBeInstanceOf(HistorySizeError);
  });
});
