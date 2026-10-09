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
    <span role="status" aria-live="polite">Showing {visibleCount.toLocaleString()} of {total.toLocaleString()} {noun}</span>
    {hasMore ? <div><span className="scroll-hint">More gifts load as you scroll</span><button className="button secondary small" onClick={loadMore} aria-label="Load more gifts">Load more</button></div>
      : total > 0 && <span className="list-end">All matching gifts shown</span>}
  </div>;
}
