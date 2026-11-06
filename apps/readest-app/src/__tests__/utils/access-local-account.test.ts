import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getAccessToken,
  getCustomizationPurchased,
  getStoragePlanData,
  getSubscriptionPlan,
  getUserID,
  getUserProfilePlan,
  isCustomizationAllowed,
} from '@/utils/access';
import {
  LOCAL_ACCOUNT_TOKEN,
  __resetLocalAccountForTests,
  getLocalAccountId,
  setLocalAccountWebDAV,
} from '@/services/localAccount/config';

const connect = () =>
  setLocalAccountWebDAV({
    enabled: true,
    serverUrl: 'https://dav.example.com',
    username: 'reader',
    password: 'secret',
    rootPath: '/',
  });

beforeEach(() => {
  __resetLocalAccountForTests();
  localStorage.clear();
});

afterEach(() => {
  __resetLocalAccountForTests();
  localStorage.clear();
});

describe('local (WebDAV) account in the access layer', () => {
  test('hands out a token and a stable user id without a hosted session', async () => {
    connect();
    expect(await getAccessToken()).toBe(LOCAL_ACCOUNT_TOKEN);
    expect(await getUserID()).toBe(getLocalAccountId());
  });

  test('reports no token and no id when nothing is configured', async () => {
    expect(await getAccessToken()).toBe(null);
    expect(await getUserID()).toBe(null);
  });

  test('a hosted session keeps precedence over the WebDAV account', async () => {
    connect();
    localStorage.setItem('token', 'hosted-token');
    // The session lookup itself is platform-specific (localStorage on web, the
    // Supabase client on native); what matters here is that the local sentinel
    // never stands in for a real account.
    expect(await getAccessToken()).not.toBe(LOCAL_ACCOUNT_TOKEN);
  });

  test('the local token decodes to a fully entitled account', () => {
    expect(getSubscriptionPlan(LOCAL_ACCOUNT_TOKEN)).toBe('pro');
    expect(getUserProfilePlan(LOCAL_ACCOUNT_TOKEN)).toBe('pro');
    expect(getCustomizationPurchased(LOCAL_ACCOUNT_TOKEN)).toBe(true);
    const storage = getStoragePlanData(LOCAL_ACCOUNT_TOKEN);
    expect(storage.quota).toBeGreaterThan(0);
    expect(storage.usage).toBe(0);
  });

  test('an active local account unlocks premium features', () => {
    expect(isCustomizationAllowed('free', false)).toBe(false);
    connect();
    expect(isCustomizationAllowed('free', false)).toBe(true);
  });
});
