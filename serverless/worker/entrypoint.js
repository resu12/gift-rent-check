// Run-only administrative bridge. This file is not a deployed Mini App endpoint.
import {createPrivateBackgroundMonitoringAccess, PRIVATE_BACKGROUND_MONITORING_VERSION, PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION} from '../lib/runtime.js';
import {createBackgroundMonitoringWorker, BackgroundMonitoringError} from '../lib/background-monitoring.js';

export default async function(input, ctx) {
  if(ctx?.background_worker!=='price-monitoring-v1'||PRIVATE_BACKGROUND_MONITORING_VERSION!==1
      ||PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION!==1
      ||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['runner_id','retry'].includes(key))
      ||Object.prototype.hasOwnProperty.call(input,'retry')&&typeof input.retry!=='boolean'
      ||typeof input.runner_id!=='string'||!/^[a-f0-9]{64}$/.test(input.runner_id))
    throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
  let access;
  const check=async context=>{
    const saved=await access.repository.read(),at=await access.clock(),ledger=saved.state.background_monitoring,run=ledger?.run;
    if(ledger?.state!=='running'||run?.id!==context.run_id||run.session_id!==context.session_id
        ||!run.lease||run.lease.token!==context.lease?.token||run.lease.until!==context.lease.until||run.lease.until<=at
        ||!Number.isSafeInteger(run.deadline)||run.deadline<=at)
      throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
  };
  access=createPrivateBackgroundMonitoringAccess(check);
  return createBackgroundMonitoringWorker(access).tick(input);
}
