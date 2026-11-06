import { beforeEach, describe, expect, test } from 'vitest';
import {
  LOCAL_ACCOUNT_TOKEN,
  __resetLocalAccountForTests,
  getLocalAccountConfig,
  getLocalAccountId,
  hasHostedSession,
  isLocalAccountActive,
  isLocalAccountToken,
  normalizeLocalAccountConfig,
  setLocalAccountWebDAV,
} from '@/services/localAccount/config';
import type { WebDAVSettings } from '@/types/settings';

const webdav = (overrides: Partial<WebDAVSettings> = {}): Partial<WebDAVSettings> => ({
  enabled: true,
  serverUrl: 'https://dav.example.com/',
  username: 'reader',
  password: 'secret',
  rootPath: '/books/',
  ...overrides,
});

beforeEach(() => {
  __resetLocalAccountForTests();
  localStorage.clear();
});

describe('normalizeLocalAccountConfig', () => {
  test('requires an enabled connection with a URL and a username', () => {
    expect(normalizeLocalAccountConfig(webdav({ enabled: false }))).toBe(null);
    expect(normalizeLocalAccountConfig(webdav({ serverUrl: '  ' }))).toBe(null);
    expect(normalizeLocalAccountConfig(webdav({ username: '' }))).toBe(null);
    expect(normalizeLocalAccountConfig(null)).toBe(null);
  });

  test('trims the server URL and normalises the root path', () => {
    expect(normalizeLocalAccountConfig(webdav())).toEqual({
      serverUrl: 'https://dav.example.com',
      username: 'reader',
      password: 'secret',
      rootPath: '/books',
    });
    expect(normalizeLocalAccountConfig(webdav({ rootPath: '' }))?.rootPath).toBe('/');
    expect(normalizeLocalAccountConfig(webdav({ rootPath: 'nested/dir' }))?.rootPath).toBe(
      '/nested/dir',
    );
  });
});

describe('local account identity', () => {
  test('is inert until a connection is saved', () => {
    expect(getLocalAccountConfig()).toBe(null);
    expect(isLocalAccountActive()).toBe(false);
    expect(getLocalAccountId()).toBe(null);
  });

  test('becomes active once saved, and survives a reload through localStorage', () => {
    setLocalAccountWebDAV(webdav());
    expect(isLocalAccountActive()).toBe(true);
    const id = getLocalAccountId();
    expect(id).toMatch(/^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Simulate a fresh page load: the module cache is empty, only storage is left.
    __resetLocalAccountForTests();
    localStorage.setItem('readest.localAccount.webdav', JSON.stringify(webdav()));
    expect(getLocalAccountId()).toBe(id);
  });

  test('derives the same id for the same connection on another device', () => {
    const a = getLocalAccountId(normalizeLocalAccountConfig(webdav())!);
    const b = getLocalAccountId(normalizeLocalAccountConfig(webdav())!);
    expect(a).toBe(b);
    // A different root path is a different account namespace.
    const c = getLocalAccountId(normalizeLocalAccountConfig(webdav({ rootPath: '/other' }))!);
    expect(c).not.toBe(a);
  });

  test('disconnecting WebDAV clears the account', () => {
    setLocalAccountWebDAV(webdav());
    expect(isLocalAccountActive()).toBe(true);
    setLocalAccountWebDAV(webdav({ enabled: false }));
    expect(isLocalAccountActive()).toBe(false);
    expect(localStorage.getItem('readest.localAccount.webdav')).toBe(null);
  });

  test('a hosted session always wins over the WebDAV account', () => {
    setLocalAccountWebDAV(webdav());
    localStorage.setItem('token', 'supabase-access-token');
    expect(hasHostedSession()).toBe(true);
    expect(isLocalAccountActive()).toBe(false);
  });

  test('the local sentinel token never counts as a hosted session', () => {
    localStorage.setItem('token', LOCAL_ACCOUNT_TOKEN);
    expect(hasHostedSession()).toBe(false);
    expect(isLocalAccountToken(LOCAL_ACCOUNT_TOKEN)).toBe(true);
    expect(isLocalAccountToken('other')).toBe(false);
    expect(isLocalAccountToken(null)).toBe(false);
  });
});
