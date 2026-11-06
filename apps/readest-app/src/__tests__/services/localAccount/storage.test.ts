import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ provider: null as unknown }));

vi.mock('@/services/localAccount/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/localAccount/provider')>();
  return {
    ...actual,
    getLocalAccountProvider: async () => state.provider,
  };
});

import { __resetLocalAccountForTests, setLocalAccountWebDAV } from '@/services/localAccount/config';
import {
  downloadLocalFile,
  getLocalStorageStats,
  listLocalFiles,
  purgeLocalFiles,
  uploadLocalFile,
} from '@/services/localAccount/storage';
import { FakeProvider, LOCAL_CONFIG } from './fakeProvider';
import type { AppService } from '@/types/system';

let provider: FakeProvider;

const fakeAppService = () => {
  const written = new Map<string, ArrayBuffer>();
  return {
    written,
    appService: {
      writeFile: async (path: string, _base: string, body: ArrayBuffer) => {
        written.set(path, body);
      },
    } as unknown as AppService,
  };
};

beforeEach(() => {
  provider = new FakeProvider();
  state.provider = provider;
  __resetLocalAccountForTests();
  localStorage.clear();
  setLocalAccountWebDAV({ ...LOCAL_CONFIG, enabled: true });
});

describe('local account storage', () => {
  test('uploads land under the account files prefix, keyed by the cloud path', async () => {
    const file = new File(['hello'], 'Readest/Books/hash-1/book.epub');
    await uploadLocalFile(file, '', file.name);

    const keys = [...provider.binaries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^\/books\/Readest\/account\/files\/local-[0-9a-f-]+\/Readest\/Books\/hash-1\/book\.epub$/,
    );
  });

  test('downloads write the object to the requested destination', async () => {
    const file = new File(['hello'], 'Readest/Books/hash-1/book.epub');
    await uploadLocalFile(file, '', file.name);
    const { appService, written } = fakeAppService();

    await downloadLocalFile({ appService, dst: '/tmp/book.epub', cfp: file.name });

    expect(written.get('/tmp/book.epub')?.byteLength).toBe(5);
  });

  test('a missing object surfaces as an error instead of an empty file', async () => {
    const { appService } = fakeAppService();
    await expect(
      downloadLocalFile({ appService, dst: '/tmp/x', cfp: 'Readest/Books/none/book.epub' }),
    ).rejects.toThrow(/not found/i);
  });

  test('listings recover the book hash and the file key the app expects', async () => {
    await uploadLocalFile(new File(['a'], 'x'), '', 'Readest/Books/hash-1/book.epub');
    await uploadLocalFile(new File(['bb'], 'x'), '', 'Readest/Books/hash-1/tts/pack.mp3');
    await uploadLocalFile(new File(['ccc'], 'x'), '', 'Readest/Replicas/dictionary/dict-1/d.rdict');

    const listed = await listLocalFiles({});
    expect(listed.total).toBe(3);
    const book = listed.files.find((f) => f.file_key.endsWith('book.epub'))!;
    expect(book.book_hash).toBe('hash-1');
    expect(book.file_key).toMatch(/^local-[0-9a-f-]+\/Readest\/Books\/hash-1\/book\.epub$/);

    const replica = listed.files.find((f) => f.replica_kind)!;
    expect(replica.replica_kind).toBe('dictionary');
    expect(replica.replica_id).toBe('dict-1');

    const filtered = await listLocalFiles({ bookHash: 'hash-1' });
    expect(filtered.total).toBe(2);
  });

  test('stats total the stored objects and group them by book', async () => {
    await uploadLocalFile(new File(['a'], 'x'), '', 'Readest/Books/hash-1/book.epub');
    await uploadLocalFile(new File(['bb'], 'x'), '', 'Readest/Books/hash-1/tts/pack.mp3');

    const stats = await getLocalStorageStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalSize).toBe(3);
    expect(stats.byBookHash).toEqual([{ bookHash: 'hash-1', fileCount: 2, totalSize: 3 }]);
  });

  test('purge deletes by file key and reports what it removed', async () => {
    await uploadLocalFile(new File(['a'], 'x'), '', 'Readest/Books/hash-1/book.epub');
    const [record] = (await listLocalFiles({})).files;

    const result = await purgeLocalFiles([record!.file_key], true);
    expect(result.deletedCount).toBe(1);
    expect(provider.binaries.size).toBe(0);
  });
});
