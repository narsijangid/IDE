import React from 'react';
import deepseekIconUrl from './deepseek-icon.gif';

export function DeepSeekIcon({ className }: { className?: string }) {
  return <img src={deepseekIconUrl} className={className} alt="" aria-hidden />;
}

export function isDeepSeekProvider(provider?: string): boolean {
  return (provider || '').toLowerCase() === 'deepseek';
}
