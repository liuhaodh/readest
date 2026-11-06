/**
 * Local (WebDAV) account — transport plumbing.
 *
 * Everything the account layer stores lives in one subtree of the user's
 * WebDAV root, beside the file-sync tree the engine already owns:
 *
 *   <rootPath>/
 *     Readest/
 *       account/
 *         replicas/<kind>.json      ← CRDT replica rows, one bundle per kind
 *         replica-keys.json         ← passphrase salts (encrypted credentials)
 *         sync/<type>.json          ← legacy rows: books / configs / notes / stats
 *         files/<userId>/<cfp>      ← replica binaries (dictionaries, fonts, …)
 *
 * The layout is additive: a WebDAV account written by this fork is still a
 * normal WebDAV tree, and the `books/` + `library.json` tree the file-sync
 * engine uses is untouched.
 */
import { buildBasePath } from '@/services/sync/file/layout';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import { createFileSyncProvider } from '@/services/sync/file/providerRegistry';
import { getLocalAccountConfig, type LocalAccountConfig } from './config';

/** Root of the account subtree: `<rootPath>/Readest/account`. */
export const localAccountBasePath = (rootPath: string): string =>
  `${buildBasePath(rootPath)}/account`;

const joinPath = (...segments: string[]): string =>
  segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');

// Paths are kept decoded here: the WebDAV client percent-encodes each segment
// when it builds a request URL, and returns decoded paths from listings.

export const replicaBundlePath = (config: LocalAccountConfig, kind: string): string =>
  `/${joinPath(localAccountBasePath(config.rootPath), 'replicas', `${kind}.json`)}`;

export const replicaKeysPath = (config: LocalAccountConfig): string =>
  `/${joinPath(localAccountBasePath(config.rootPath), 'replica-keys.json')}`;

export const legacySyncPath = (config: LocalAccountConfig, type: string): string =>
  `/${joinPath(localAccountBasePath(config.rootPath), 'sync', `${type}.json`)}`;

/**
 * Storage object path. `cfp` mirrors the hosted backend's cloud file path
 * (`Readest/Books/<hash>/<file>`), and the account id takes the place of the
 * server's user prefix so two accounts on one WebDAV server cannot collide.
 */
export const storageObjectPath = (
  config: LocalAccountConfig,
  userId: string,
  cfp: string,
): string => `/${joinPath(localAccountBasePath(config.rootPath), 'files', userId, cfp)}`;

/** Storage root of one account, used for listings and quota math. */
export const storageRootPath = (config: LocalAccountConfig, userId: string): string =>
  `/${joinPath(localAccountBasePath(config.rootPath), 'files', userId)}`;

/** Directory ancestors of a file path, for `ensureDir` before a write. */
export const parentDirectories = (absolutePath: string): string[] => {
  const segments = absolutePath.split('/').filter(Boolean);
  const out: string[] = [];
  let acc = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    acc += `/${segments[i]}`;
    out.push(acc);
  }
  return out;
};

/**
 * The WebDAV provider for the active local account, or `null` when local mode
 * is not configured. Memoised by the provider registry, keyed on the connection
 * so a credentials edit rebuilds it.
 */
export const getLocalAccountProvider = async (): Promise<FileSyncProvider | null> => {
  const config = getLocalAccountConfig();
  if (!config) return null;
  return createFileSyncProvider('webdav', { webdav: { ...config, enabled: true } });
};

/** Same as {@link getLocalAccountProvider}, throwing when unconfigured. */
export const requireLocalAccountProvider = async (): Promise<FileSyncProvider> => {
  const provider = await getLocalAccountProvider();
  if (!provider) throw new Error('WebDAV account is not configured');
  return provider;
};

/** Write a JSON document, creating its parent collections first. */
export const writeJson = async (
  provider: FileSyncProvider,
  path: string,
  value: unknown,
): Promise<void> => {
  await provider.ensureDir(parentDirectories(path));
  await provider.writeText(path, JSON.stringify(value), 'application/json; charset=utf-8');
};

/** Read and parse a JSON document. `null` when the object does not exist. */
export const readJson = async <T>(provider: FileSyncProvider, path: string): Promise<T | null> => {
  const text = await provider.readText(path);
  if (text === null || text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A truncated write (interrupted upload) must not wedge the whole kind:
    // treat it as "no remote state" and let the next push rewrite it.
    console.warn(`[localAccount] unreadable JSON at ${path}`);
    return null;
  }
};
