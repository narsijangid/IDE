import { Autowired, Injectable } from '@opensumi/di';
import { Emitter, Event, URI } from '@opensumi/ide-core-common';
import { IElectronMainUIService } from '@opensumi/ide-core-common/lib/electron';
import {
  buildIdeAuthUrl,
  createAuthState,
  IOlkilAuthNodeService,
  IOlkilAuthService,
  OlkilAuthNodeServicePath,
  OlkilAuthSession,
  OlkilAuthUser,
  sessionFromTokens,
} from '../common';

const REFRESH_SKEW_MS = 60_000;

@Injectable()
export class OlkilAuthService implements IOlkilAuthService {
  @Autowired(OlkilAuthNodeServicePath)
  private readonly authNode!: IOlkilAuthNodeService;

  @Autowired(IElectronMainUIService)
  private readonly electronUi!: IElectronMainUIService;

  private session: OlkilAuthSession | null = null;
  private readonly onDidChangeSessionEmitter = new Emitter<OlkilAuthSession | null>();
  readonly onDidChangeSessionEvent: Event<OlkilAuthSession | null> = this.onDidChangeSessionEmitter.event;
  private bootstrapped = false;
  private signInFlight: Promise<OlkilAuthSession> | null = null;
  private signInGen = 0;

  async init(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    this.bootstrapped = true;
    try {
      const stored = await this.authNode.loadSession();
      if (stored?.refreshToken) {
        this.session = stored;
        void this.getValidIdToken().catch(() => undefined);
      }
    } catch {
      this.session = null;
    }
    this.onDidChangeSessionEmitter.fire(this.session);
  }

  getSession(): OlkilAuthSession | null {
    return this.session;
  }

  getUser(): OlkilAuthUser | null {
    return this.session?.user ?? null;
  }

  isSignedIn(): boolean {
    return Boolean(this.session?.refreshToken);
  }

  onDidChangeSession(listener: (session: OlkilAuthSession | null) => void): { dispose: () => void } {
    return this.onDidChangeSessionEvent(listener);
  }

  /**
   * Start (or restart) browser login.
   * A second click cancels the previous incomplete flow so we never stick on
   * "Opening browser…" after the user abandons Google sign-in.
   */
  async signIn(): Promise<OlkilAuthSession> {
    await this.cancelPendingSignIn();
    const gen = ++this.signInGen;
    const flight = this.runSignIn(gen);
    this.signInFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.signInFlight === flight) {
        this.signInFlight = null;
      }
    }
  }

  private async cancelPendingSignIn(): Promise<void> {
    try {
      await this.authNode.cancelLoginFlow();
    } catch {
      // ignore
    }
    this.signInFlight = null;
  }

  private async runSignIn(gen: number): Promise<OlkilAuthSession> {
    await this.init();
    const state = createAuthState();
    const { redirectUri } = await this.authNode.beginLoginFlow(state);
    if (gen !== this.signInGen) {
      throw new Error('Login cancelled');
    }
    const authUrl = buildIdeAuthUrl({ state, redirectUri });

    this.electronUi.openExternal(authUrl);

    const callback = await this.authNode.waitForCallback(state);
    if (gen !== this.signInGen) {
      throw new Error('Login cancelled');
    }
    const session = sessionFromTokens(callback.idToken, callback.refreshToken);
    if (!session) {
      throw new Error('Could not parse account from Firebase token');
    }

    await this.authNode.saveSession(session);
    this.session = session;
    this.onDidChangeSessionEmitter.fire(session);
    return session;
  }

  async signOut(): Promise<void> {
    await this.cancelPendingSignIn();
    await this.authNode.clearSession();
    this.session = null;
    this.onDidChangeSessionEmitter.fire(null);
  }

  async getValidIdToken(): Promise<string | null> {
    await this.init();
    if (!this.session?.refreshToken) {
      return null;
    }
    const stillFresh = this.session.expiresAt - Date.now() > REFRESH_SKEW_MS;
    if (stillFresh && this.session.idToken) {
      return this.session.idToken;
    }
    try {
      const refreshed = await this.authNode.refreshIdToken(this.session.refreshToken);
      const next = sessionFromTokens(refreshed.idToken, this.session.refreshToken, Date.now());
      if (!next) {
        return this.session.idToken;
      }
      next.user = {
        ...this.session.user,
        ...next.user,
        email: next.user.email || this.session.user.email,
        displayName: next.user.displayName || this.session.user.displayName,
        photoURL: next.user.photoURL || this.session.user.photoURL,
      };
      this.session = next;
      await this.authNode.saveSession(next);
      this.onDidChangeSessionEmitter.fire(next);
      return next.idToken;
    } catch {
      await this.signOut();
      return null;
    }
  }

  /** Handle deep-link fallback: olkil://auth/callback?... */
  async handleDeepLink(rawUrl: string): Promise<boolean> {
    try {
      const uri = new URI(rawUrl);
      if (uri.scheme !== 'olkil') {
        return false;
      }
      // Focus/done ping from success page — not a token callback
      if (/auth\/done/i.test(rawUrl)) {
        return false;
      }
      const path = (uri.path.toString() || '').replace(/^\//, '');
      if (!path.startsWith('auth/callback') && uri.authority !== 'auth') {
        if (!rawUrl.includes('auth/callback')) {
          return false;
        }
      }
      const qIndex = rawUrl.indexOf('?');
      if (qIndex < 0) {
        return false;
      }
      const params = new URLSearchParams(rawUrl.slice(qIndex + 1).split('#')[0]);
      const state = params.get('state') || '';
      const idToken = params.get('id_token') || params.get('idToken') || '';
      const refreshToken = params.get('refresh_token') || params.get('refreshToken') || '';
      if (!state || !idToken || !refreshToken) {
        return false;
      }
      const session = sessionFromTokens(idToken, refreshToken);
      if (!session) {
        return false;
      }
      await this.cancelPendingSignIn();
      await this.authNode.saveSession(session);
      this.session = session;
      this.onDidChangeSessionEmitter.fire(session);
      return true;
    } catch {
      return false;
    }
  }
}
