import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      refreshSession: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn() },
}));

import { AuthProvider, useAuth } from '@/context/AuthContext';
import { useSettingsStore } from '@/store/settingsStore';
import {
  LOCAL_ACCOUNT_TOKEN,
  __resetLocalAccountForTests,
  getLocalAccountId,
  normalizeLocalAccountConfig,
} from '@/services/localAccount/config';
import type { SystemSettings, WebDAVSettings } from '@/types/settings';

const webdav = (overrides: Partial<WebDAVSettings> = {}): WebDAVSettings => ({
  enabled: true,
  serverUrl: 'https://dav.example.com',
  username: 'reader',
  password: 'secret',
  rootPath: '/',
  ...overrides,
});

const setWebdav = (slice: WebDAVSettings | undefined) => {
  act(() => {
    // `webdav` is a required slice on SystemSettings, but "disconnected" is
    // modelled as an absent slice here, so the cast is deliberate.
    const next = { ...useSettingsStore.getState().settings, webdav: slice } as SystemSettings;
    useSettingsStore.getState().setSettings(next);
  });
};

const captured: ReturnType<typeof useAuth>[] = [];

function Probe() {
  captured.push(useAuth());
  return null;
}

const latest = () => captured[captured.length - 1]!;
const expectedId = () => getLocalAccountId(normalizeLocalAccountConfig(webdav()));

beforeEach(() => {
  localStorage.clear();
  captured.length = 0;
  __resetLocalAccountForTests();
  useSettingsStore.getState().setSettings({} as SystemSettings);
});

afterEach(() => {
  cleanup();
  __resetLocalAccountForTests();
  useSettingsStore.getState().setSettings({} as SystemSettings);
  localStorage.clear();
});

describe('AuthContext with a local (WebDAV) account', () => {
  test('exposes a synthetic user and token so account features can run', () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    expect(latest().user).toBe(null);
    expect(latest().token).toBe(null);
    expect(latest().isLocalAccount).toBe(false);

    setWebdav(webdav());

    expect(latest().isLocalAccount).toBe(true);
    expect(latest().token).toBe(LOCAL_ACCOUNT_TOKEN);
    expect(latest().user?.id).toBe(expectedId());
    expect(latest().user?.email).toBe('reader@dav.example.com');
  });

  test('mirrors the account id into localStorage for non-React readers', () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    setWebdav(webdav());
    expect(JSON.parse(localStorage.getItem('user') ?? '{}').id).toBe(expectedId());
  });

  test('a hosted session keeps precedence, and disconnecting drops the account', () => {
    localStorage.setItem('token', 'hosted-token');
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    setWebdav(webdav());
    expect(latest().isLocalAccount).toBe(false);
    expect(latest().token).toBe('hosted-token');

    localStorage.removeItem('token');
    act(() => {
      // Re-render by flipping an unrelated settings field; the token state is
      // React state, so drive the switch through the settings slice instead.
      useSettingsStore.getState().setSettings({} as SystemSettings);
    });
    setWebdav(webdav({ enabled: false }));
    expect(latest().isLocalAccount).toBe(false);
    expect(latest().user).toBe(null);
    expect(localStorage.getItem('user')).toBe(null);
  });
});
