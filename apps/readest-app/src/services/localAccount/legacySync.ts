/**
 * Local (WebDAV) account — legacy row sync (reading statistics).
 *
 * The hosted `/api/sync` endpoint keeps several row types; only ONE of them is
 * still unreachable without it in local mode:
 *
 * - `books` / `configs` / `notes` are switched OFF whenever Readest Cloud is not
 *   the selected provider (`syncCategories.ts` → `PROVIDER_GATED_CATEGORIES`),
 *   and the WebDAV file-sync engine owns them through `library.json` +
 *   `config.json` instead. Re-implementing the hosted row merge here would
 *   duplicate that channel with a weaker merge, so these pulls answer "no
 *   remote rows" and pushes are dropped.
 * - `stats` (reading time / pages) is account-level with no file-based
 *   counterpart, so it needs a real implementation. That is what this module
 *   provides: one JSON document per table under
 *   `<rootPath>/Readest/account/sync/`, last-writer-wins per row.
 *
 * Every pushed row is stamped `updated_at = now()`, mirroring the hosted
 * upsert. Statistics pulls depend on it: the client advances its cursor with
 * `updated_at_ms`, so an unstamped row would stall the cursor forever.
 */
import type { SyncData, SyncResult, SyncType } from '@/libs/sync';
import { getLocalAccountConfig, type LocalAccountConfig } from './config';
import { getLocalAccountProvider, legacySyncPath, readJson, writeJson } from './provider';

interface StatRow {
  book_hash?: string;
  page?: number;
  start_time?: number;
  updated_at?: string;
  updated_at_ms?: number;
  deleted_at?: string | null;
  [key: string]: unknown;
}

interface RowFile {
  version: 1;
  rows: Record<string, StatRow>;
}

/** The two statistics tables, each with its own primary-key rule. */
const STAT_KINDS = {
  statBooks: {
    file: 'statBooks',
    keyOf: (row: StatRow) => String(row.book_hash ?? ''),
  },
  statPages: {
    file: 'statPages',
    // A page event is identified by book + page + start time, the same triple
    // the hosted upsert keys on.
    keyOf: (row: StatRow) => `${row.book_hash ?? ''}|${row.page ?? ''}|${row.start_time ?? ''}`,
  },
} as const;

type StatKind = keyof typeof STAT_KINDS;

const timeOf = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

/** Serialise read-modify-write per file so concurrent pushes cannot interleave. */
const fileQueues = new Map<string, Promise<unknown>>();

const withFileLock = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  fileQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
};

const emptyFile = (): RowFile => ({ version: 1, rows: {} });

const requireConfig = (): LocalAccountConfig => {
  const config = getLocalAccountConfig();
  if (!config) throw new Error('WebDAV account is not configured');
  return config;
};

const readRowFile = async (config: LocalAccountConfig, kind: StatKind): Promise<RowFile> => {
  const provider = await getLocalAccountProvider();
  if (!provider) throw new Error('WebDAV account is not configured');
  return (
    (await readJson<RowFile>(provider, legacySyncPath(config, STAT_KINDS[kind].file))) ??
    emptyFile()
  );
};

export class WebDAVLegacySyncClient {
  /**
   * Push local rows. Statistics pushes are server-stamped and last-writer-wins
   * per row; the books/configs/notes buckets are owned by the file-sync engine
   * in local mode, so they are accepted and dropped.
   */
  async pushChanges(payload: SyncData): Promise<SyncResult> {
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const config = requireConfig();
    const result: SyncResult = {
      books: [],
      configs: [],
      notes: [],
      statBooks: [],
      statPages: [],
    };

    for (const kind of Object.keys(STAT_KINDS) as StatKind[]) {
      const incoming = (payload[kind] ?? []) as unknown as StatRow[];
      if (incoming.length === 0) continue;
      const authoritative = await withFileLock(STAT_KINDS[kind].file, async () => {
        const file = await readRowFile(config, kind);
        const nowIso = new Date().toISOString();
        const out: StatRow[] = [];
        for (const row of incoming) {
          const key = STAT_KINDS[kind].keyOf(row);
          if (!key) continue;
          // Server clock, not the client's: the pull cursor is derived from it.
          const stamped: StatRow = { ...row, updated_at: nowIso, updated_at_ms: timeOf(nowIso) };
          file.rows[key] = stamped;
          out.push(stamped);
        }
        await writeJson(provider, legacySyncPath(config, STAT_KINDS[kind].file), file);
        return out;
      });
      (result[kind] as unknown as StatRow[]) = authoritative;
    }

    return result;
  }

  /**
   * Pull rows newer than `since` (epoch ms). `type` narrows the buckets; `book`
   * narrows to one book hash; `limit` bounds the page-event page, matching the
   * hosted paged pull.
   */
  async pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    _metaHash?: string,
    limit?: number,
  ): Promise<SyncResult> {
    const provider = await getLocalAccountProvider();
    if (!provider) throw new Error('WebDAV account is not configured');
    const config = requireConfig();
    const result: SyncResult = {
      books: [],
      configs: [],
      notes: [],
      statBooks: [],
      statPages: [],
    };

    const kinds: StatKind[] =
      type === undefined || type === 'stats' ? (Object.keys(STAT_KINDS) as StatKind[]) : [];

    for (const kind of kinds) {
      const file = await readRowFile(config, kind);
      let rows = Object.values(file.rows).filter((row) => timeOf(row.updated_at) > since);
      if (book) rows = rows.filter((row) => row.book_hash === book);
      // Ascending by stamp so a capped page still advances the caller's cursor
      // monotonically.
      rows.sort((a, b) => timeOf(a.updated_at) - timeOf(b.updated_at));
      if (limit && limit > 0 && kind === 'statPages' && rows.length > limit) {
        rows = rows.slice(0, limit);
      }
      const stamped = rows.map((row) => ({ ...row, updated_at_ms: timeOf(row.updated_at) }));
      (result[kind] as unknown as StatRow[]) = stamped;
    }

    return result;
  }
}

export const webdavLegacySyncClient = new WebDAVLegacySyncClient();

/** Test seam — drop the per-file write queues. */
export const __resetWebDAVLegacySyncForTests = (): void => {
  fileQueues.clear();
};
