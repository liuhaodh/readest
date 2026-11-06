/**
 * Local (WebDAV) account — object storage.
 *
 * The hosted backend stores book/replica binaries in an S3 bucket behind signed
 * URLs (`/api/storage/*`). With WebDAV as the account backend, the same objects
 * live under `<rootPath>/Readest/account/files/<accountId>/<cloud file path>`
 * and are read/written directly with Basic auth.
 *
 * Key layout is preserved verbatim (`<accountId>/Readest/Books/<hash>/<file>`),
 * so every helper that reasons about a `file_key` — `isBookDataFileKey`, the
 * storage manager's grouping, purge-by-book — keeps working unchanged.
 *
 * Only replica binaries and (when Readest Cloud storage is on) book files land
 * here. In local mode `isReadestCloudStorageActive()` is false whenever a
 * third-party backend is selected, so book files normally travel through the
 * file-sync engine's `books/` tree instead of being uploaded twice.
 */
import type { AppService } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import type { FileEntry, FileSyncProvider } from '@/services/sync/file/provider';
import { getLocalAccountConfig, getLocalAccountId } from './config';
import { getLocalAccountProvider, storageObjectPath, storageRootPath } from './provider';

export interface LocalStorageStats {
  totalFiles: number;
  totalSize: number;
  usage: number;
  quota: number;
  usagePercentage: number;
  byBookHash: Array<{ bookHash: string | null; fileCount: number; totalSize: number }>;
}

export interface LocalFileRecord {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind: string | null;
  replica_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface LocalListFilesResponse {
  files: LocalFileRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface LocalPurgeResult {
  success: string[];
  failed: Array<{ fileKey: string; error: string }>;
  deletedCount: number;
  failedCount: number;
}

/**
 * WebDAV exposes no quota, so the storage panel reports usage against a
 * generous fixed ceiling instead of pretending to know the server's limit.
 */
const LOCAL_STORAGE_QUOTA = 1024 * 1024 * 1024 * 1024; // 1 TiB

const MAX_WALK_DEPTH = 8;

const accountContext = async (): Promise<{
  provider: FileSyncProvider;
  userId: string;
  root: string;
}> => {
  const provider = await getLocalAccountProvider();
  if (!provider) throw new Error('WebDAV account is not configured');
  const userId = getLocalAccountId();
  if (!userId) throw new Error('WebDAV account is not configured');
  return { provider, userId, root: storageRootPath(requireConfig(), userId) };
};

const requireConfig = () => {
  const config = getLocalAccountConfig();
  if (!config) throw new Error('WebDAV account is not configured');
  return config;
};

const objectPathFor = (userId: string, cfp: string): string =>
  storageObjectPath(requireConfig(), userId, cfp);

const fileKeyOf = (userId: string, cfp: string): string => `${userId}/${cfp}`;

const bookHashOf = (cfp: string): string | null => {
  const match = /\/Books\/([^/]+)\//.exec(cfp);
  return match ? match[1]! : null;
};

const replicaOf = (cfp: string): { kind: string | null; id: string | null } => {
  const match = /\/Replicas\/([^/]+)\/([^/]+)\//.exec(cfp);
  return match ? { kind: match[1]!, id: match[2]! } : { kind: null, id: null };
};

/** Recursively collect every file under `path`. Missing roots read as empty. */
const walkFiles = async (
  provider: FileSyncProvider,
  path: string,
  depth = 0,
): Promise<FileEntry[]> => {
  if (depth > MAX_WALK_DEPTH) return [];
  let entries: FileEntry[];
  try {
    entries = await provider.list(path);
  } catch (error) {
    // A storage tree that has never been written returns 404; that is "empty",
    // not an error the caller should surface.
    console.warn(`[localAccount] cannot list ${path}`, error);
    return [];
  }
  const files: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      files.push(...(await walkFiles(provider, entry.path, depth + 1)));
    } else {
      files.push(entry);
    }
  }
  return files;
};

const toRecord = (userId: string, root: string, entry: FileEntry): LocalFileRecord => {
  const cfp = entry.path.startsWith(`${root}/`) ? entry.path.slice(root.length + 1) : entry.path;
  const { kind, id } = replicaOf(cfp);
  const stamp = entry.lastModified ? new Date(entry.lastModified).toISOString() : '';
  return {
    file_key: fileKeyOf(userId, cfp),
    file_size: entry.size ?? 0,
    book_hash: bookHashOf(cfp),
    replica_kind: kind,
    replica_id: id,
    created_at: stamp,
    updated_at: stamp || null,
  };
};

/** Upload one object. Streams from disk on Tauri; buffers elsewhere. */
export const uploadLocalFile = async (
  file: File,
  fileFullPath: string,
  cfp: string,
  onProgress?: ProgressHandler,
): Promise<void> => {
  const provider = await getLocalAccountProvider();
  if (!provider) throw new Error('WebDAV account is not configured');
  const userId = getLocalAccountId();
  if (!userId) throw new Error('WebDAV account is not configured');
  const path = objectPathFor(userId, cfp);
  await provider.ensureDir(parentDirs(path));

  if (fileFullPath && provider.uploadStream) {
    const ok = await provider.uploadStream(path, fileFullPath);
    if (ok) {
      onProgress?.({ progress: file.size, total: file.size, transferSpeed: 0 });
      return;
    }
  }
  const buffer = await file.arrayBuffer();
  await provider.writeBinary(path, buffer);
  onProgress?.({ progress: buffer.byteLength, total: buffer.byteLength, transferSpeed: 0 });
};

/** Download one object to `dst`. Returns response headers (always empty here). */
export const downloadLocalFile = async (opts: {
  appService: AppService;
  dst: string;
  cfp: string;
  onProgress?: ProgressHandler;
}): Promise<Record<string, string>> => {
  const provider = await getLocalAccountProvider();
  if (!provider) throw new Error('WebDAV account is not configured');
  const userId = getLocalAccountId();
  if (!userId) throw new Error('WebDAV account is not configured');
  const path = objectPathFor(userId, opts.cfp);

  if (provider.downloadStream) {
    const ok = await provider.downloadStream(path, opts.dst, opts.onProgress);
    if (ok) return {};
  }
  const buffer = await provider.readBinary(path);
  if (!buffer) throw new Error(`Cloud file not found: ${opts.cfp}`);
  await opts.appService.writeFile(opts.dst, 'None', buffer);
  opts.onProgress?.({ progress: buffer.byteLength, total: buffer.byteLength, transferSpeed: 0 });
  return {};
};

/** Best-effort delete; a missing object is success. */
export const deleteLocalFile = async (cfp: string): Promise<void> => {
  const provider = await getLocalAccountProvider();
  const userId = getLocalAccountId();
  if (!provider || !userId) return;
  if (!provider.deleteFile) {
    console.warn('[localAccount] provider cannot delete single objects');
    return;
  }
  await provider.deleteFile(objectPathFor(userId, cfp));
};

/**
 * Download URLs are resolved lazily by {@link downloadLocalFile}, which knows
 * how to authenticate. Returning `null` keeps callers on that path instead of
 * handing them a URL they cannot fetch.
 */
export const localDownloadUrl = (): null => null;

export const getLocalStorageStats = async (): Promise<LocalStorageStats> => {
  const { provider, userId, root } = await accountContext();
  const entries = await walkFiles(provider, root);
  const records = entries.map((entry) => toRecord(userId, root, entry));
  const byBook = new Map<string | null, { fileCount: number; totalSize: number }>();
  let totalSize = 0;
  for (const record of records) {
    totalSize += record.file_size;
    const bucket = byBook.get(record.book_hash) ?? { fileCount: 0, totalSize: 0 };
    bucket.fileCount += 1;
    bucket.totalSize += record.file_size;
    byBook.set(record.book_hash, bucket);
  }
  return {
    totalFiles: records.length,
    totalSize,
    usage: totalSize,
    quota: LOCAL_STORAGE_QUOTA,
    usagePercentage: (totalSize / LOCAL_STORAGE_QUOTA) * 100,
    byBookHash: [...byBook.entries()].map(([bookHash, value]) => ({ bookHash, ...value })),
  };
};

export const listLocalFiles = async (params?: {
  page?: number;
  pageSize?: number;
  sortBy?: 'created_at' | 'updated_at' | 'file_size' | 'file_key';
  sortOrder?: 'asc' | 'desc';
  bookHash?: string;
  search?: string;
}): Promise<LocalListFilesResponse> => {
  const { provider, userId, root } = await accountContext();
  const entries = await walkFiles(provider, root);
  let records = entries.map((entry) => toRecord(userId, root, entry));
  if (params?.bookHash) records = records.filter((r) => r.book_hash === params.bookHash);
  if (params?.search) {
    const needle = params.search.toLowerCase();
    records = records.filter((r) => r.file_key.toLowerCase().includes(needle));
  }
  const sortBy = params?.sortBy ?? 'file_key';
  const direction = params?.sortOrder === 'desc' ? -1 : 1;
  records.sort((a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });

  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 100;
  const total = records.length;
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  const start = (page - 1) * pageSize;
  return {
    files: records.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
};

export const purgeLocalFiles = async (
  fileKeys: string[],
  isFileKeys = true,
): Promise<LocalPurgeResult> => {
  const userId = getLocalAccountId();
  const result: LocalPurgeResult = { success: [], failed: [], deletedCount: 0, failedCount: 0 };
  if (!userId) return result;
  for (const key of fileKeys) {
    const cfp = isFileKeys && key.startsWith(`${userId}/`) ? key.slice(userId.length + 1) : key;
    try {
      await deleteLocalFile(cfp);
      result.success.push(key);
      result.deletedCount += 1;
    } catch (error) {
      result.failed.push({ fileKey: key, error: (error as Error).message });
      result.failedCount += 1;
    }
  }
  return result;
};

/** Ancestors of a file path, so `ensureDir` can create them top-down. */
export const parentDirs = (absolutePath: string): string[] => {
  const segments = absolutePath.split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc += `/${segments[i]}`;
    out.push(acc);
  }
  return out;
};
