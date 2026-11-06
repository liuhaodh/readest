import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MdChevronRight, MdCloudQueue } from 'react-icons/md';

import Dialog from '@/components/Dialog';
import WebDAVForm from '@/components/settings/integrations/WebDAVForm';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';

/** Who to ask for a WebDAV account. Shown as-is; not translated. */
const WEBDAV_CONTACT = 'vOrvyn_silent';

interface WebDAVUnlockEntryProps {
  /**
   * Called after a successful connection, once the dialog is closed. Navigation
   * is the caller's job: this component is also rendered outside a Next route
   * (and in tests), where `useRouter` has no router to talk to.
   */
  onConnected?: () => void;
}

/**
 * WebDAV escape hatch on the sign-in screen.
 *
 * Readest's cloud sync normally sits behind a paid plan, and a plan can only be
 * bought *after* signing in — which is exactly what a user who wants to keep
 * their own server refuses to do. Configuring WebDAV switches the app to the
 * local-account mode, where the paid sync features work without any account, so
 * the entry point belongs here rather than buried in Settings.
 *
 * The form is the very same `<WebDAVForm>` Settings uses; on a successful
 * connect it flips `settings.webdav.enabled`, which is the signal to drop the
 * dialog and hand the user over to the library.
 */
const WebDAVUnlockEntry: React.FC<WebDAVUnlockEntryProps> = ({ onConnected }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  // `useEnv()` hands back a fresh object each render, so `finishConnection` is
  // rebuilt on every render and the effect below would fire again mid-flight.
  // Guard on the transition instead of trusting callback identity.
  const handedOverRef = useRef(false);

  const webdavEnabled = settings.webdav?.enabled ?? false;

  const finishConnection = useCallback(async () => {
    // The library bounces straight back to /auth while `keepLogin` is set, so
    // clear it before handing over — same reasoning as the Back button.
    try {
      const appService = await envConfig.getAppService();
      const stored = await appService.loadSettings();
      if (stored.keepLogin) {
        const next = { ...stored, keepLogin: false };
        setSettings(next);
        await saveSettings(envConfig, next);
      }
    } catch (error) {
      // Failing to clear the flag must not strand the user in the dialog; the
      // caller's navigation is recoverable, a dead-end modal is not.
      console.error('Failed to clear keepLogin after WebDAV connect:', error);
    }
    setIsDialogOpen(false);
    onConnected?.();
  }, [envConfig, onConnected, saveSettings, setSettings]);

  // `enabled` flips on only after a successful connection probe, so it is a
  // reliable "we are done here" signal rather than an optimistic one.
  useEffect(() => {
    if (!isDialogOpen || !webdavEnabled || handedOverRef.current) return;
    handedOverRef.current = true;
    void finishConnection();
  }, [isDialogOpen, webdavEnabled, finishConnection]);

  const openDialog = () => {
    // A disconnect + reconnect in the same session must hand over again.
    handedOverRef.current = false;
    setIsDialogOpen(true);
  };

  return (
    <div className='flex w-full flex-col items-center gap-2'>
      <button
        type='button'
        onClick={openDialog}
        className={clsx(
          'flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-start',
          'bg-base-200/40 border-base-300/60 hover:bg-base-200/70',
          'transition-colors duration-150',
          'focus-visible:ring-base-content/15 focus-visible:outline-hidden focus-visible:ring-2',
        )}
      >
        <MdCloudQueue className='text-base-content/60 h-5 w-5 shrink-0' aria-hidden='true' />
        <span className='min-w-0 flex-1 text-[0.9em] font-medium leading-snug'>
          {_('Use WebDAV to unlock paid features for free')}
        </span>
        <MdChevronRight className='text-base-content/40 h-5 w-5 shrink-0' aria-hidden='true' />
      </button>
      <p className='text-base-content/50 select-text px-1 text-center text-[0.78em] leading-snug'>
        {_('Need a WebDAV server? Contact {{contact}}', { contact: WEBDAV_CONTACT })}
      </p>

      {isDialogOpen && (
        <Dialog
          isOpen
          title={_('WebDAV')}
          onClose={() => setIsDialogOpen(false)}
          boxClassName='sm:min-w-[440px] sm:max-w-[460px] sm:h-auto! sm:max-h-[80%]'
          contentClassName='my-0! px-5! pt-0! pb-4! grow-0!'
        >
          <WebDAVForm />
        </Dialog>
      )}
    </div>
  );
};

export default WebDAVUnlockEntry;
