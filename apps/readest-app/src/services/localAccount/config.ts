/**
 * Local (WebDAV) account — configuration and identity.
 *
 * Readest's account features (cloud sync of settings / collections /
 * dictionaries / stats / credentials, replica binary storage, premium gates)
 * are normally served by the hosted backend and gated behind a signed-in
 * Supabase user. This module turns a configured WebDAV server into a drop-in
 * replacement: once the user connects WebDAV in Settings → Integrations and
 * there is no hosted session, the app runs in "local account" mode, where the
 * WebDAV tree under `<rootPath>/Readest/account/` plays the role of the server
 * and a deterministic id derived from the connection plays the role of the
 * user id.
 *
 * Design constraints:
 *
 * - **No session, no hosted account.** Local mode is only ever active when the
 *   device has no Supabase token. A signed-in user keeps the hosted backend
 *   even with WebDAV configured, so nothing silently moves their data.
 * - **Stable across devices.** The account id is a hash of the connection
 *   (server URL + username + root path), so two devices pointing at the same
 *   WebDAV account derive the same id — which is what makes replica rows and
 *   storage keys line up between them.
 * - **Readable before settings load.** Sync gates run from non-React modules at
 *   boot, before `loadSettings()` resolves. The active connection is therefore
 *   cached in `localStorage` as well as in memory.
 */
import type { WebDAVSettings } from '@/types/settings';

/**
 * Stand-in access token for local mode. Callers that only need "is there a
 * session" (`getAccessToken() != null`) see a token; the hosted API rejects it,
 * which is the intended outcome — local mode never talks to the hosted backend.
 */
export const LOCAL_ACCOUNT_TOKEN = 'readest-local-account';

export interface LocalAccountConfig {
  serverUrl: string;
  username: string;
  password: string;
  rootPath: string;
}

const CACHE_KEY = 'readest.localAccount.webdav';

/** `undefined` = never hydrated, `null` = hydrated and not configured. */
let cached: LocalAccountConfig | null | undefined;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const normalizeRootPath = (rootPath: string | undefined): string => {
  const raw = (rootPath ?? '').trim();
  if (!raw || raw === '/') return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.replace(/\/+$/, '') || '/';
};

/**
 * Build a usable config from a stored WebDAV slice, or `null` when the slice
 * is not a complete connection (or is switched off). `enabled` is load-bearing:
 * disconnecting WebDAV must stop local mode, otherwise a disconnected server
 * would keep receiving the user's data.
 */
export const normalizeLocalAccountConfig = (
  webdav: Partial<WebDAVSettings> | null | undefined,
): LocalAccountConfig | null => {
  if (!webdav || webdav.enabled !== true) return null;
  const serverUrl = trimTrailingSlash((webdav.serverUrl ?? '').trim());
  const username = (webdav.username ?? '').trim();
  if (!serverUrl || !username) return null;
  return {
    serverUrl,
    username,
    password: webdav.password ?? '',
    rootPath: normalizeRootPath(webdav.rootPath),
  };
};

const readFromStorage = (): LocalAccountConfig | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WebDAVSettings> | null;
    return normalizeLocalAccountConfig(parsed ? { ...parsed, enabled: true } : null);
  } catch {
    return null;
  }
};

/**
 * Refresh the in-memory + persisted copy from the live settings. Called from
 * the settings load/save path so every route sees the same answer without
 * importing the settings store (which would cycle back into this module).
 */
export const setLocalAccountWebDAV = (webdav: Partial<WebDAVSettings> | null | undefined): void => {
  const next = normalizeLocalAccountConfig(webdav);
  cached = next;
  if (typeof localStorage === 'undefined') return;
  try {
    if (next) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...next, enabled: true }));
    } else {
      localStorage.removeItem(CACHE_KEY);
    }
  } catch {
    // A full or disabled storage quota must not break settings loading; the
    // in-memory copy above already covers this session.
  }
};

/** The active WebDAV connection, or `null` when local mode is not configured. */
export const getLocalAccountConfig = (): LocalAccountConfig | null => {
  if (cached === undefined) cached = readFromStorage();
  return cached;
};

/** Whether a hosted (Supabase) session token is present on this device. */
export const hasHostedSession = (): boolean => {
  if (typeof localStorage === 'undefined') return false;
  const token = localStorage.getItem('token');
  return !!token && token !== LOCAL_ACCOUNT_TOKEN;
};

/**
 * Local mode is active when WebDAV is connected and this device is not signed
 * in to the hosted backend.
 */
export const isLocalAccountActive = (): boolean => !!getLocalAccountConfig() && !hasHostedSession();

export const isLocalAccountToken = (token: string | null | undefined): boolean =>
  token === LOCAL_ACCOUNT_TOKEN;

const fnv1a = (value: string, seed: number): string => {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * Deterministic id for the WebDAV account. Two devices configured with the same
 * server/username/root derive the same id, so replica rows (`user_id`) and
 * storage keys match without any server-side lookup.
 *
 * Shaped like a UUID because downstream code assumes ids are opaque short
 * strings and some paths slice on '-'.
 */
export const getLocalAccountId = (
  config: LocalAccountConfig | null = getLocalAccountConfig(),
): string | null => {
  if (!config) return null;
  const key = `${config.serverUrl}|${config.username}|${config.rootPath}`;
  const hex = `${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x01000193)}${fnv1a(
    `${key}#readest`,
    0x811c9dc5,
  )}${fnv1a(`${key}#readest`, 0x01000193)}`;
  return `local-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
};

/** Test seam — forget both the in-memory and the persisted copy. */
export const __resetLocalAccountForTests = (): void => {
  cached = undefined;
  if (typeof localStorage !== 'undefined') localStorage.removeItem(CACHE_KEY);
};
