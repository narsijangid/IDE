import React, { useEffect, useMemo, useRef } from 'react';
import { useInjectable } from '@opensumi/ide-core-browser';
import { ReactEditorComponent } from '@opensumi/ide-editor/lib/browser';
import { IOlkilVirtualOfficeService } from '../common/virtual-office';
import styles from './virtual-office.view.module.less';

/** Must match `.stage` / `.frame` in virtual-office.view.module.less */
const OFFICE_DESIGN_W = 900;
const OFFICE_DESIGN_H = 540;
const OFFICE_FIT_PAD = 16;
/** Keep a little margin so the office never fills the whole tab. */
const OFFICE_MAX_SCALE = 0.65;

/**
 * Loads VertualOffice/vertualoffice.html in an iframe.
 * Cache-busts so edits to the HTML show after rebuild without stale browser cache.
 * Scales the office down so the full scene stays visible (including with chat open).
 */
export const OlkilVirtualOfficeView: ReactEditorComponent<null> = () => {
  const office = useInjectable<IOlkilVirtualOfficeService>(IOlkilVirtualOfficeService);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    office.enter();
    return () => {
      office.bindFrame(null);
    };
  }, [office]);

  useEffect(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) {
      return;
    }

    const fit = () => {
      const scale = Math.min(
        (host.clientWidth - OFFICE_FIT_PAD) / OFFICE_DESIGN_W,
        (host.clientHeight - OFFICE_FIT_PAD) / OFFICE_DESIGN_H,
        OFFICE_MAX_SCALE,
      );
      stage.style.transform = `scale(${Math.max(scale, 0.38)})`;
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const onLoad = () => {
    const win = iframeRef.current?.contentWindow || null;
    office.bindFrame(win);
  };

  // Bust cache whenever this tab mounts (after `build:browser` copies fresh HTML)
  const src = useMemo(() => `./vertualoffice.html?embed=1&t=${Date.now()}`, []);

  return (
    <div className={styles.host} ref={hostRef}>
      <div className={styles.stage} ref={stageRef}>
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
    </div>
  );
};
