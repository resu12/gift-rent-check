// Run-only administrative bridge. This file is not a deployed Mini App endpoint.
import {createPrivateBackgroundMonitoringAccess, PRIVATE_BACKGROUND_MONITORING_VERSION, PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION, PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION} from '../lib/runtime.js';
import {createBackgroundMonitoringWorker, BackgroundMonitoringError} from '../lib/background-monitoring.js';

export default async function(input, ctx) {
  if(ctx?.background_worker!=='price-monitoring-v1'||PRIVATE_BACKGROUND_MONITORING_VERSION!==1
      ||PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION!==1
      ||PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION!==1
      ||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['runner_id','retry','status_only','prewarm_only','skip_analytics','yield_only'].includes(key))
      ||Object.prototype.hasOwnProperty.call(input,'retry')&&typeof input.retry!=='boolean'
      ||Object.prototype.hasOwnProperty.call(input,'skip_analytics')&&(typeof input.skip_analytics!=='boolean'
        ||Object.prototype.hasOwnProperty.call(input,'status_only')||Object.prototype.hasOwnProperty.call(input,'prewarm_only'))
      ||Object.prototype.hasOwnProperty.call(input,'yield_only')&&(typeof input.yield_only!=='boolean'
        ||['retry','status_only','prewarm_only','skip_analytics'].some(key=>Object.prototype.hasOwnProperty.call(input,key)))
      ||Object.prototype.hasOwnProperty.call(input,'status_only')&&(input.status_only!==true||Object.prototype.hasOwnProperty.call(input,'retry'))
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_only')&&(input.prewarm_only!==true
        ||Object.prototype.hasOwnProperty.call(input,'retry')||Object.prototype.hasOwnProperty.call(input,'status_only'))
      ||typeof input.runner_id!=='string'||!/^[a-f0-9]{64}$/.test(input.runner_id))
    throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
  let access;
  const check=async context=>{
    const saved=await access.repository.read(),at=await access.clock(),ledger=saved.state.background_monitoring,run=ledger?.run;
    if(context?.prewarm_only===true) {
      const finished=typeof ledger?.last_finished_at==='string'?Date.parse(ledger.last_finished_at):NaN;
      if(input.prewarm_only!==true||ledger?.state!=='complete'||run?.id!==context.run_id||run.session_id!==context.session_id
          ||run.stage!=='done'||run.lease!==null||run.gift_complete!==true||run.history_complete!==true
          ||!(run.last_runner_id===input.runner_id||run.id.startsWith(input.runner_id+':'))
          ||ledger.last_success_at!==ledger.last_finished_at||!Number.isFinite(finished)||finished>at||finished<=at-300000
          ||!Number.isSafeInteger(context.deadline)||context.deadline<=at||context.deadline>at+25000)
        throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
      return;
    }
    if(ledger?.state!=='running'||run?.id!==context.run_id||run.session_id!==context.session_id
        ||!run.lease||run.lease.token!==context.lease?.token||run.lease.until!==context.lease.until||run.lease.until<=at
        ||!Number.isSafeInteger(run.deadline)||run.deadline<=at)
      throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
  };
  access=createPrivateBackgroundMonitoringAccess(check);
  if(access.analytics?.version!==1||typeof access.analytics.refresh!=='function')
    throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
  if(input.prewarm_only===true&&(access.dashboard?.version!==1||typeof access.dashboard.prewarm!=='function'))
    throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
  const worker=createBackgroundMonitoringWorker(access);
  // Reconcile an uncertain administrative response without replaying a write,
  // granting a retry exception, or contacting a provider.
  return input.prewarm_only===true?worker.prewarm(input):input.status_only===true?worker.status(input):worker.tick(input);
}
