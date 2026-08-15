import React, { useEffect, useState } from 'react';
import { CommandService, useInjectable } from '@opensumi/ide-core-browser';
import { ReactEditorComponent } from '@opensumi/ide-editor/lib/browser';
import { IOlkilAuthService, OlkilAuthUser } from '../common';
import { OLKIL_AUTH_SIGN_IN, OLKIL_AUTH_SIGN_OUT } from './commands';
import styles from './account.view.module.less';

type OlkilSubscription = {
  plan: string;
  plan_name: string;
  tokens_total_label?: string;
  tokens_used_label?: string;
  tokens_left_label?: string;
  percent_used: number;
  percent_left: number;
  expires_label: string;
  is_paid: boolean;
  is_expired?: boolean;
};

function initialLetter(user: OlkilAuthUser | null): string {
  const raw = (user?.displayName || user?.email || 'O').trim();
  return (raw[0] || 'O').toUpperCase();
}

async function loadSubscription(email: string | null | undefined): Promise<OlkilSubscription | null> {
  if (!email) {
    return null;
  }
  try {
    const res = await fetch(
      `https://olkil.com/wp-json/olkil-payu/v1/subscription?email=${encodeURIComponent(email)}`,
    );
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as OlkilSubscription;
  } catch {
    return null;
  }
}

export const OlkilAccountView: ReactEditorComponent<null> = () => {
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const commands = useInjectable<CommandService>(CommandService);
  const [user, setUser] = useState<OlkilAuthUser | null>(auth.getUser());
  const [sub, setSub] = useState<OlkilSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    setUser(auth.getUser());
    setPhotoFailed(false);
    const subChange = auth.onDidChangeSession((session) => {
      setUser(session?.user ?? null);
      setPhotoFailed(false);
    });
    return () => subChange.dispose();
  }, [auth]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await loadSubscription(user?.email);
      if (!cancelled) {
        setSub(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.email]);

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

  const pctLeft = sub?.percent_left ?? 100;

  return (
    <div className={styles.page}>
      <div className={styles.banner}>
        Manage your OLKIL account for the IDE. Sign in with Google via olkil.com — same plan and credits as the website.
      </div>

      <h1 className={styles.title}>OLKIL Account</h1>
      <p className={styles.subtitle}>Profile, plan, credits, and session for this editor.</p>

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
                <div className={styles.nameRow}>
                  <div className={styles.name}>{user.displayName || 'OLKIL user'}</div>
                  <span className={styles.planBadge}>{sub?.plan_name || 'Dazzlone'}</span>
                </div>
                <div className={styles.email}>{user.email || 'No email on account'}</div>
              </div>
            </div>

            <div className={styles.planCard}>
              <div className={styles.planCardTop}>
                <span>Credits remaining</span>
                <strong>{sub?.is_paid ? `${pctLeft}% left` : 'Local · unlimited'}</strong>
              </div>
              <div className={styles.bar}>
                <span style={{ width: `${Math.max(0, Math.min(100, pctLeft))}%` }} />
              </div>
              <p className={styles.planHint}>
                {sub?.is_paid
                  ? `${sub.tokens_left_label || '0'} remaining of ${sub.tokens_total_label || '0'} · ${sub.tokens_used_label || '0'} used`
                  : 'Free Dazzlone — local models, no cloud token cap'}
              </p>
              <div className={styles.meta}>
                <div className={styles.metaLabel}>Plan</div>
                <div className={styles.metaValue}>{sub?.plan_name || 'Dazzlone'}</div>
                <div className={styles.metaLabel}>Expires</div>
                <div className={styles.metaValue}>{sub?.expires_label || 'Never (free local)'}</div>
                <div className={styles.metaLabel}>User ID</div>
                <div className={styles.metaValue}>{user.uid}</div>
                <div className={styles.metaLabel}>Email verified</div>
                <div className={styles.metaValue}>{user.emailVerified ? 'Yes' : 'No'}</div>
              </div>
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
                <div className={styles.email}>Sign in with Google to sync your OLKIL plan & credits</div>
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
