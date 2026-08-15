import React, { useEffect, useMemo, useRef } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { ReactEditorComponent } from '@opensumi/ide-editor/lib/browser';
import { IOlkilVirtualOfficeService } from '../common/virtual-office';
import styles from './virtual-office.view.module.less';

/**
 * Loads VertualOffice/vertualoffice.html in an iframe.
 * Cache-busts so edits to the HTML show after rebuild without stale browser cache.
 */
export const OlkilVirtualOfficeView: ReactEditorComponent<null> = () => {
  const office = useInjectable<IOlkilVirtualOfficeService>(IOlkilVirtualOfficeService);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    office.enter();
    return () => {
      office.bindFrame(null);
    };
  }, [office]);

  const onLoad = () => {
    const win = iframeRef.current?.contentWindow || null;
    office.bindFrame(win);
  };

  // Bust cache whenever this tab mounts (after `build:browser` copies fresh HTML)
  const src = useMemo(() => `./vertualoffice.html?embed=1&t=${Date.now()}`, []);

  return (
    <div className={styles.host}>
      <iframe
        ref={iframeRef}
        className={styles.frame}
        title="Virtual Office"
        src={src}
        onLoad={onLoad}
        sandbox="allow-scripts allow-same-origin"
        scrolling="no"
      />
    </div>
  );
};
