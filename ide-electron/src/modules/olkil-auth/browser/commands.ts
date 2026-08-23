import { OLKIL_SETTINGS_SECTION_KEY } from '../common/settings';

export const OLKIL_AUTH_SIGN_IN = {
  id: 'olkil.auth.signIn',
  label: 'Sign in to OLKIL…',
};

export const OLKIL_AUTH_SIGN_OUT = {
  id: 'olkil.auth.signOut',
  label: 'Sign out of OLKIL',
};

export const OLKIL_AUTH_OPEN_ACCOUNT = {
  id: 'olkil.auth.openAccount',
  label: 'OLKIL Settings…',
};

export const OLKIL_SETTINGS_SECTION_EVENT = 'olkil-settings-section';

export function rememberOlkilSettingsSection(section: string) {
  try {
    window.localStorage.setItem(OLKIL_SETTINGS_SECTION_KEY, section);
    window.dispatchEvent(new CustomEvent(OLKIL_SETTINGS_SECTION_EVENT, { detail: section }));
  } catch {
    // renderer-only
  }
}
