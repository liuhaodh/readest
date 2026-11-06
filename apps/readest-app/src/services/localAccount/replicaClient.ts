/**
 * Local (WebDAV) account — CRDT replica transport.
 *
 * The hosted backend stores one row per `(user, kind, replica_id)` in Postgres
 * and merges pushes with `crdt_merge_replica`. This class provides the same
 * contract on top of a WebDAV file: one JSON bundle per replica kind, holding a
 * `replicaId → ReplicaRow` map, merged with the same client-side CRDT rules
 * (`mergeReplica`) the server applies.
 *
 * Read-modify-write per kind is serialised through an in-process queue so two
 * concurrent flushes cannot interleave a GET/PUT pair and drop one another's
 * rows. Cross-device writes are reconciled by the merge, not by locking: the
 * later writer merges into whatever it read, and every field keeps its own HLC
 * so nothing is lost even when two devices push at once (the loser's rows are
 * re-sent on its next flush because the cursor never advanced past them).
 */
import { mergeReplica } from '@/libs/crdt';
import type { Hlc, ReplicaRow } from '@/types/replica';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
import { getLocalAccountConfig } from './config';
import {
  getLocalAccountProvider,
  readJson,
  replicaBundlePath,
  replicaKeysPath,
  writeJson,
} from './provider';

interface ReplicaBundle {
  version: 1;
  /** Rows keyed by `replica_id`; the kind is implied by the file name. */
  rows: Record<string, ReplicaRow>;
}

interface ReplicaKeysFile {
  version: 1;
  rows: ReplicaKeyRow[];
}

const emptyBundle = (): ReplicaBundle => ({ version: 1, rows: {} });

const emptyKeysFile = (): ReplicaKeysFile => ({ version: 1, rows: [] });

/** Per-kind serialisation of read-modify-write cycles inside this client. */
const kindQueues = new Map<string, Promise<unknown>>();

const withKindLock = async <T>(kind: string, task: () => Promise<T>): Promise<T> => {
  const previous = kindQueues.get(kind) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Keep the chain alive but never let a rejection poison the next waiter.
  kindQueues.set(
    kind,
    next.catch(() => undefined),
  );
  return next;
};

const randomHex = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

export class WebDAVReplicaClient {
  private replicaKeysCache: ReplicaKeyRow[] | null = null;

  private requireConfig() {
    const config = getLocalAccountConfig();
    if (!config) throw new Error('WebDAV account is not configured');
    return config;
  }

  async push(rows: ReplicaRow[]): Promise<ReplicaRow[]> {
    if (rows.length === 0) return [];
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');

    const byKind = new Map<string, ReplicaRow[]>();
    for (const row of rows) {
      const list = byKind.get(row.kind);
      if (list) list.push(row);
      else byKind.set(row.kind, [row]);
    }

    const merged: ReplicaRow[] = [];
    for (const [kind, kindRows] of byKind) {
      const result = await withKindLock(kind, async () => {
        const path = replicaBundlePath(this.requireConfig(), kind);
        const bundle = (await readJson<ReplicaBundle>(provider, path)) ?? emptyBundle();
        const out: ReplicaRow[] = [];
        for (const row of kindRows) {
          const existing = bundle.rows[row.replica_id];
          // The bundle is shared by every device on this account, so a row
          // written by another device must be merged rather than replaced.
          const next = existing ? mergeReplica(existing, row) : row;
          bundle.rows[row.replica_id] = next;
          out.push(next);
        }
        await writeJson(provider, path, bundle);
        return out;
      });
      merged.push(...result);
    }
    return merged;
  }

  async pull(kind: string, since: Hlc | null): Promise<ReplicaRow[]> {
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const path = replicaBundlePath(this.requireConfig(), kind);
    const bundle = await readJson<ReplicaBundle>(provider, path);
    if (!bundle) return [];
    const rows = Object.values(bundle.rows);
    // HLC strings are fixed-width and compare lexicographically in temporal
    // order, so `>` is the same filter the hosted `?since=` applies.
    return since ? rows.filter((row) => row.updated_at_ts > since) : rows;
  }

  async pullBatch(
    cursors: { kind: string; since: Hlc | null }[],
  ): Promise<{ kind: string; rows: ReplicaRow[] }[]> {
    if (cursors.length === 0) return [];
    const results: { kind: string; rows: ReplicaRow[] }[] = [];
    for (const cursor of cursors) {
      results.push({ kind: cursor.kind, rows: await this.pull(cursor.kind, cursor.since) });
    }
    return results;
  }

  invalidateReplicaKeysCache(): void {
    this.replicaKeysCache = null;
  }

  async listReplicaKeys(): Promise<ReplicaKeyRow[]> {
    if (this.replicaKeysCache) return [...this.replicaKeysCache];
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const config = getLocalAccountConfig();
    if (!config) throw new Error('WebDAV account is not configured');
    const file =
      (await readJson<ReplicaKeysFile>(provider, replicaKeysPath(config))) ?? emptyKeysFile();
    this.replicaKeysCache = file.rows;
    return [...file.rows];
  }

  /**
   * Create a new passphrase salt. Salts are never rotated in place: old ones
   * stay listed so envelopes written under them remain decryptable, and the
   * newest row is what `CryptoSession` derives against.
   */
  async createReplicaKey(alg: string): Promise<ReplicaKeyRow> {
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const config = getLocalAccountConfig();
    if (!config) throw new Error('WebDAV account is not configured');
    const path = replicaKeysPath(config);
    const row = await withKindLock('__replica_keys', async () => {
      const file = (await readJson<ReplicaKeysFile>(provider, path)) ?? emptyKeysFile();
      const saltBytes = new Uint8Array(16);
      crypto.getRandomValues(saltBytes);
      const created: ReplicaKeyRow = {
        saltId: randomHex(16),
        alg,
        salt: toBase64(saltBytes),
        createdAt: new Date().toISOString(),
      };
      file.rows = [created, ...file.rows];
      await writeJson(provider, path, file);
      return created;
    });
    this.replicaKeysCache = [row, ...(this.replicaKeysCache ?? [])];
    return row;
  }

  async forgetReplicaKeys(): Promise<void> {
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const config = getLocalAccountConfig();
    if (!config) throw new Error('WebDAV account is not configured');
    await writeJson(provider, replicaKeysPath(config), emptyKeysFile());
    this.replicaKeysCache = [];
  }
}

export const webdavReplicaClient = new WebDAVReplicaClient();

/** Test seam — drop per-kind queues and the salt cache. */
export const __resetWebDAVReplicaClientForTests = (): void => {
  kindQueues.clear();
  webdavReplicaClient.invalidateReplicaKeysCache();
};
