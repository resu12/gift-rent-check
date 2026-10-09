import type { Ref } from 'react';

export function ListFooter({ visibleCount, total, hasMore, loadMore, sentinelRef, noun = 'gifts' }: {
  visibleCount: number;
  total: number;
  hasMore: boolean;
  loadMore: () => void;
  sentinelRef: Ref<HTMLDivElement>;
  noun?: string;
}) {
  return <div className="table-footer progressive-footer" ref={sentinelRef}>
    <span role="status" aria-live="polite" aria-atomic="true">{hasMore ? `${visibleCount.toLocaleString()} of ${total.toLocaleString()} ${noun}` : total > 0 ? `All ${total.toLocaleString()} matching ${noun} shown` : `No ${noun}`}</span>
    {hasMore && <button type="button" className="button secondary small" onClick={loadMore} aria-label={`Load more ${noun}`}>Load more</button>}
  </div>;
}
