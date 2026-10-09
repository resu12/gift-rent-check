import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceListProgress, initialListProgress, observeNextBatch, resetListProgress,
  visibleListCount,
} from './progressiveList.ts'
import type { ListObserverFactory } from './progressiveList.ts'

test('a stable prefix grows in batches and stops exactly at the last row', () => {
  const rows = Array.from({ length: 38 }, (_, index) => `gift-${index}`)
  let progress = initialListProgress('all', 15)
  const first = rows.slice(0, visibleListCount(progress, rows.length))
  assert.equal(first.length, 15)
  progress = advanceListProgress(progress, 'all', 15, rows.length)
  assert.equal(visibleListCount(progress, rows.length), 30)
  assert.deepEqual(rows.slice(0, first.length), first)
  progress = advanceListProgress(progress, 'all', 15, rows.length)
  assert.equal(visibleListCount(progress, rows.length), 38)
  assert.equal(advanceListProgress(progress, 'all', 15, rows.length), progress)
  assert.equal(rows.length, 38)
})

test('empty, short and exact-batch lists never report nonexistent rows', () => {
  const progress = initialListProgress('all', 20)
  assert.equal(visibleListCount(progress, 0), 0)
  assert.equal(visibleListCount(progress, 7), 7)
  assert.equal(visibleListCount(progress, 20), 20)
  assert.equal(advanceListProgress(progress, 'all', 20, 7), progress)
})

test('filter, sort and pricing selection changes reset the visible prefix immediately', () => {
  let progress = advanceListProgress(initialListProgress('all|name|listings|24h', 15),
    'all|name|listings|24h', 15, 100)
  for (const key of ['Black|name|listings|24h', 'Black|gap|listings|24h', 'Black|gap|rentals|30d']) {
    progress = resetListProgress(progress, key, 15)
    assert.equal(visibleListCount(progress, 100), 15)
    progress = advanceListProgress(progress, key, 15, 100)
    assert.equal(visibleListCount(progress, 100), 30)
  }
  assert.equal(resetListProgress(progress, progress.resetKey, 20).limit, 20)
})

test('background refresh preserves the reveal limit while clamping the displayed count', () => {
  const progress = advanceListProgress(initialListProgress('same-filter', 20), 'same-filter', 20, 100)
  assert.equal(resetListProgress(progress, 'same-filter', 20), progress)
  assert.equal(visibleListCount(progress, 100), 40)
  assert.equal(visibleListCount(progress, 25), 25)
  assert.equal(visibleListCount(progress, 110), 40)
})

test('a stale filter callback cannot advance a newer filter or batch size', () => {
  const progress = initialListProgress('Black', 15)
  assert.equal(advanceListProgress(progress, 'all', 15, 200), progress)
  assert.equal(advanceListProgress(progress, 'Black', 20, 200), progress)
})

function fakeObserver() {
  let callback: IntersectionObserverCallback | undefined
  let options: IntersectionObserverInit | undefined
  let observed: Element | undefined
  let disconnects = 0
  const factory: ListObserverFactory = (nextCallback, nextOptions) => {
    callback = nextCallback
    options = nextOptions
    return { observe: target => { observed = target }, disconnect: () => { disconnects++ } }
  }
  return {
    factory,
    fire(target: Element, isIntersecting = true) {
      callback?.([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
    },
    get options() { return options },
    get observed() { return observed },
    get disconnects() { return disconnects },
  }
}

test('near-bottom observation advances one batch despite duplicate callback bursts', () => {
  const target = {} as Element
  const observer = fakeObserver()
  let loads = 0
  const cleanup = observeNextBatch(target, () => { loads++ }, observer.factory)
  assert.equal(observer.observed, target)
  assert.deepEqual(observer.options, { root: null, rootMargin: '300px 0px', threshold: 0 })
  observer.fire(target, false)
  observer.fire({} as Element)
  assert.equal(loads, 0)
  observer.fire(target)
  observer.fire(target)
  observer.fire(target)
  assert.equal(loads, 1)
  assert.equal(observer.disconnects, 1)
  cleanup()
})

test('cleanup cancels callbacks queued before unmount, disabled observation or a new filter', () => {
  const target = {} as Element
  const observer = fakeObserver()
  let loads = 0
  const cleanup = observeNextBatch(target, () => { loads++ }, observer.factory)
  cleanup()
  observer.fire(target)
  assert.equal(loads, 0)
  assert.equal(observer.disconnects, 1)
})

test('a new observer can fill another batch after the previous prefix rendered', () => {
  const target = {} as Element
  let progress = initialListProgress('all', 15)
  const loadMore = () => { progress = advanceListProgress(progress, 'all', 15, 34) }
  const firstObserver = fakeObserver()
  const cleanupFirst = observeNextBatch(target, loadMore, firstObserver.factory)
  firstObserver.fire(target)
  assert.equal(progress.limit, 30)
  cleanupFirst()
  const nextObserver = fakeObserver()
  const cleanupNext = observeNextBatch(target, loadMore, nextObserver.factory)
  firstObserver.fire(target)
  assert.equal(progress.limit, 30)
  nextObserver.fire(target)
  assert.equal(progress.limit, 34)
  cleanupNext()
})

test('unsupported IntersectionObserver leaves the manual load-more fallback functional', () => {
  let progress = initialListProgress('all', 15)
  const loadMore = () => { progress = advanceListProgress(progress, 'all', 15, 100) }
  const cleanup = observeNextBatch({} as Element, loadMore, null)
  assert.equal(progress.limit, 15)
  loadMore()
  assert.equal(progress.limit, 30)
  cleanup()
})
