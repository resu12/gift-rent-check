import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { analyticsDate } from './data/personalAnalytics';
import type { AnalyticsBucket, AnalyticsGrouping } from './data/personalAnalytics';
import { analyticsBarIndex, analyticsChartPoint } from './data/analyticsChartInteraction';

export function PersonalAnalyticsChart({ buckets, heights, group, label, interactive }: {
  buckets: AnalyticsBucket[]; heights: number[]; group: AnalyticsGrouping; label: string; interactive: boolean;
}) {
  const [selection, setSelection] = useState<{ index: number; pinned: boolean } | null>(null);
  const chart = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const keyboardIndex = useRef(0);
  const points = useMemo(() => buckets.map(analyticsChartPoint), [buckets]);
  useEffect(() => {
    if (!interactive) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !chart.current?.contains(event.target)) setSelection(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setSelection(null); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [interactive]);
  const pointIndex = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return analyticsBarIndex(event.clientX, bounds.left, bounds.width, buckets.length);
  };
  const select = (index: number, pinned: boolean) => {
    keyboardIndex.current = index;
    setSelection(previous => previous?.index === index && previous.pinned === pinned ? previous : { index, pinned });
  };
  const press = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const index = pointIndex(event); if (index === null) return;
    pointer.current = event.pointerId; select(index, true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Selection still works without capture. */ }
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId && (event.pointerType !== 'mouse' || selection?.pinned)) return;
    const index = pointIndex(event); if (index !== null) select(index, pointer.current === event.pointerId);
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    // Keep tapped values readable after lifting a finger; a scroll cancels them.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { setSelection(null); return; }
    let index = selection?.index ?? keyboardIndex.current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') index++;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') index--;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = buckets.length - 1;
    else if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!buckets.length) return;
    event.preventDefault(); select(Math.max(0, Math.min(buckets.length - 1, index)), true);
  };
  const detail = selection ? points[selection.index] : null;
  const selectedPosition = selection ? (selection.index + .5) / buckets.length * 100 : 50;
  const accessible = points[selection?.index ?? keyboardIndex.current];
  return <div ref={chart} className={`personal-analytics-chart${interactive ? ' interactive' : ''}`} role={interactive ? 'group' : 'img'}
    aria-label={`${label} rental volume.${interactive ? ' Press a bar for its amount and rental count.' : ' Values are in Statistics below.'}`}>
    <div className="personal-analytics-bars" style={{ gap: buckets.length > 90 ? 0 : undefined }}
      {...(interactive && buckets.length ? { tabIndex: 0, role: 'slider', 'aria-label': `${label} rental period`, 'aria-valuemin': 0,
        'aria-valuemax': buckets.length - 1, 'aria-valuenow': selection?.index ?? keyboardIndex.current,
        'aria-valuetext': accessible ? `${accessible.period}, ${accessible.volume}, ${accessible.rentals}, including extensions${accessible.partial ? ', partial period' : ''}` : undefined,
        onPointerDown: press, onPointerMove: move, onPointerUp: release,
        onPointerCancel: () => { pointer.current = null; setSelection(null); },
        onLostPointerCapture: () => { pointer.current = null; },
        onPointerLeave: () => { if (pointer.current === null && !selection?.pinned) setSelection(null); },
        onFocus: () => { if (pointer.current === null) select(keyboardIndex.current, false); },
        onBlur: () => { pointer.current = null; setSelection(null); }, onKeyDown: key,
      } : {})}>
      {buckets.map((bucket, index) => {
        const point = points[index];
        return <div key={bucket.key} className={`personal-analytics-bar${bucket.partial ? ' partial' : ''}${bucket.volume === '0' ? ' zero' : ''}${interactive && selection?.index === index ? ' selected' : ''}`}
          title={interactive ? undefined : `${point.period}: ${point.volume}, ${point.rentals}${point.partial ? ' (partial period)' : ''}`}>
          <span style={{ height: `${heights[index]}%` }} />
        </div>;
      })}
    </div>
    {interactive && detail && <div className="personal-analytics-tooltip" role="tooltip"
      style={{ left: `${selectedPosition}%`, transform: `translateX(-${selectedPosition}%)` }}>
      <span>{detail.period}{detail.partial && <small>Partial period</small>}</span>
      <strong>{detail.volume}</strong><span>{detail.rentals}</span>
    </div>}
    {buckets.length > 0 && <div className="personal-analytics-axis"><span>{group === 'year' ? buckets[0].key.slice(0, 4) : analyticsDate(buckets[0].start)}</span>{(group !== 'year' || buckets.length > 1) && <span>{group === 'year' ? buckets[buckets.length - 1].key.slice(0, 4) : analyticsDate(buckets[buckets.length - 1].end)}</span>}</div>}
  </div>;
}
