import React, { useEffect, useMemo, useState } from 'react';
import { CommandService, useInjectable } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { ReactEditorComponent } from '@opensumi/ide-editor/lib/browser';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common';
import {
  DiscoveredMcpServer,
  IOlkilAiNodeService,
  IOlkilChatService,
  IOlkilChatUiService,
  OlkilAiNodeServicePath,
} from 'modules/olkil-ai/common';
import { AI_MODELS } from 'modules/olkil-ai/common/models';
import { DeepSeekIcon, isDeepSeekProvider } from 'modules/olkil-ai/browser/deepseek-icon';
import logoUrl from '../../../browser/assets/olkil-logo.png';
import { IOlkilAuthService, OlkilAuthUser } from '../common';
import {
  ChatModeSetting,
  IOlkilSettingsService,
  OLKIL_SETTINGS_SECTION_KEY,
  OlkilMcpServer,
  OlkilSettings,
  SETTINGS_NAV,
  SettingsSectionId,
  isModelEnabledInSettings,
  newMcpServerId,
  toggleEnabledModelId,
} from '../common/settings';
import { OLKIL_AUTH_OPEN_ACCOUNT, OLKIL_AUTH_SIGN_IN, OLKIL_AUTH_SIGN_OUT, OLKIL_SETTINGS_SECTION_EVENT, rememberOlkilSettingsSection } from './commands';
import styles from './account.view.module.less';

type OlkilSubscription = {
  plan: string;
  plan_name: string;
  tokens_total_label?: string;
  tokens_used_label?: string;
  tokens_left_label?: string;
  percent_left_label?: string;
  spendable_left?: number;
  drawing_plan?: string;
  drawing_plan_name?: string;
  percent_used: number;
  percent_left: number;
  expires_label: string;
  is_paid: boolean;
  is_expired?: boolean;
  next_plan?: string;
  next_plan_name?: string;
  upgrade_url?: string;
  renew_url?: string;
  renew_plan_name?: string;
  quota_reason?: string;
  held_plans?: Array<{
    plan: string;
    plan_name: string;
    tokens_left_label?: string;
    expires_on?: string;
    status?: string;
  }>;
};

function initialLetter(user: OlkilAuthUser | null): string {
  const raw = (user?.displayName || user?.email || 'O').trim();
  return (raw[0] || 'O').toUpperCase();
}

const SUB_CACHE_PREFIX = 'olkil.subscription.cache.';
const subMemory = new Map<string, OlkilSubscription>();
const subInflight = new Map<string, Promise<OlkilSubscription | null>>();

function subEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

function subCacheKey(email: string): string {
  return SUB_CACHE_PREFIX + subEmailKey(email);
}

function isUsableSubscription(value: unknown): value is OlkilSubscription {
  return Boolean(value && typeof value === 'object' && typeof (value as OlkilSubscription).plan_name === 'string' && (value as OlkilSubscription).plan_name);
}

function readCachedSubscription(email: string | null | undefined): OlkilSubscription | null {
  if (!email) {
    return null;
  }
  const key = subEmailKey(email);
  const fromMemory = subMemory.get(key);
  if (fromMemory) {
    return fromMemory;
  }
  try {
    const raw = window.localStorage.getItem(subCacheKey(email));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as OlkilSubscription;
    if (!isUsableSubscription(parsed)) {
      return null;
    }
    subMemory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedSubscription(email: string, sub: OlkilSubscription): void {
  const key = subEmailKey(email);
  subMemory.set(key, sub);
  try {
    window.localStorage.setItem(subCacheKey(email), JSON.stringify(sub));
  } catch {
    // ignore quota / private mode
  }
}

async function fetchSubscription(email: string): Promise<OlkilSubscription | null> {
  try {
    const res = await fetch('https://olkil.com/wp-json/olkil-payu/v1/subscription', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      body: JSON.stringify({ email, _: Date.now() }),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as OlkilSubscription;
    if (isUsableSubscription(data)) {
      writeCachedSubscription(email, data);
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

async function loadSubscription(email: string | null | undefined): Promise<OlkilSubscription | null> {
  if (!email) {
    return null;
  }
  const key = subEmailKey(email);
  const pending = subInflight.get(key);
  if (pending) {
    return pending;
  }
  const promise = fetchSubscription(email).finally(() => {
    subInflight.delete(key);
  });
  subInflight.set(key, promise);
  return promise;
}

function saveSection(id: SettingsSectionId) {
  try {
    window.localStorage.setItem(OLKIL_SETTINGS_SECTION_KEY, id);
  } catch {
    // ignore
  }
}

function Switch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`${styles.switch} ${on ? styles.switchOn : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className={styles.segmented} role="tablist">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={`${styles.segBtn} ${value === opt.id ? styles.segBtnActive : ''}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({
  title,
  desc,
  control,
}: {
  title: string;
  desc?: string;
  control: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <p className={styles.rowTitle}>{title}</p>
        {desc ? <p className={styles.rowDesc}>{desc}</p> : null}
      </div>
      <div className={styles.rowControl}>{control}</div>
    </div>
  );
}

function NavGlyph({ id }: { id: SettingsSectionId }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg className={styles.navIcon} viewBox="0 0 24 24" aria-hidden>
      {id === 'general' && <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6.2 6.2l2.1 2.1M15.7 15.7l2.1 2.1M17.8 6.2l-2.1 2.1M8.3 15.7l-2.1 2.1M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6z" {...common} />}
      {id === 'account' && (
        <>
          <circle cx="12" cy="8" r="3.2" {...common} />
          <path d="M5.5 19.2c1.2-3.1 3.4-4.6 6.5-4.6s5.3 1.5 6.5 4.6" {...common} />
        </>
      )}
      {id === 'plan' && <path d="M4.5 7.5h15v11h-15zM8 7.5V5.8A4 4 0 0 1 12 3.5 4 4 0 0 1 16 5.8v1.7" {...common} />}
      {id === 'agents' && <path d="M12 4.5l2.2 4.4 4.8.7-3.5 3.4.8 4.8L12 15.6 7.7 17.8l.8-4.8-3.5-3.4 4.8-.7z" {...common} />}
      {id === 'models' && <path d="M4.5 8.5h15v9h-15zM8 8.5V6.2A4 4 0 0 1 12 4a4 4 0 0 1 4 2.2v2.3M9 13h6" {...common} />}
      {id === 'rules' && <path d="M6 4.5h9.5L18.5 8v11.5H6zM15.5 4.5V8h3" {...common} />}
      {id === 'mcp' && <path d="M8 7h8M8 12h8M8 17h5M5.5 4.5h13v15h-13z" {...common} />}
      {id === 'indexing' && <path d="M5 19V8.5L12 4.5l7 4V19M9 19v-6h6v6" {...common} />}
      {id === 'git' && <path d="M6 5.5v13M6 12h7.5a3.5 3.5 0 1 0 0-7H12M6 12h6.5a3.5 3.5 0 1 1 0 7H12" {...common} />}
      {id === 'terminal' && <path d="M4.5 6.5h15v11h-15zM7.2 10.2L9.8 12.5 7.2 14.8M12 15.2h4.5" {...common} />}
      {id === 'permissions' && <path d="M12 3.8l7 3.1v5.3c0 4.1-2.8 6.9-7 8.2-4.2-1.3-7-4.1-7-8.2V6.9z" {...common} />}
      {id === 'editor' && <path d="M5 5.5h14v13H5zM8 9h8M8 12.5h6" {...common} />}
      {id === 'privacy' && <path d="M7 11.5V9.2a5 5 0 0 1 10 0v2.3M6 11.5h12v8H6z" {...common} />}
      {id === 'about' && (
        <>
          <circle cx="12" cy="12" r="8" {...common} />
          <path d="M12 10.5V17M12 7.4h.01" {...common} />
        </>
      )}
    </svg>
  );
}

export const OlkilAccountView: ReactEditorComponent<null> = () => {
  const settingsApi = useInjectable<IOlkilSettingsService>(IOlkilSettingsService);
  const [section, setSection] = useState<SettingsSectionId>('account');
  const [query, setQuery] = useState('');
  const [settings, setSettings] = useState<OlkilSettings>(settingsApi.get());

  useEffect(() => {
    setSettings(settingsApi.get());
    const sub = settingsApi.onDidChange((next) => setSettings(next));
    return () => sub.dispose();
  }, [settingsApi]);

  const go = (id: SettingsSectionId) => {
    setSection(id);
    saveSection(id);
  };

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(OLKIL_SETTINGS_SECTION_KEY);
      if (saved && SETTINGS_NAV.some((item) => item.id === saved)) {
        setSection(saved as SettingsSectionId);
      }
    } catch {
      // ignore
    }
    const onSection = (e: Event) => {
      const id = (e as CustomEvent).detail;
      if (typeof id === 'string' && SETTINGS_NAV.some((item) => item.id === id)) {
        go(id as SettingsSectionId);
      }
    };
    window.addEventListener(OLKIL_SETTINGS_SECTION_EVENT, onSection);
    return () => window.removeEventListener(OLKIL_SETTINGS_SECTION_EVENT, onSection);
  }, []);

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return SETTINGS_NAV;
    }
    return SETTINGS_NAV.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q),
    );
  }, [query]);

  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const item of filteredNav) {
      if (!seen.includes(item.group)) {
        seen.push(item.group);
      }
    }
    return seen.map((group) => ({
      group,
      items: filteredNav.filter((item) => item.group === group),
    }));
  }, [filteredNav]);

  useEffect(() => {
    if (filteredNav.length && !filteredNav.some((item) => item.id === section)) {
      go(filteredNav[0].id);
    }
  }, [filteredNav, section]);

  const patch = (partial: Partial<OlkilSettings>) => settingsApi.patch(partial);

  return (
    <div className={styles.shell}>
      <aside className={styles.nav}>
        <div className={styles.navHead}>
          <p className={styles.navKicker}>OLKIL</p>
          <input
            className={styles.search}
            value={query}
            placeholder="Search settings"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className={styles.navList}>
          {groups.length === 0 ? (
            <div className={styles.navEmpty}>No matching settings</div>
          ) : (
            groups.map((group) => (
              <div key={group.group} className={styles.group}>
                <div className={styles.groupLabel}>{group.group}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.navBtn} ${section === item.id ? styles.navBtnActive : ''}`}
                    onClick={() => go(item.id)}
                  >
                    <NavGlyph id={item.id} />
                    {item.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
      <main className={styles.main}>
        {section === 'general' && <GeneralPane settings={settings} patch={patch} />}
        {section === 'account' && <AccountPane />}
        {section === 'plan' && <PlanPane />}
        {section === 'agents' && <AgentsPane settings={settings} patch={patch} />}
        {section === 'models' && <ModelsPane settings={settings} patch={patch} />}
        {section === 'rules' && <RulesPane settings={settings} patch={patch} />}
        {section === 'mcp' && <McpPane settings={settings} patch={patch} />}
        {section === 'indexing' && <IndexingPane settings={settings} patch={patch} />}
        {section === 'git' && <GitPane settings={settings} patch={patch} />}
        {section === 'terminal' && <TerminalPane settings={settings} patch={patch} />}
        {section === 'permissions' && <PermissionsPane settings={settings} patch={patch} />}
        {section === 'editor' && <EditorPane settings={settings} patch={patch} />}
        {section === 'privacy' && <PrivacyPane settings={settings} patch={patch} />}
        {section === 'about' && <AboutPane />}
      </main>
    </div>
  );
};

function GeneralPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const ui = useInjectable<IOlkilChatUiService>(IOlkilChatUiService);

  const setMode = (mode: ChatModeSetting) => {
    patch({ defaultChatMode: mode });
    if (!chat.busy) {
      chat.setChatMode(mode);
    }
  };

  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>General</h1>
      <p className={styles.paneDesc}>Defaults for OLKIL IDE and the agent panel.</p>
      <div className={styles.card}>
        <SettingRow title="Default agent mode" desc="Used for new chats. You can still switch Agent / Plan / Ask per conversation." control={<Segmented
            value={settings.defaultChatMode}
            onChange={setMode}
            options={[
              { id: 'agent', label: 'Agent' },
              { id: 'plan', label: 'Plan' },
              { id: 'ask', label: 'Ask' },
            ]}
          />} />
        <SettingRow title="Open agent on startup" desc="Show the chat panel when OLKIL launches." control={<Switch on={settings.openAgentOnStart} onChange={(openAgentOnStart) => patch({ openAgentOnStart })} />} />
        <SettingRow title="Pin agent panel" desc="Keep chat open when you switch files, instead of folding it into the corner pill." control={<Switch
            on={settings.pinAgentPanel}
            onChange={(pinAgentPanel) => ui.setPinned(pinAgentPanel)}
          />} />
      </div>
    </div>
  );
}

function AccountPane() {
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const commands = useInjectable<CommandService>(CommandService);
  const [user, setUser] = useState<OlkilAuthUser | null>(auth.getUser());
  const [busy, setBusy] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const { sub, loading: subLoading } = useOlkilSubscription(user?.email);

  useEffect(() => {
    setUser(auth.getUser());
    setPhotoFailed(false);
    const subChange = auth.onDidChangeSession((session) => {
      setUser(session?.user ?? null);
      setPhotoFailed(false);
    });
    return () => subChange.dispose();
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
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Account</h1>
      <p className={styles.paneDesc}>Sign in with Google via olkil.com — same plan and credits as the website.</p>
      <div className={styles.banner}>
        Manage your OLKIL account for the IDE. Profile, session, and plan stay in sync with olkil.com.
      </div>
      <div className={styles.card}>
        {user ? (
          <>
            <div className={styles.identityRow}>
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
                  <span className={styles.planBadge}>
                    {sub?.plan_name || (subLoading ? 'Loading' : 'Dazzlone')}
                  </span>
                </div>
                <div className={styles.email}>{user.email || 'No email on account'}</div>
              </div>
            </div>
            <div className={styles.block}>
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
            </div>
          </>
        ) : (
          <div className={styles.block}>
            <div className={styles.identityRow}>
              <div className={styles.avatarFallback} aria-hidden>
                ?
              </div>
              <div className={styles.identity}>
                <div className={styles.name}>Not signed in</div>
                <div className={styles.email}>Sign in with Google to sync your OLKIL plan and credits</div>
              </div>
            </div>
            <div className={styles.actions}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={onSignIn}>
                {busy ? 'Opening browser…' : 'Sign in with Google'}
              </button>
            </div>
            <p className={styles.hint}>A browser window will open on olkil.com. After you finish, this tab updates automatically.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PlanPane() {
  const auth = useInjectable<IOlkilAuthService>(IOlkilAuthService);
  const [user, setUser] = useState<OlkilAuthUser | null>(auth.getUser());
  const { sub, loading: subLoading } = useOlkilSubscription(user?.email);

  useEffect(() => {
    setUser(auth.getUser());
    const change = auth.onDidChangeSession((session) => setUser(session?.user ?? null));
    return () => change.dispose();
  }, [auth]);

  const waitingForPlan = Boolean(user) && !sub && subLoading;
  const pctLeft = sub?.percent_left ?? (waitingForPlan ? 0 : 100);

  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Plan & usage</h1>
      <p className={styles.paneDesc}>Credits, billing window, and upgrades for the signed-in OLKIL account.</p>
      <div className={styles.card}>
        {!user ? (
          <div className={styles.block}>
            <p className={styles.rowTitle}>Sign in to see usage</p>
            <p className={styles.rowDesc}>Plan and token remaining are tied to your olkil.com account.</p>
          </div>
        ) : (
          <div className={styles.planCard}>
            <div className={styles.planCardTop}>
              <span>Credits remaining</span>
              <strong>
                {waitingForPlan
                  ? 'Loading…'
                  : sub?.is_paid
                    ? `${sub.percent_left_label || `${pctLeft}%`} left`
                    : 'Local · unlimited'}
              </strong>
            </div>
            <div className={`${styles.bar} ${waitingForPlan ? styles.barLoading : ''}`}>
              <span style={{ width: `${Math.max(0, Math.min(100, pctLeft))}%` }} />
            </div>
            <p className={styles.planHint}>
              {waitingForPlan
                ? 'Loading your plan…'
                : sub?.is_paid
                  ? `${sub.tokens_left_label || '0'} remaining of ${sub.tokens_total_label || '0'} · ${sub.tokens_used_label || '0'} used`
                  : 'Free Dazzlone — local models, no cloud token cap'}
            </p>
            {sub?.is_paid && sub.drawing_plan && sub.drawing_plan !== sub.plan ? (
              <p className={styles.planHint}>
                {sub.plan_name} tokens are used up for this window. Cloud requests now use held{' '}
                {sub.drawing_plan_name || 'plan'}.
              </p>
            ) : null}
            {sub?.held_plans && sub.held_plans.length > 0 ? (
              <p className={styles.planHint}>
                On hold:{' '}
                {sub.held_plans
                  .map((held) => `${held.plan_name} ${held.tokens_left_label || '0'} left until ${held.expires_on || 'expiry'}`)
                  .join(' · ')}
              </p>
            ) : null}
            {sub?.is_paid &&
            (sub.quota_reason === 'quota_exceeded' || ((sub.spendable_left ?? 0) <= 0 && pctLeft <= 0)) ? (
              <p className={styles.planHint}>
                This period’s tokens are used up.{' '}
                <a
                  className={styles.link}
                  href={sub.renew_url || `https://olkil.com/checkout/?plan=${encodeURIComponent(sub.plan || 'lite')}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Buy {sub.plan_name || 'Lite'} again
                </a>
                {sub.next_plan_name ? (
                  <>
                    {' '}
                    or{' '}
                    <a className={styles.link} href={sub.upgrade_url || 'https://olkil.com/pricing/'} target="_blank" rel="noreferrer">
                      upgrade to {sub.next_plan_name}
                    </a>
                  </>
                ) : null}
                . Dazzlone stays free.
              </p>
            ) : null}
            <div className={styles.meta}>
              <div className={styles.metaLabel}>Plan</div>
              <div className={styles.metaValue}>{sub?.plan_name || (waitingForPlan ? 'Loading…' : 'Dazzlone')}</div>
              <div className={styles.metaLabel}>Expires</div>
              <div className={styles.metaValue}>
                {sub?.expires_label || (waitingForPlan ? '—' : 'Never (free local)')}
              </div>
            </div>
            <div className={styles.actions}>
              <a className={`${styles.btn} ${styles.btnGhost}`} href="https://olkil.com/pricing/" target="_blank" rel="noreferrer">
                View plans
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentsPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Agents</h1>
      <p className={styles.paneDesc}>How the coding agent plans, edits, and continues a run.</p>
      <div className={styles.card}>
        <SettingRow title="Default mode" desc="Agent implements. Plan explores first. Ask is read-only." control={<Segmented
            value={settings.defaultChatMode}
            onChange={(defaultChatMode) => {
              patch({ defaultChatMode });
              if (!chat.busy) {
                chat.setChatMode(defaultChatMode);
              }
            }}
            options={[
              { id: 'agent', label: 'Agent' },
              { id: 'plan', label: 'Plan' },
              { id: 'ask', label: 'Ask' },
            ]}
          />} />
        <SettingRow title="Auto-apply file edits" desc="When off, review Accept / Revert on each change card (recommended)." control={<Switch on={settings.autoApplyFileEdits} onChange={(autoApplyFileEdits) => patch({ autoApplyFileEdits })} />} />
        <SettingRow title="Continue after tool errors" desc="Let the agent retry when a command or edit fails, instead of stopping immediately." control={<Switch on={settings.continueOnError} onChange={(continueOnError) => patch({ continueOnError })} />} />
      </div>
    </div>
  );
}

function ModelsPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  const catalogIds = AI_MODELS.map((model) => model.id);
  const enabledCount = AI_MODELS.filter((model) => isModelEnabledInSettings(settings, model.id)).length;
  const chat = useInjectable<IOlkilChatService>(IOlkilChatService);
  const commands = useInjectable<CommandService>(CommandService);
  const [locked, setLocked] = useState(chat.deepseekLocked);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    const sub = chat.onDidChange(() => setLocked(chat.deepseekLocked));
    return () => sub.dispose();
  }, [chat]);

  const openPlan = () => {
    rememberOlkilSettingsSection('plan');
    void commands.executeCommand(OLKIL_AUTH_OPEN_ACCOUNT.id, 'plan');
  };

  const setVisible = (modelId: string, enabled: boolean) => {
    if (!enabled && enabledCount <= 1 && isModelEnabledInSettings(settings, modelId)) {
      return;
    }
    patch(toggleEnabledModelId(settings, modelId, enabled, catalogIds));
  };

  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Models</h1>
      <p className={styles.paneDesc}>
        Toggle which models appear in the chat dropdown. At least one model must stay on.
      </p>
      <div className={styles.card}>
        <div className={styles.modelList}>
          {AI_MODELS.map((model) => {
            const on = isModelEnabledInSettings(settings, model.id);
            const modelLocked = locked && isDeepSeekProvider(model.provider);
            return (
              <div
                key={model.id}
                className={`${styles.modelItem} ${on ? '' : styles.modelItemOff} ${
                  modelLocked ? styles.modelItemLocked : ''
                }`}
                onMouseEnter={() => modelLocked && setHoverId(model.id)}
                onMouseLeave={() => setHoverId((id) => (id === model.id ? null : id))}
                title={modelLocked ? 'Upgrade the plan' : undefined}
              >
                <div>
                  <div className={styles.modelName}>
                    {isDeepSeekProvider(model.provider) ? (
                      <DeepSeekIcon className={styles.modelProviderIcon} />
                    ) : null}
                    {model.displayName || model.label}
                    {model.badge ? ` · ${model.badge}` : ''}
                  </div>
                  <div className={styles.modelSub}>
                    {modelLocked
                      ? 'Locked — 50,000 free tokens used up'
                      : on
                        ? 'Shown in chat dropdown'
                        : 'Hidden from chat dropdown'}
                  </div>
                  {modelLocked && hoverId === model.id ? (
                    <div className={styles.modelLockTip}>
                      <span>Upgrade the plan</span>
                      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={openPlan}>
                        Open Plan
                      </button>
                    </div>
                  ) : null}
                </div>
                <Switch on={on} onChange={(next) => setVisible(model.id, next)} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RulesPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Rules</h1>
      <p className={styles.paneDesc}>
        User rules are always included in the agent prompt. Project rules still load from AGENTS.md, .cursorrules, and
        .olkil/rules.
      </p>
      <div className={styles.card}>
        <div className={styles.block}>
          <label className={styles.label}>User rules</label>
          <textarea
            className={styles.textarea}
            value={settings.userRules}
            placeholder="Always use TypeScript. Prefer small diffs. Don't add comments unless asked."
            onChange={(e) => patch({ userRules: e.target.value })}
          />
          <p className={styles.hint}>These apply across workspaces. Keep them short — they use context on every turn.</p>
        </div>
      </div>
    </div>
  );
}

function McpPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  const aiNode = useInjectable<IOlkilAiNodeService>(OlkilAiNodeServicePath);
  const workspace = useInjectable<IWorkspaceService>(IWorkspaceService);
  const [name, setName] = useState('');
  const [type, setType] = useState<'local' | 'remote'>('local');
  const [command, setCommand] = useState('npx -y @modelcontextprotocol/server-github');
  const [url, setUrl] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredMcpServer[]>([]);
  const [loading, setLoading] = useState(true);

  const workspaceRoot = (() => {
    try {
      const roots = workspace.tryGetRoots?.() || [];
      const first = roots[0]?.uri;
      if (first) {
        return new URI(first).codeUri.fsPath;
      }
      if (workspace.workspace?.uri) {
        return new URI(workspace.workspace.uri).codeUri.fsPath;
      }
    } catch {
      // ignore
    }
    return '';
  })();

  const refreshDiscovered = async () => {
    setLoading(true);
    try {
      const next = await aiNode.listDiscoveredMcpServers(workspaceRoot || undefined);
      setDiscovered(next || []);
    } catch {
      setDiscovered([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshDiscovered();
  }, [workspaceRoot]);

  const addServer = () => {
    const trimmed = name.trim() || (type === 'local' ? 'local-mcp' : 'remote-mcp');
    const server: OlkilMcpServer = {
      id: newMcpServerId(),
      name: trimmed,
      enabled: true,
      type,
      command: type === 'local' ? command.trim() : undefined,
      url: type === 'remote' ? url.trim() : undefined,
    };
    patch({ mcpServers: [...settings.mcpServers, server] });
    setName('');
  };

  const update = (id: string, partial: Partial<OlkilMcpServer>) => {
    patch({
      mcpServers: settings.mcpServers.map((server) => (server.id === id ? { ...server, ...partial } : server)),
    });
  };

  const setDiscoveredEnabled = (id: string, enabled: boolean) => {
    const current = settings.mcpDiscoveredDisabled || [];
    const next = enabled ? current.filter((item) => item !== id) : Array.from(new Set([...current, id]));
    patch({ mcpDiscoveredDisabled: next });
  };

  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>MCP</h1>
      <p className={styles.paneDesc}>
        Model Context Protocol servers give the agent extra tools. Servers you connect through an extension (Hostinger,
        GitHub, and others) show up here automatically. Tokens stay in the original config and are not shown.
      </p>

      <div className={styles.card}>
        <div className={styles.block}>
          <div className={styles.mcpHead}>
            <div>
              <p className={styles.rowTitle}>From extensions &amp; editors</p>
              <p className={styles.rowDesc}>
                Shown for reference from Cursor, VS Code, and this workspace. Add a server below to use it in OLKIL
                chat — wiring every extension MCP into the agent floods context.
              </p>
            </div>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => void refreshDiscovered()}>
              {loading ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
        </div>
        {discovered.length === 0 ? (
          <div className={styles.block}>
            <p className={styles.rowDesc}>
              {loading
                ? 'Looking for connected MCP servers…'
                : 'No extension MCP servers found yet. Connect Hostinger (or another MCP) in Cursor / the extension, then Refresh.'}
            </p>
          </div>
        ) : (
          <div className={styles.mcpList}>
            {discovered.map((server) => {
              const on = !(settings.mcpDiscoveredDisabled || []).includes(server.id) && !server.fileDisabled;
              const badge =
                server.sourceKind === 'extension'
                  ? `${server.source} extension`
                  : server.source;
              return (
                <div key={server.id} className={styles.mcpItem}>
                  <div>
                    <div className={styles.mcpNameRow}>
                      <span className={styles.mcpName}>{server.name}</span>
                      <span className={styles.mcpBadge}>{badge}</span>
                    </div>
                    <div className={styles.mcpMeta}>
                      {server.type === 'local' ? server.command || 'Local stdio' : server.url || 'Remote'}
                      {server.hasAuth ? ' · authenticated' : ''}
                    </div>
                  </div>
                  <div className={styles.mcpActions}>
                    <Switch on={on} onChange={(enabled) => setDiscoveredEnabled(server.id, enabled)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.block}>
          <p className={styles.rowTitle}>Added in OLKIL</p>
          <p className={styles.rowDesc}>Manual stdio or remote MCP endpoints for this IDE only.</p>
        </div>
        <div className={styles.formGrid}>
          <div>
            <label className={styles.label}>Name</label>
            <input className={styles.input} value={name} placeholder="github" onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={styles.label}>Type</label>
            <select className={styles.select} value={type} onChange={(e) => setType(e.target.value as 'local' | 'remote')}>
              <option value="local">Local command</option>
              <option value="remote">Remote URL</option>
            </select>
          </div>
          <div className={styles.formGridFull}>
            <label className={styles.label}>{type === 'local' ? 'Command' : 'URL'}</label>
            {type === 'local' ? (
              <input className={styles.input} value={command} onChange={(e) => setCommand(e.target.value)} />
            ) : (
              <input className={styles.input} value={url} placeholder="https://mcp.example.com/sse" onChange={(e) => setUrl(e.target.value)} />
            )}
          </div>
          <div className={styles.formGridFull}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={addServer}>
              Add MCP server
            </button>
          </div>
        </div>
        {settings.mcpServers.length === 0 ? (
          <div className={styles.block}>
            <p className={styles.rowDesc}>No manual MCP servers yet.</p>
          </div>
        ) : (
          <div className={styles.mcpList}>
            {settings.mcpServers.map((server) => (
              <div key={server.id} className={styles.mcpItem}>
                <div>
                  <div className={styles.mcpName}>{server.name}</div>
                  <div className={styles.mcpMeta}>
                    {server.type === 'local' ? server.command || 'No command' : server.url || 'No URL'}
                  </div>
                </div>
                <div className={styles.mcpActions}>
                  <Switch on={server.enabled} onChange={(enabled) => update(server.id, { enabled })} />
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => patch({ mcpServers: settings.mcpServers.filter((item) => item.id !== server.id) })}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IndexingPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Indexing</h1>
      <p className={styles.paneDesc}>Codebase search and ignore rules the agent uses when exploring a folder.</p>
      <div className={styles.card}>
        <SettingRow title="Index this workspace" desc="Lets the agent search symbols and files faster on large projects." control={<Switch on={settings.indexCodebase} onChange={(indexCodebase) => patch({ indexCodebase })} />} />
        <div className={styles.block}>
          <label className={styles.label}>Ignore patterns</label>
          <textarea
            className={styles.textarea}
            value={settings.indexIgnore}
            onChange={(e) => patch({ indexIgnore: e.target.value })}
          />
          <p className={styles.hint}>One glob or folder name per line. node_modules and .git are ignored by default.</p>
        </div>
      </div>
    </div>
  );
}

function GitPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Git & PRs</h1>
      <p className={styles.paneDesc}>What the agent is allowed to do with git, remotes, and pull requests.</p>
      <div className={styles.card}>
        <SettingRow title="Allow commits" desc="Agent may run git commit when you ask it to save work." control={<Switch on={settings.gitAllowCommit} onChange={(gitAllowCommit) => patch({ gitAllowCommit })} />} />
        <SettingRow title="Allow push" desc="Agent may git push. Keep off unless you want remote updates from chat." control={<Switch on={settings.gitAllowPush} onChange={(gitAllowPush) => patch({ gitAllowPush })} />} />
        <SettingRow title="Allow pull requests" desc="Agent may open a PR (gh / glab) when you ask." control={<Switch on={settings.gitAllowPr} onChange={(gitAllowPr) => patch({ gitAllowPr })} />} />
        <SettingRow title="Commit message style" desc="Conventional Commits (feat/fix/chore) or a plain sentence." control={<select
            className={styles.select}
            value={settings.gitCommitStyle}
            onChange={(e) => patch({ gitCommitStyle: e.target.value as OlkilSettings['gitCommitStyle'] })}
          >
            <option value="conventional">Conventional</option>
            <option value="plain">Plain</option>
          </select>} />
        <SettingRow title="Default branch" desc="Used when the agent creates branches or PRs." control={<input
            className={styles.input}
            style={{ width: 168 }}
            value={settings.gitDefaultBranch}
            onChange={(e) => patch({ gitDefaultBranch: e.target.value })}
          />} />
      </div>
    </div>
  );
}

function TerminalPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Terminal</h1>
      <p className={styles.paneDesc}>
        Auto-run controls whether the agent can execute shell commands during a turn without asking. Allowlist is the
        safer default for unknown commands.
      </p>
      <div className={styles.card}>
        <SettingRow title="Auto-run commands"
          desc="Always runs every command. Allowlist runs matching prefixes only. Never blocks shell until you change this." control={<Segmented
            value={settings.terminalAutoRun}
            onChange={(terminalAutoRun) => patch({ terminalAutoRun })}
            options={[
              { id: 'always', label: 'Always' },
              { id: 'allowlist', label: 'Allowlist' },
              { id: 'never', label: 'Never' },
            ]}
          />} />
        <div className={styles.block}>
          <label className={styles.label}>Command allowlist</label>
          <textarea
            className={styles.textarea}
            value={settings.terminalAllowlist.join('\n')}
            onChange={(e) =>
              patch({
                terminalAllowlist: e.target.value
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className={styles.hint}>
            One prefix per line. Example: <code>git status</code> allows that command and anything starting with it.
          </p>
        </div>
      </div>
    </div>
  );
}

function PermissionsPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Permissions</h1>
      <p className={styles.paneDesc}>What the agent may do without extra confirmation while a run is in progress.</p>
      <div className={styles.card}>
        <SettingRow title="Auto-approve file edits" desc="Allow the engine to write workspace files. Chat still shows Accept / Revert cards." control={<Switch on={settings.autoApproveEdits} onChange={(autoApproveEdits) => patch({ autoApproveEdits })} />} />
        <SettingRow title="Allow web fetch" desc="Agent may request public URLs for docs and APIs." control={<Switch on={settings.autoApproveWeb} onChange={(autoApproveWeb) => patch({ autoApproveWeb })} />} />
        <SettingRow title="Block files outside the workspace" desc="Deny reads/writes above the opened folder (recommended)." control={<Switch on={settings.denyExternalDirectory} onChange={(denyExternalDirectory) => patch({ denyExternalDirectory })} />} />
      </div>
    </div>
  );
}

function EditorPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Editor</h1>
      <p className={styles.paneDesc}>Core editor behavior — the same keys used by VS Code / OpenSumi preferences.</p>
      <div className={styles.card}>
        <SettingRow title="Font size" desc="Editor font size in pixels." control={<input
            className={`${styles.input} ${styles.number}`}
            type="number"
            min={10}
            max={24}
            value={settings.editorFontSize}
            onChange={(e) => patch({ editorFontSize: Number(e.target.value) })}
          />} />
        <SettingRow title="Tab size" desc="Spaces per indent." control={<input
            className={`${styles.input} ${styles.number}`}
            type="number"
            min={1}
            max={8}
            value={settings.editorTabSize}
            onChange={(e) => patch({ editorTabSize: Number(e.target.value) })}
          />} />
        <SettingRow title="Word wrap" desc="Wrap long lines in the editor." control={<Segmented
            value={settings.editorWordWrap}
            onChange={(editorWordWrap) => patch({ editorWordWrap })}
            options={[
              { id: 'off', label: 'Off' },
              { id: 'on', label: 'On' },
            ]}
          />} />
        <SettingRow title="Minimap" desc="Show the code overview gutter." control={<Switch on={settings.editorMinimap} onChange={(editorMinimap) => patch({ editorMinimap })} />} />
        <SettingRow title="Format on save" desc="Run the formatter when a file is saved." control={<Switch on={settings.editorFormatOnSave} onChange={(editorFormatOnSave) => patch({ editorFormatOnSave })} />} />
      </div>
    </div>
  );
}

function PrivacyPane({
  settings,
  patch,
}: {
  settings: OlkilSettings;
  patch: (partial: Partial<OlkilSettings>) => void;
}) {
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>Privacy</h1>
      <p className={styles.paneDesc}>What stays on this machine versus what is sent with agent requests.</p>
      <div className={styles.card}>
        <SettingRow title="Keep chat history" desc="Signed-in chats sync up to 3 conversations for 48 hours." control={<Switch on={settings.keepChatHistory} onChange={(keepChatHistory) => patch({ keepChatHistory })} />} />
        <SettingRow title="Include dotfiles in context" desc="Allow the agent to read files like .env when they are in the workspace." control={<Switch on={settings.includeDotfiles} onChange={(includeDotfiles) => patch({ includeDotfiles })} />} />
        <SettingRow title="Share anonymous usage" desc="Off by default. OLKIL does not send extra product telemetry unless you enable this." control={<Switch on={settings.shareUsageData} onChange={(shareUsageData) => patch({ shareUsageData })} />} />
      </div>
      <div className={styles.privacyLegal}>
        <p>
          We respect your privacy. Your project and account data are handled securely and used only to provide the
          services you request. We do not sell your personal data or use your project data for unrelated purposes.
        </p>
        <h2>AI &amp; Technology</h2>
        <p>
          OLKIL combines advanced LLMs with our own AI orchestration, RAG, context optimization, and
          project-understanding technology to provide fast, relevant coding assistance. We also use the OpenCode CLI as
          part of our coding-agent infrastructure and appreciate its open-source contributors.
        </p>
        <h2>Payments</h2>
        <p>
          Payments are securely processed through our trusted payment gateway. OLKIL does not store your complete card
          details.
        </p>
      </div>
    </div>
  );
}

function AboutPane() {
  const settingsApi = useInjectable<IOlkilSettingsService>(IOlkilSettingsService);
  return (
    <div className={styles.pane}>
      <h1 className={styles.paneTitle}>About</h1>
      <p className={styles.paneDesc}>OLKIL IDE — coding agent, editor, and your olkil.com account in one app.</p>
      <div className={styles.card}>
        <div className={styles.identityRow}>
          <img className={styles.aboutLogo} src={logoUrl} alt="" />
          <div>
            <div className={styles.name}>OLKIL</div>
            <div className={styles.email}>Desktop IDE</div>
          </div>
        </div>
        <div className={styles.block}>
          <div className={styles.kv}>
            <div className={styles.muted}>Product</div>
            <div>OLKIL</div>
            <div className={styles.muted}>Website</div>
            <div>
              <a className={styles.link} href="https://olkil.com" target="_blank" rel="noreferrer">
                olkil.com
              </a>
            </div>
            <div className={styles.muted}>Pricing</div>
            <div>
              <a className={styles.link} href="https://olkil.com/pricing/" target="_blank" rel="noreferrer">
                olkil.com/pricing
              </a>
            </div>
          </div>
          <div className={styles.actions}>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => settingsApi.reset()}>
              Restore default settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useOlkilSubscription(email: string | null | undefined): { sub: OlkilSubscription | null; loading: boolean } {
  const [sub, setSub] = useState<OlkilSubscription | null>(() => readCachedSubscription(email));
  const [loading, setLoading] = useState(() => Boolean(email) && !readCachedSubscription(email));

  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setSub(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const cached = readCachedSubscription(email);
    if (cached) {
      setSub(cached);
      setLoading(false);
    } else {
      setSub(null);
      setLoading(true);
    }

    const apply = (next: OlkilSubscription | null) => {
      if (cancelled) {
        return;
      }
      if (next) {
        setSub(next);
      }
      setLoading(false);
    };

    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      apply(await loadSubscription(email));
    };
    void load();

    const timer = window.setInterval(() => {
      void load();
    }, 4000);
    const onShow = () => {
      void load();
    };
    const onWallet = () => {
      void loadSubscription(email).then(apply);
    };
    window.addEventListener('focus', onShow);
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('olkil-wallet-updated', onWallet);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onShow);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('olkil-wallet-updated', onWallet);
    };
  }, [email]);

  return { sub, loading };
}
