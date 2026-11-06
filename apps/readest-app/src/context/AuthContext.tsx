'use client';

import {
  createContext,
  useState,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
} from 'react';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/utils/supabase';
import posthog from 'posthog-js';
import { useSettingsStore } from '@/store/settingsStore';
import {
  LOCAL_ACCOUNT_TOKEN,
  getLocalAccountId,
  normalizeLocalAccountConfig,
  type LocalAccountConfig,
} from '@/services/localAccount/config';

interface AuthContextType {
  token: string | null;
  user: User | null;
  /**
   * True when the session comes from a configured WebDAV account rather than
   * the hosted backend. Account features run either way; surfaces that can only
   * work against the hosted API (share links, email inbox, hosted AI) use this
   * to stay quiet instead of failing at request time.
   */
  isLocalAccount: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  refresh: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * A synthetic user for the local (WebDAV) account.
 *
 * Every account-gated surface in the app asks `useAuth()` for a user — library
 * sync, replica pull, transfers, the quota panel. Rather than rewrite each gate
 * to also understand "WebDAV account", the local account presents the same
 * shape: a stable id derived from the connection, and a display identity built
 * from the server host so the UI never shows a blank account row.
 */
const buildLocalUser = (config: LocalAccountConfig): User => {
  let host = config.serverUrl;
  try {
    host = new URL(config.serverUrl).host;
  } catch {
    // A malformed URL cannot happen once connected (checkConnection validated
    // it); fall back to the raw string rather than throwing here.
  }
  const name = config.username || host;
  return {
    id: getLocalAccountId(config) ?? 'local-account',
    email: config.username ? `${config.username}@${host}` : host,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'webdav', providers: ['webdav'] },
    user_metadata: { full_name: name, webdav: true },
    created_at: new Date(0).toISOString(),
  } as unknown as User;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('token');
    }
    return null;
  });
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window !== 'undefined') {
      const userJson = localStorage.getItem('user');
      return userJson ? JSON.parse(userJson) : null;
    }
    return null;
  });

  // The WebDAV connection doubles as the account when there is no hosted
  // session. Subscribing to the settings slice (rather than reading it once)
  // makes connecting WebDAV in Settings take effect without a reload.
  const webdav = useSettingsStore((state) => state.settings?.webdav);
  const localAccountConfig = useMemo(() => normalizeLocalAccountConfig(webdav), [webdav]);

  useEffect(() => {
    const syncSession = (
      session: { access_token: string; refresh_token: string; user: User } | null,
    ) => {
      if (session) {
        console.log('Syncing session');
        const { access_token, refresh_token, user } = session;
        localStorage.setItem('token', access_token);
        localStorage.setItem('refresh_token', refresh_token);
        localStorage.setItem('user', JSON.stringify(user));
        posthog.identify(user.id);
        setToken(access_token);
        setUser(user);
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
        setToken(null);
        setUser(null);
      }
    };
    const refreshSession = async () => {
      try {
        await supabase.auth.refreshSession();
      } catch {
        syncSession(null);
      }
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((_, session) => {
      syncSession(session);
    });

    refreshSession();
    return () => {
      subscription?.subscription.unsubscribe();
    };
  }, []);

  // setToken / setUser from useState are stable across renders, so the empty
  // deps array is correct. Wrapping in useCallback (and only including stable
  // refs in the deps) is what makes the useMemo below actually memoize the
  // context value — without this, login/logout/refresh would be recreated on
  // every render and the memo would always invalidate.
  const login = useCallback((newToken: string, newUser: User) => {
    console.log('Logging in');
    setToken(newToken);
    setUser(newUser);
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(newUser));
  }, []);

  const logout = useCallback(async () => {
    console.log('Logging out');
    try {
      await supabase.auth.refreshSession();
    } catch {
    } finally {
      await supabase.auth.signOut({ scope: 'local' });
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setToken(null);
      setUser(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      return !error && !!data.session;
    } catch {
      return false;
    }
  }, []);

  const localUser = useMemo(
    () => (localAccountConfig ? buildLocalUser(localAccountConfig) : null),
    [localAccountConfig],
  );
  // A hosted session always wins: a signed-in user keeps the hosted backend even
  // with WebDAV configured, so nothing silently moves their data.
  const isLocalAccount = !token && !!localUser;

  // Several non-React modules identify the account by reading `localStorage.user`
  // directly (the bookshelf journal, the offline-recovery path in
  // settingsService). Mirror the synthetic identity there so a local-account edit
  // is attributed to the same id its replica rows carry, and clear it again when
  // the connection goes away.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isLocalAccount && localUser) {
      localStorage.setItem('user', JSON.stringify(localUser));
    } else if (!user) {
      localStorage.removeItem('user');
    }
  }, [isLocalAccount, localUser, user]);

  const value = useMemo(
    () => ({
      token: token ?? (isLocalAccount ? LOCAL_ACCOUNT_TOKEN : null),
      user: user ?? (isLocalAccount ? localUser : null),
      isLocalAccount,
      login,
      logout,
      refresh,
    }),
    [token, user, localUser, isLocalAccount, login, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
