import React, { useEffect, useState } from 'react';
import { CommandService, isMacintosh, useInjectable } from '@opensumi/ide-core-browser';
import {
  ElectronHeaderBar,
  HeaderBarRightComponent,
} from '@opensumi/ide-electron-basic/lib/browser/header/header.view';
import { IOlkilAuthService, OlkilAuthUser } from '../common';
import { OLKIL_AUTH_OPEN_ACCOUNT } from './commands';
import styles from './auth-header.module.less';

function initialLetter(user: OlkilAuthUser | null): string {
  const raw = (user?.displayName || user?.email || 'O').trim();
  return (raw[0] || 'O').toUpperCase();
}

/** Profile / Sign in control — sits left of minimize / maximize / close. */
export const OlkilAuthAvatarButton = () => {
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const commands = useInjectable<CommandService>(CommandService);
  const [user, setUser] = useState<OlkilAuthUser | null>(auth.getUser());
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    setUser(auth.getUser());
    setPhotoFailed(false);
    const sub = auth.onDidChangeSession((session) => {
      setUser(session?.user ?? null);
      setPhotoFailed(false);
    });
    return () => sub.dispose();
  }, [auth]);

  const label = user
    ? user.displayName || user.email || 'OLKIL account'
    : 'Sign in to OLKIL';

  return (
    <button
      type="button"
      className={styles.avatarBtn}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void commands.executeCommand(OLKIL_AUTH_OPEN_ACCOUNT.id);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {user?.photoURL && !photoFailed ? (
        <img
          className={styles.avatarImg}
          src={user.photoURL}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <span className={styles.avatarFallback} aria-hidden>
          {user ? initialLetter(user) : '?'}
        </span>
      )}
      {!user && <span className={styles.signInLabel}>Sign in</span>}
    </button>
  );
};

export const OlkilHeaderRightComponent = () => (
  <div className={styles.rightCluster}>
    <OlkilAuthAvatarButton />
    {/* Native traffic lights on macOS — only inject Windows/Linux chrome buttons. */}
    {!isMacintosh && <HeaderBarRightComponent />}
  </div>
);

/** Replaces default electron-header so account sits beside window controls. */
export const OlkilElectronHeaderBar = () => <ElectronHeaderBar RightComponent={OlkilHeaderRightComponent} />;
