import React, { useEffect, useState } from 'react';
import { CommandService, useInjectable } from '@opensumi/ide-core-browser';
import { ReactEditorComponent } from '@opensumi/ide-editor/lib/browser';
import { IOlkilAuthService, OlkilAuthUser } from '../common';
import { OLKIL_AUTH_SIGN_IN, OLKIL_AUTH_SIGN_OUT } from './commands';
import styles from './account.view.module.less';

function initialLetter(user: OlkilAuthUser | null): string {
  const raw = (user?.displayName || user?.email || 'O').trim();
  return (raw[0] || 'O').toUpperCase();
}

export const OlkilAccountView: ReactEditorComponent<null> = () => {
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const commands = useInjectable<CommandService>(CommandService);
  const [user, setUser] = useState<OlkilAuthUser | null>(auth.getUser());
  const [busy, setBusy] = useState(false);
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

  const onSignIn = async () => {
    setBusy(true);
    try {
      await commands.executeCommand(OLKIL_AUTH_SIGN_IN.id);
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    setBusy(true);
    try {
      await commands.executeCommand(OLKIL_AUTH_SIGN_OUT.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.banner}>
        Manage your OLKIL account for the IDE. Sign in with Google via olkil.com — same account used on the website.
      </div>

      <h1 className={styles.title}>OLKIL Account</h1>
      <p className={styles.subtitle}>Profile, session, and sign-in for this editor.</p>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Account</h2>
        <p className={styles.sectionDesc}>Manage your account and session</p>

        {user ? (
          <>
            <div className={styles.row}>
              {user.photoURL && !photoFailed ? (
                <img
                  className={styles.avatar}
                  src={user.photoURL}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={() => setPhotoFailed(true)}
                />
              ) : (
                <div className={styles.avatarFallback} aria-hidden>
                  {initialLetter(user)}
                </div>
              )}
              <div className={styles.identity}>
                <div className={styles.name}>{user.displayName || 'OLKIL user'}</div>
                <div className={styles.email}>{user.email || 'No email on account'}</div>
              </div>
            </div>

            <div className={styles.meta}>
              <div className={styles.metaLabel}>User ID</div>
              <div className={styles.metaValue}>{user.uid}</div>
              <div className={styles.metaLabel}>Email verified</div>
              <div className={styles.metaValue}>{user.emailVerified ? 'Yes' : 'No'}</div>
            </div>

            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.row}>
              <div className={styles.avatarFallback} aria-hidden>
                ?
              </div>
              <div className={styles.identity}>
                <div className={styles.name}>Not signed in</div>
                <div className={styles.email}>Sign in with Google to sync your OLKIL account</div>
              </div>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy}
                onClick={onSignIn}
              >
                {busy ? 'Opening browser…' : 'Sign in with Google'}
              </button>
            </div>
            <p className={styles.hint}>
              A browser window will open on olkil.com. After you finish, this tab updates automatically.
            </p>
          </>
        )}
      </section>
    </div>
  );
};
