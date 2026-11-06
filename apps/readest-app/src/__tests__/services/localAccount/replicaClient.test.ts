import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hlc, ReplicaRow } from '@/types/replica';

const state = vi.hoisted(() => ({
  provider: null as unknown,
  config: null as unknown,
}));

vi.mock('@/services/localAccount/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/localAccount/provider')>();
  return {
    ...actual,
    getLocalAccountProvider: async () => state.provider,
  };
});

vi.mock('@/services/localAccount/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/localAccount/config')>();
  return {
    ...actual,
    getLocalAccountConfig: () => state.config,
  };
});

import {
  __resetWebDAVReplicaClientForTests,
  webdavReplicaClient,
} from '@/services/localAccount/replicaClient';
import { replicaBundlePath, replicaKeysPath } from '@/services/localAccount/provider';
import { FakeProvider, LOCAL_CONFIG } from './fakeProvider';

const hlc = (ms: number, counter = 0, device = 'dev-a') =>
  `${ms.toString(16).padStart(13, '0')}-${counter.toString(16).padStart(8, '0')}-${device}` as Hlc;

const row = (overrides: Partial<ReplicaRow> = {}): ReplicaRow => ({
  user_id: 'local-user',
  kind: 'bookshelf',
  replica_id: 'shelf-1',
  fields_jsonb: { name: { v: 'Favourites', t: hlc(1000), s: 'dev-a' } },
  manifest_jsonb: null,
  deleted_at_ts: null,
  reincarnation: null,
  updated_at_ts: hlc(1000),
  schema_version: 1,
  ...overrides,
});

let provider: FakeProvider;

beforeEach(() => {
  provider = new FakeProvider();
  state.provider = provider;
  state.config = LOCAL_CONFIG;
  __resetWebDAVReplicaClientForTests();
});

describe('WebDAVReplicaClient', () => {
  test('push writes one bundle per kind under the account subtree', async () => {
    await webdavReplicaClient.push([row()]);
    const bundle = provider.json<{ rows: Record<string, ReplicaRow> }>(
      replicaBundlePath(LOCAL_CONFIG, 'bookshelf'),
    );
    expect(bundle?.rows['shelf-1']?.fields_jsonb['name']?.v).toBe('Favourites');
  });

  test('pull returns rows, and honours the HLC cursor', async () => {
    await webdavReplicaClient.push([row()]);
    expect(await webdavReplicaClient.pull('bookshelf', null)).toHaveLength(1);
    expect(await webdavReplicaClient.pull('bookshelf', hlc(1000))).toHaveLength(0);
    expect(await webdavReplicaClient.pull('bookshelf', hlc(999))).toHaveLength(1);
  });

  test('a newer push from a peer merges field by field', async () => {
    await webdavReplicaClient.push([row()]);
    await webdavReplicaClient.push([
      row({
        fields_jsonb: {
          name: { v: 'Reading', t: hlc(2000, 0, 'dev-b'), s: 'dev-b' },
          color: { v: 'red', t: hlc(2000, 1, 'dev-b'), s: 'dev-b' },
        },
        updated_at_ts: hlc(2000, 1, 'dev-b'),
      }),
    ]);
    const [stored] = await webdavReplicaClient.pull('bookshelf', null);
    expect(stored!.fields_jsonb['name']?.v).toBe('Reading');
    expect(stored!.fields_jsonb['color']?.v).toBe('red');
    expect(stored!.updated_at_ts).toBe(hlc(2000, 1, 'dev-b'));
  });

  test('an older push does not roll back a newer field', async () => {
    await webdavReplicaClient.push([
      row({
        fields_jsonb: { name: { v: 'New', t: hlc(5000), s: 'dev-b' } },
        updated_at_ts: hlc(5000),
      }),
    ]);
    await webdavReplicaClient.push([row()]);
    const [stored] = await webdavReplicaClient.pull('bookshelf', null);
    expect(stored!.fields_jsonb['name']?.v).toBe('New');
  });

  test('pullBatch answers every requested kind', async () => {
    await webdavReplicaClient.push([row(), row({ kind: 'settings', replica_id: 'me' })]);
    const results = await webdavReplicaClient.pullBatch([
      { kind: 'bookshelf', since: null },
      { kind: 'settings', since: null },
      { kind: 'dictionary', since: null },
    ]);
    expect(results.map((r) => [r.kind, r.rows.length])).toEqual([
      ['bookshelf', 1],
      ['settings', 1],
      ['dictionary', 0],
    ]);
  });

  test('replica keys round trip through the salt file', async () => {
    expect(await webdavReplicaClient.listReplicaKeys()).toEqual([]);
    const created = await webdavReplicaClient.createReplicaKey('pbkdf2-600k-sha256');
    expect(created.salt).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(await webdavReplicaClient.listReplicaKeys()).toHaveLength(1);
    expect(provider.json(replicaKeysPath(LOCAL_CONFIG))).toBeTruthy();

    await webdavReplicaClient.forgetReplicaKeys();
    expect(await webdavReplicaClient.listReplicaKeys()).toEqual([]);
  });

  test('throws instead of silently succeeding without a connection', async () => {
    state.provider = null;
    await expect(webdavReplicaClient.push([row()])).rejects.toThrow();
  });
});
