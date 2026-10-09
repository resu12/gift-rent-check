export type ListProgress = {
  resetKey: string
  batchSize: number
  limit: number
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function initialListProgress(resetKey: string, batchSize: number): ListProgress {
  const size = Math.max(1, safeCount(batchSize))
  return { resetKey, batchSize: size, limit: size }
}

export function resetListProgress(
  progress: ListProgress, resetKey: string, batchSize: number,
): ListProgress {
  const initial = initialListProgress(resetKey, batchSize)
  return progress.resetKey === initial.resetKey && progress.batchSize === initial.batchSize
    ? progress : initial
}

export function visibleListCount(progress: ListProgress, total: number): number {
  return Math.min(progress.limit, safeCount(total))
}

export function advanceListProgress(
  progress: ListProgress, resetKey: string, batchSize: number, total: number,
): ListProgress {
  // A queued callback from an earlier filter must not reveal rows in the new list.
  if (resetListProgress(progress, resetKey, batchSize) !== progress) return progress
  const limit = Math.min(progress.limit + progress.batchSize, safeCount(total))
  return limit > progress.limit ? { ...progress, limit } : progress
}

export type ListObserver = Pick<IntersectionObserver, 'observe' | 'disconnect'>
export type ListObserverFactory = (
  callback: IntersectionObserverCallback, options: IntersectionObserverInit,
) => ListObserver

function browserObserverFactory(): ListObserverFactory | null {
  return typeof IntersectionObserver === 'undefined' ? null
    : (callback, options) => new IntersectionObserver(callback, options)
}

export function observeNextBatch(
  target: Element,
  loadMore: () => void,
  createObserver: ListObserverFactory | null = browserObserverFactory(),
): () => void {
  if (!createObserver) return () => {}
  let active = true
  let observer: ListObserver | undefined
  observer = createObserver(entries => {
    if (!active || !entries.some(entry => entry.target === target && entry.isIntersecting)) return
    // One batch per observer. The hook observes the moved sentinel after rendering it.
    active = false
    observer?.disconnect()
    loadMore()
  }, { root: null, rootMargin: '300px 0px', threshold: 0 })
  observer.observe(target)
  return () => {
    active = false
    observer?.disconnect()
  }
}
