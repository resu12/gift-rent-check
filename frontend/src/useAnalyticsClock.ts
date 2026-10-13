import { useEffect, useState } from 'react';
import { watchAnalyticsClock } from './data/analyticsClock';

export function useAnalyticsClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => watchAnalyticsClock(setNow, {
    now: Date.now,
    visible: () => document.visibilityState === 'visible',
    onVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
    onFocus: callback => { window.addEventListener('focus', callback); return () => window.removeEventListener('focus', callback); },
    everyMinute: callback => { const timer = window.setInterval(callback, 60_000); return () => window.clearInterval(timer); },
  }), []);
  return [now, setNow] as const;
}
