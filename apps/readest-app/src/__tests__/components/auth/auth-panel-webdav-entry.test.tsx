import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SystemSettings } from '@/types/settings';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * The sign-in screen is the only place a user who refuses to create an account
 * can discover that WebDAV unlocks the paid sync features. It has to offer the
 * form right there, and connecting has to clear `keepLogin` before handing
 * over — otherwise the library redirects straight back to /auth.
 */

const saveSettings = vi.fn(async (_settings: SystemSettings) => {});
const loadSettings = vi.fn(async () => useSettingsStore.getState().settings);

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings, loadSettings }) },
    appService: null,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, opts?: Record<string, string>) =>
    opts ? key.replace(/\{\{(\w+)\}\}/g, (_m, name) => opts[name] ?? _m) : key,
}));

vi.mock('@/utils/settingsSync', () => ({
  broadcastGlobalSettings: vi.fn(),
}));

// The real form drags in the whole sync stack; only its presence matters here.
vi.mock('@/components/settings/integrations/WebDAVForm', () => ({
  default: () => <div data-testid='webdav-form' />,
}));

vi.mock('@/components/Dialog', () => ({
  default: ({ isOpen, title, children }: { isOpen: boolean; title?: string; children: unknown }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        {children as never}
      </div>
    ) : null,
}));

import AuthPanel from '@/app/auth/components/AuthPanel';

const freshInstall = {
  version: 1,
  keepLogin: false,
  webdav: { enabled: false },
  googleDrive: { enabled: false },
} as unknown as SystemSettings;

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: freshInstall } as never);
});

afterEach(() => {
  cleanup();
});

const renderPanel = (onWebDAVConnected = vi.fn()) => {
  render(
    <AuthPanel
      supabaseClient={{} as never}
      onProviderSignIn={vi.fn(async () => {})}
      magicLink
      onWebDAVConnected={onWebDAVConnected}
    />,
  );
  return onWebDAVConnected;
};

const entryButton = () =>
  screen.getByRole('button', { name: /Use WebDAV to unlock paid features for free/ });

describe('sign-in WebDAV entry', () => {
  test('offers WebDAV as a way around the paid plan, with the contact hint', () => {
    renderPanel();

    expect(entryButton()).toBeTruthy();
    expect(screen.getByText(/Need a WebDAV server\? Contact vOrvyn_silent/)).toBeTruthy();
    // The form stays closed until the user asks for it.
    expect(screen.queryByTestId('webdav-form')).toBeNull();
  });

  test('opens the shared WebDAV form in a dialog', () => {
    renderPanel();

    fireEvent.click(entryButton());

    expect(screen.getByTestId('webdav-form')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'WebDAV' })).toBeTruthy();
  });

  test('hands over once connected, clearing keepLogin first', async () => {
    const onWebDAVConnected = renderPanel();

    fireEvent.click(entryButton());
    expect(screen.getByTestId('webdav-form')).toBeTruthy();

    // WebDAVForm flips `enabled` on only after the connection probe succeeds.
    act(() => {
      useSettingsStore.setState({
        settings: { ...freshInstall, keepLogin: true, webdav: { enabled: true } },
      } as never);
    });

    await waitFor(() => expect(onWebDAVConnected).toHaveBeenCalledTimes(1));
    // The mock stands in for `appService.saveSettings(settings)`.
    expect(saveSettings).toHaveBeenCalled();
    const persisted = saveSettings.mock.calls[0]![0];
    expect(persisted.keepLogin).toBe(false);
    // The dialog is gone, so the user cannot keep poking at a form they finished.
    expect(screen.queryByTestId('webdav-form')).toBeNull();
  });

  test('does not hand over for a connection that predates the dialog', () => {
    useSettingsStore.setState({
      settings: { ...freshInstall, webdav: { enabled: true } },
    } as never);
    const onWebDAVConnected = renderPanel();

    expect(onWebDAVConnected).not.toHaveBeenCalled();
  });
});
