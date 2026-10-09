import { useCallback, useLayoutEffect, useState } from 'react'
import {
  advanceListProgress, initialListProgress, observeNextBatch, resetListProgress,
  visibleListCount,
} from './data/progressiveList'

/** Reveal an already-loaded list in batches without changing its order or fetching data. */
export function useProgressiveList(
  total: number, batchSize: number, resetKey: string, enabled = true,
) {
  const [savedProgress, setProgress] = useState(() => initialListProgress(resetKey, batchSize))
  const [sentinel, sentinelRef] = useState<HTMLElement | null>(null)
  const progress = resetListProgress(savedProgress, resetKey, batchSize)
  // Reset during render so a changed filter never commits the previous list's limit.
  if (progress !== savedProgress) setProgress(progress)
  const visibleCount = visibleListCount(progress, total)
  const hasMore = visibleCount < total
  const loadMore = useCallback(() => {
    setProgress(previous => advanceListProgress(previous, resetKey, batchSize, total))
  }, [resetKey, batchSize, total])

  useLayoutEffect(() => {
    if (!enabled || !hasMore || !sentinel) return
    return observeNextBatch(sentinel, loadMore)
  }, [enabled, hasMore, sentinel, loadMore, visibleCount, resetKey, batchSize])

  return { visibleCount, hasMore, loadMore, sentinelRef }
}
