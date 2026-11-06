import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WebDAV doubles as the account backend for a signed-out device: connecting it
 * is what turns account features on (settings, collections, dictionaries,
 * fonts, reading statistics all replicate through it). So the row must never be
 * gated behind a plan the user cannot buy without signing in — that would be a
 * chicken-and-egg dead end. Signed-in users keep the normal premium rule for
 * every provider, WebDAV included.
 */

const mockNavigateToLogin = vi.fn();
const mockNavigateToProfile = vi.fn();
const mockPersistCloudProviderEnabled = vi.fn();
const mockSetRequestedSubPage = vi.fn();

let mockAuth: { user: unknown; isLocalAccount: boolean } = { user: null, isLocalAccount: false };
let mockQuota: { userProfilePlan: string | undefined; customizationPurchased: boolean } = {
  userProfilePlan: 'free',
  customizationPurchased: false,
};
let mockSettings: Record<string, unknown> = {};
let mockRequestedSubPage: string | null = null;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isDesktopApp: false } }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('@/hooks/useQuotaStats', () => ({ useQuotaStats: () => mockQuota }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useKeyDownActions', () => ({ useKeyDownActions: vi.fn() }));
vi.mock('@/helpers/settings', () => ({ saveSysSettings: vi.fn() }));
// The unlock is expressed purely through `isCloudSyncAllowed`, so the plan is
// the only input this test needs to vary.
vi.mock('@/utils/access', () => ({
  isCloudSyncAllowed: (plan: string, customizationPurchased: boolean) =>
    plan === 'pro' || plan === 'plus' || customizationPurchased === true,
}));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
  isWebAppPlatform: () => true,
}));
vi.mock('@/utils/nav', () => ({
  navigateToLogin: (...a: unknown[]) => mockNavigateToLogin(...a),
  navigateToProfile: (...a: unknown[]) => mockNavigateToProfile(...a),
}));
vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('@/services/sync/file/runLibrarySync', () => ({ canBackendRun: () => true }));
vi.mock('@/services/sync/providers/gdrive/buildGoogleDriveProvider', () => ({
  getGoogleWebClientId: () => undefined,
}));
vi.mock('@/services/sync/providers/onedrive/buildOneDriveProvider', () => ({
  getMicrosoftClientId: () => undefined,
}));
vi.mock('@/services/sync/providers/icloud/buildICloudProvider', () => ({
  isICloudSupportedPlatform: () => false,
}));
vi.mock('@/utils/bridge', () => ({
  getICloudContainerStatus: () => Promise.resolve({ available: false, documentsPath: '' }),
}));
vi.mock('@/services/localsend/devicePrefs', () => ({
  getLocalSendAlias: () => '',
  isLocalSendEnabled: () => false,
  setLocalSendEnabled: vi.fn(),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: mockSettings,
    requestedSubPage: mockRequestedSubPage,
    setRequestedSubPage: (...a: unknown[]) => mockSetRequestedSubPage(...a),
  }),
}));
vi.mock('@/store/customOPDSStore', () => {
  const state = { catalogs: [] as unknown[], loadCustomOPDSCatalogs: vi.fn() };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useCustomOPDSStore: hook };
});
vi.mock('@/store/absServerStore', () => {
  const state = { servers: [] as unknown[], loadABSServers: vi.fn() };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useABSServerStore: hook };
});
vi.mock('@/store/fileSyncStore', () => {
  const state = { byKind: {}, lastErrorByKind: {} };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useFileSyncStore: hook };
});
vi.mock('@/store/localsendStore', () => {
  const state = { status: undefined as unknown };
  const hook = (sel: (s: typeof state) => unknown) => sel(state);
  hook.getState = () => state;
  return { useLocalSendStore: hook };
});
vi.mock('@/components/settings/integrations/cloudSync', () => ({
  persistCloudProviderEnabled: (...a: unknown[]) => mockPersistCloudProviderEnabled(...a),
}));
// Sub-pages are irrelevant here; each collapses to a marker we can assert on.
vi.mock('@/components/settings/integrations/WebDAVForm', () => ({
  default: () => <div>WEBDAV_FORM</div>,
}));
vi.mock('@/components/settings/integrations/GoogleDriveForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/OneDriveForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/ICloudForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/S3Form', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/KOSyncForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/BookOrbitForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/ReadwiseForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/HardcoverForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/PageboundForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/NotionForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/ABSForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/SendToReadestForm', () => ({ default: () => null }));
vi.mock('@/components/settings/integrations/LocalSendForm', () => ({ default: () => null }));
vi.mock('@/app/opds/components/CatalogManager', () => ({ CatalogManager: () => null }));

const IntegrationsPanel = (await import('@/components/settings/IntegrationsPanel')).default;

const webdavSettings = (enabled: boolean) => ({
  readestCloud: { enabled: false },
  webdav: {
    enabled,
    serverUrl: 'https://dav.example.com/dav',
    username: 'reader',
    password: 'secret',
    syncBooks: false,
  },
  kosync: { enabled: false },
  readwise: { enabled: false },
  hardcover: { enabled: false },
  pagebound: { enabled: false },
  notion: { enabled: false },
  discordRichPresenceEnabled: false,
});

/** The checkbox whose aria-label is the row's toggle. */
const webdavToggle = () =>
  screen.getByLabelText('Sync with WebDAV') as HTMLInputElement & { disabled: boolean };

describe('IntegrationsPanel — WebDAV unlocks the account on a signed-out device', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = { user: null, isLocalAccount: false };
    mockQuota = { userProfilePlan: 'free', customizationPurchased: false };
    mockSettings = webdavSettings(false);
    mockRequestedSubPage = null;
  });

  afterEach(() => cleanup());

  it('signed out + free plan: the WebDAV row is not premium-gated', () => {
    render(<IntegrationsPanel />);

    // Configured WebDAV can be switched on inline...
    expect(webdavToggle().disabled).toBe(false);
    // ...and opening it reaches the config form instead of the upgrade page.
    fireEvent.click(screen.getByLabelText('WebDAV'));
    expect(screen.getByText('WEBDAV_FORM')).toBeTruthy();
    expect(mockNavigateToProfile).not.toHaveBeenCalled();
  });

  it('signed out + free plan: WebDAV carries no Premium chip while other providers still do', () => {
    render(<IntegrationsPanel />);

    // Only S3 is left to carry the chip (Drive/OneDrive need a client id on web).
    expect(screen.getAllByText('Premium')).toHaveLength(1);
  });

  it('signed in + free plan: WebDAV keeps the normal premium rule', () => {
    mockAuth = { user: { id: 'user-1', email: 'a@b.c' }, isLocalAccount: false };
    render(<IntegrationsPanel />);

    // Configured but gated: the inline toggle stays disabled...
    expect(webdavToggle().disabled).toBe(true);
    // ...and the row routes to the upgrade page rather than the config form.
    fireEvent.click(screen.getByLabelText('WebDAV'));
    expect(screen.queryByText('WEBDAV_FORM')).toBeNull();
    expect(mockNavigateToProfile).toHaveBeenCalled();
  });

  it('signed in + premium: WebDAV is ungated like before', () => {
    mockAuth = { user: { id: 'user-1', email: 'a@b.c' }, isLocalAccount: false };
    mockQuota = { userProfilePlan: 'pro', customizationPurchased: true };
    render(<IntegrationsPanel />);

    expect(webdavToggle().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('WebDAV'));
    expect(screen.getByText('WEBDAV_FORM')).toBeTruthy();
    expect(screen.queryByText('Premium')).toBeNull();
  });

  it('signed out: a deep-link to the WebDAV sub-page is honored', () => {
    mockRequestedSubPage = 'webdav';
    render(<IntegrationsPanel />);

    expect(screen.getByText('WEBDAV_FORM')).toBeTruthy();
    expect(mockSetRequestedSubPage).toHaveBeenCalledWith(null);
  });

  it('signed in + free plan: a deep-link to the WebDAV sub-page is dropped', () => {
    mockAuth = { user: { id: 'user-1', email: 'a@b.c' }, isLocalAccount: false };
    mockRequestedSubPage = 'webdav';
    render(<IntegrationsPanel />);

    expect(screen.queryByText('WEBDAV_FORM')).toBeNull();
    expect(mockSetRequestedSubPage).toHaveBeenCalledWith(null);
  });

  it('explains that the WebDAV server is the account in local-account mode', () => {
    mockAuth = { user: { id: 'local-1' }, isLocalAccount: true };
    render(<IntegrationsPanel />);

    expect(screen.getByText(/Your WebDAV server is the account for this device/)).toBeTruthy();
  });

  it('does not claim the WebDAV server is the account for a signed-in user', () => {
    mockAuth = { user: { id: 'user-1', email: 'a@b.c' }, isLocalAccount: false };
    mockQuota = { userProfilePlan: 'pro', customizationPurchased: true };
    render(<IntegrationsPanel />);

    expect(screen.queryByText(/Your WebDAV server is the account for this device/)).toBeNull();
  });
});
