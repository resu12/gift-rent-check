import { useEffect, useRef, useState, type RefObject } from 'react';
import { Icon } from './Icons';
import { createPullToRefresh, type PullPoint, type PullRefreshState } from './data/pullToRefresh';
import { telegramBridge } from './data/telegram';
import './pullToRefresh.css';

const idle: PullRefreshState = { phase: 'idle', distance: 0 };
const points = (touches: TouchList): PullPoint[] => Array.from(touches, touch => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));
const modalOpen = () => Boolean(document.querySelector('dialog[open], [aria-modal="true"]'));
const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 1;

function excludedTarget(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element) || !root.contains(target)) return true;
  if (target.closest('button, a, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="slider"], .personal-analytics-chart, [data-no-pull-refresh]')) return true;
  for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
      || /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) return true;
  }
  return false;
}

/** Keeps mouse/keyboard interaction and ordinary scrolling unchanged. */
export function PullToRefresh({ surface, context, subject, refresh }: {
  surface: RefObject<HTMLElement | null>;
  context: string;
  subject: 'gifts' | 'saved data';
  refresh: () => Promise<string>;
}) {
  const [state, setState] = useState(idle);
  const latest = useRef({ refresh, subject }); latest.current = { refresh, subject };
  const controller = useRef<ReturnType<typeof createPullToRefresh> | null>(null);
  const runningLabel = useRef('Refreshing…');
  useEffect(() => {
    const root = surface.current; if (!root) return;
    const control = createPullToRefresh({ atTop, allowed: () => !document.hidden && !modalOpen(),
      refresh: () => { runningLabel.current = latest.current.subject === 'gifts' ? 'Refreshing gifts…' : 'Reloading saved data…'; return latest.current.refresh(); },
      changed: setState,
    });
    controller.current = control;
    const restoreSwipes = telegramBridge.reserveVerticalSwipes();
    document.documentElement.classList.add('telegram-pull-refresh');
    const start = (event: TouchEvent) => control.start(points(event.touches), excludedTarget(event.target, root));
    const move = (event: TouchEvent) => {
      if (!event.cancelable) { control.cancel(); return; }
      if (control.move(points(event.touches))) event.preventDefault();
    };
    const end = (event: TouchEvent) => { if (event.touches.length) control.cancel(); else void control.end(); };
    const cancel = () => control.cancel();
    const hide = () => { if (document.hidden) control.reset(); };
    const reset = () => control.reset();
    root.addEventListener('touchstart', start, { passive: true });
    root.addEventListener('touchmove', move, { passive: false });
    root.addEventListener('touchend', end, { passive: true });
    root.addEventListener('touchcancel', cancel, { passive: true });
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', reset);
    return () => {
      control.dispose(); controller.current = null; restoreSwipes();
      document.documentElement.classList.remove('telegram-pull-refresh');
      root.removeEventListener('touchstart', start); root.removeEventListener('touchmove', move);
      root.removeEventListener('touchend', end); root.removeEventListener('touchcancel', cancel);
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', reset);
    };
  }, [surface]);
  useEffect(() => { controller.current?.reset(); }, [context]);
  useEffect(() => {
    if (state.phase !== 'notice') return;
    const timer = setTimeout(() => controller.current?.dismiss(), 4500);
    return () => clearTimeout(timer);
  }, [state.phase]);
  const message = state.phase === 'refreshing' ? runningLabel.current
    : state.phase === 'notice' ? state.message
      : state.phase === 'armed' ? subject === 'gifts' ? 'Release to refresh gifts' : 'Release to reload saved data'
        : subject === 'gifts' ? 'Pull to refresh gifts' : 'Pull to reload saved data';
  return <div className={`pull-refresh pull-refresh-${state.phase}`} style={{ height: state.distance }} data-no-pull-refresh="true">
    <div role="status" aria-live="polite" aria-atomic="true">
      {state.phase !== 'idle' && <><Icon name="refresh" size={18} className={state.phase === 'refreshing' ? 'spinning' : ''} /><span>{message}</span></>}
    </div>
  </div>;
}
