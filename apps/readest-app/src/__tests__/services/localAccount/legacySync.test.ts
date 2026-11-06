import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ provider: null as unknown }));

vi.mock('@/services/localAccount/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/localAccount/provider')>();
  return {
    ...actual,
    getLocalAccountProvider: async () => state.provider,
  };
});

import {
  __resetWebDAVLegacySyncForTests,
  webdavLegacySyncClient,
} from '@/services/localAccount/legacySync';
import { __resetLocalAccountForTests, setLocalAccountWebDAV } from '@/services/localAccount/config';
import { legacySyncPath } from '@/services/localAccount/provider';
import { FakeProvider, LOCAL_CONFIG } from './fakeProvider';

let provider: FakeProvider;

beforeEach(() => {
  provider = new FakeProvider();
  state.provider = provider;
  __resetLocalAccountForTests();
  localStorage.clear();
  setLocalAccountWebDAV({ ...LOCAL_CONFIG, enabled: true });
  __resetWebDAVLegacySyncForTests();
});

describe('WebDAVLegacySyncClient', () => {
  test('pushes page events and book rows, stamped with a server clock', async () => {
    const before = Date.now();
    const result = await webdavLegacySyncClient.pushChanges({
      statBooks: [{ book_hash: 'hash-1', title: 'Book', authors: 'A' }],
      statPages: [{ book_hash: 'hash-1', page: 3, start_time: 111, duration: 5, total_pages: 10 }],
    });

    expect(result.statBooks).toHaveLength(1);
    expect(result.statPages).toHaveLength(1);
    const stored = provider.json<{ rows: Record<string, { updated_at: string }> }>(
      legacySyncPath(LOCAL_CONFIG, 'statPages'),
    );
    const row = Object.values(stored!.rows)[0]!;
    expect(new Date(row.updated_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  test('pull returns rows past the cursor and nothing at or before it', async () => {
    await webdavLegacySyncClient.pushChanges({
      statPages: [{ book_hash: 'hash-1', page: 1, start_time: 1, duration: 1, total_pages: 2 }],
    });
    const pulled = await webdavLegacySyncClient.pullChanges(0, 'stats');
    expect(pulled.statPages).toHaveLength(1);
    expect(pulled.statPages![0]!.updated_at_ms).toBeGreaterThan(0);

    const cursor = pulled.statPages![0]!.updated_at_ms!;
    expect((await webdavLegacySyncClient.pullChanges(cursor, 'stats')).statPages).toEqual([]);
  });

  test('pull narrows to one book and caps the page-event page', async () => {
    await webdavLegacySyncClient.pushChanges({
      statPages: [
        { book_hash: 'hash-1', page: 1, start_time: 1, duration: 1, total_pages: 2 },
        { book_hash: 'hash-1', page: 2, start_time: 2, duration: 1, total_pages: 2 },
        { book_hash: 'hash-2', page: 1, start_time: 3, duration: 1, total_pages: 2 },
      ],
    });
    expect((await webdavLegacySyncClient.pullChanges(0, 'stats', 'hash-1')).statPages).toHaveLength(
      2,
    );
    expect(
      (await webdavLegacySyncClient.pullChanges(0, 'stats', undefined, undefined, 2)).statPages,
    ).toHaveLength(2);
  });

  test('a repeated page event overwrites instead of duplicating', async () => {
    const page = { book_hash: 'hash-1', page: 1, start_time: 1, duration: 1, total_pages: 2 };
    await webdavLegacySyncClient.pushChanges({ statPages: [page] });
    await webdavLegacySyncClient.pushChanges({ statPages: [{ ...page, duration: 9 }] });
    const pulled = await webdavLegacySyncClient.pullChanges(0, 'stats');
    expect(pulled.statPages).toHaveLength(1);
    expect(pulled.statPages![0]!['duration']).toBe(9);
  });

  test('books/configs/notes belong to the file-sync engine, so they stay empty', async () => {
    const pushed = await webdavLegacySyncClient.pushChanges({
      books: [{ hash: 'hash-1', title: 'Book' }],
    });
    expect(pushed.books).toEqual([]);
    const pulled = await webdavLegacySyncClient.pullChanges(0, 'books');
    expect(pulled.books).toEqual([]);
    expect(provider.texts.size).toBe(0);
  });
});
