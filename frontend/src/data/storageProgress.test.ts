import test from 'node:test';
import assert from 'node:assert/strict';
import { readStorageStatus, storageCleanupStage } from './storageMonitoring.ts';
import type { StorageCleanupProgress, StorageStatus } from './storageMonitoring.ts';

const progress: StorageCleanupProgress = { stage: 'sync_history', stage_number: 9, stage_count: 16, percent: 39 };
const status: StorageStatus = { version: 1, scope: 'app', status: 'cleaning', estimated_bytes: 454000000,
  budget_bytes: 536870912, checked_at: '2026-10-11T19:29:49.000Z', inventory_complete: true,
  cleanup: { state: 'running', last_completed_at: null, reclaimed_bytes: 16600000,
    estimated_reclaimable_bytes: null, progress }, can_cleanup: true, next_step_at: null };

test('cleanup progress is optional and accepts only a bounded stage description', () => {
  assert.deepEqual(readStorageStatus(status).cleanup.progress, progress);
  const { progress: _progress, ...legacyCleanup } = status.cleanup;
  assert.equal(readStorageStatus({ ...status, cleanup: legacyCleanup }).cleanup.progress, undefined);
  assert.equal(readStorageStatus({ ...status, cleanup: { ...status.cleanup, progress: null } }).cleanup.progress, null);
  for (const percent of [0, 100, null]) assert.equal(readStorageStatus({ ...status,
    cleanup: { ...status.cleanup, progress: { ...progress, percent } } }).cleanup.progress!.percent, percent);
});

test('cleanup progress rejects private fields, arbitrary labels and invalid range claims', () => {
  for (const invalid of [{ ...progress, table: 'private-table' }, { ...progress, stage: '<script>private</script>' },
    { ...progress, stage_number: 0 }, { ...progress, stage_number: 17 }, { ...progress, stage_number: 9.2 },
    { ...progress, stage_count: 1000 }, { ...progress, percent: -1 }, { ...progress, percent: 101 },
    { ...progress, percent: 2.5 }, { ...progress, percent: Number.NaN }, { ...progress, percent: '39' }])
    assert.throws(() => readStorageStatus({ ...status, cleanup: { ...status.cleanup, progress: invalid } }), /Storage status could not be confirmed/);
});

test('invited cleanup accepts only its own seven stages and fixed user-facing labels', () => {
  const own = { ...status, scope: 'account', budget_bytes: null,
    cleanup: { ...status.cleanup, reclaimed_bytes: 0, progress: { ...progress, stage_number: 5, stage_count: 7, percent: null } } };
  assert.equal(readStorageStatus(own).cleanup.progress!.stage_count, 7);
  assert.throws(() => readStorageStatus({ ...own, cleanup: status.cleanup }), /Storage status could not be confirmed/);
  assert.equal(storageCleanupStage(progress), 'Checking saved sync history');
  for (const stage of ['cache', 'expired_metadata', 'gift_checks', 'saved_status', 'request_allowance', 'discovery'] as const)
    assert.ok(storageCleanupStage({ ...progress, stage }).length > 0);
});
