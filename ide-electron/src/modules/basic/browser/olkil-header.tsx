import React from 'react';
import logoUrl from '../../../browser/assets/olkil-logo.png';
import styles from './olkil-header.module.less';

/** Renders inside menubar, immediately before the OLKIL app menu label. */
export const OlkilMenuBarLogo = () => (
  <div className={styles.appLogo} title="OLKIL">
    <img src={logoUrl} alt="OLKIL" width={18} height={18} draggable={false} />
  </div>
);
