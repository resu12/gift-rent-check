// Run-only administrative bridge. This file is not a deployed Mini App endpoint.
import {createPrivateBackgroundMonitoringAccess, PRIVATE_BACKGROUND_MONITORING_VERSION, PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION, PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION} from '../lib/runtime.js';
import {createBackgroundMonitoringWorker, BackgroundMonitoringError} from '../lib/background-monitoring.js';

const preparationErrorCodes=new Set(['BACKGROUND_PREWARM_PROGRESS_INVALID','BACKGROUND_PREWARM_PROGRESS_LIMIT','BACKGROUND_PREWARM_TIMEOUT','BACKGROUND_PREWARM_DENIED','BACKGROUND_LEASE_LOST',
  'BACKGROUND_SCOPE_CHANGED','BACKGROUND_ACCESS_DENIED','BACKGROUND_RULES_CHANGED',
  'BACKGROUND_PREWARM_CONFIRMATION_FAILED','BACKGROUND_PREWARM_INCOMPLETE','BACKGROUND_PREWARM_UNSUPPORTED']);

const operationErrorCodes=new Set([...preparationErrorCodes,
  'BACKGROUND_ANALYTICS_INVALID','BACKGROUND_RULES_INVALID','BACKGROUND_STATE_INVALID','BACKGROUND_CONFIGURATION',
  'BACKGROUND_CLOCK_INVALID','BACKGROUND_RUNNER_INVALID','BACKGROUND_SCOPE_INVALID','BACKGROUND_CONFLICT',
  'BACKGROUND_GIFT_INVALID','BACKGROUND_HISTORY_INVALID','BACKGROUND_OPERATION_FAILED']);

export default async function(input, ctx) {
  if(ctx?.background_worker!=='price-monitoring-v1'||PRIVATE_BACKGROUND_MONITORING_VERSION!==1
      ||PRIVATE_BACKGROUND_SCOPED_HISTORY_VERSION!==1
      ||PRIVATE_BACKGROUND_PERSONAL_ANALYTICS_VERSION!==1
      ||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['runner_id','retry','status_only','prewarm_only','prewarm_stage','prewarm_progressive','prewarm_continuation','prewarm_confirm_only','skip_analytics','yield_only'].includes(key))
      ||Object.prototype.hasOwnProperty.call(input,'retry')&&typeof input.retry!=='boolean'
      ||Object.prototype.hasOwnProperty.call(input,'skip_analytics')&&(typeof input.skip_analytics!=='boolean'
        ||Object.prototype.hasOwnProperty.call(input,'status_only')||Object.prototype.hasOwnProperty.call(input,'prewarm_only'))
      ||Object.prototype.hasOwnProperty.call(input,'yield_only')&&(typeof input.yield_only!=='boolean'
        ||['retry','status_only','prewarm_only','skip_analytics'].some(key=>Object.prototype.hasOwnProperty.call(input,key)))
      ||Object.prototype.hasOwnProperty.call(input,'status_only')&&(input.status_only!==true||Object.prototype.hasOwnProperty.call(input,'retry'))
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_only')&&(input.prewarm_only!==true
        ||Object.prototype.hasOwnProperty.call(input,'retry')||Object.prototype.hasOwnProperty.call(input,'status_only'))
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_stage')&&(!['basis','cards'].includes(input.prewarm_stage)||input.prewarm_only!==true)
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_progressive')&&(input.prewarm_progressive!==true||input.prewarm_stage!=='basis'||input.prewarm_only!==true)
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_continuation')&&(input.prewarm_progressive!==true||typeof input.prewarm_continuation!=='string'||!/^[a-f0-9]{64}$/.test(input.prewarm_continuation))
      ||Object.prototype.hasOwnProperty.call(input,'prewarm_confirm_only')&&(input.prewarm_confirm_only!==true
        ||['retry','status_only','prewarm_only','prewarm_stage','prewarm_progressive','prewarm_continuation','skip_analytics','yield_only'].some(key=>Object.prototype.hasOwnProperty.call(input,key)))
      ||typeof input.runner_id!=='string'||!/^[a-f0-9]{64}$/.test(input.runner_id))
    return {state:'failed',execution_code:'BACKGROUND_ACCESS_DENIED'};
  let access;
  const check=async context=>{
    const saved=await access.repository.read(),at=await access.clock(),ledger=saved.state.background_monitoring,run=ledger?.run;
    if(context?.prewarm_only===true) {
      const finished=typeof ledger?.last_finished_at==='string'?Date.parse(ledger.last_finished_at):NaN;
      const confirming=input.prewarm_confirm_only===true;
      if((confirming?context.confirm_only!==true:input.prewarm_only!==true||context.confirm_only===true)
          ||context.prepare_stage!==input.prewarm_stage
          ||context.prepare_progressive!==input.prewarm_progressive||context.prepare_continuation!==input.prewarm_continuation
          ||!Number.isSafeInteger(context.deadline)||context.deadline>at+(confirming?10000:25000))
        throw new BackgroundMonitoringError('BACKGROUND_PREWARM_DENIED');
      if(ledger?.state!=='complete'||run?.id!==context.run_id||run.session_id!==context.session_id
          ||run.stage!=='done'||run.lease!==null||run.gift_complete!==true||run.history_complete!==true
          ||!(run.last_runner_id===input.runner_id||run.id.startsWith(input.runner_id+':'))
          ||ledger.last_success_at!==ledger.last_finished_at||!Number.isFinite(finished)||finished>at||finished<=at-300000)
        throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
      if(context.deadline<=at)throw new BackgroundMonitoringError('BACKGROUND_PREWARM_TIMEOUT');
      return;
    }
    if(ledger?.state!=='running'||run?.id!==context.run_id||run.session_id!==context.session_id
        ||!run.lease||run.lease.token!==context.lease?.token||run.lease.until!==context.lease.until||run.lease.until<=at
        ||!Number.isSafeInteger(run.deadline)||run.deadline<=at)
      throw new BackgroundMonitoringError('BACKGROUND_LEASE_LOST');
  };
  try {
    access=createPrivateBackgroundMonitoringAccess(check);
    if(access.analytics?.version!==1||typeof access.analytics.refresh!=='function')
      throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
    if(input.prewarm_only===true&&(access.dashboard?.version!==1||typeof access.dashboard.prewarm!=='function'))
      throw new BackgroundMonitoringError('BACKGROUND_ACCESS_DENIED');
    if(input.prewarm_stage!==undefined&&(access.dashboard?.preparation_version!==2
        ||access.dashboard.confirmation_version!==1||typeof access.dashboard.prepareBasis!=='function'
        ||typeof access.dashboard.prepareCards!=='function'||typeof access.dashboard.confirm!=='function'
        ||typeof access.assertScopeReadOnly!=='function'))
      throw new BackgroundMonitoringError('BACKGROUND_PREWARM_UNSUPPORTED');
    if(input.prewarm_progressive===true&&access.dashboard?.continuation_version!==1)
      throw new BackgroundMonitoringError('BACKGROUND_PREWARM_UNSUPPORTED');
    if(input.prewarm_confirm_only===true&&(access.dashboard?.version!==1||access.dashboard.confirmation_version!==1
        ||typeof access.dashboard.prepare!=='function'||typeof access.dashboard.confirm!=='function'
        ||typeof access.assertScopeReadOnly!=='function'))
      throw new BackgroundMonitoringError('BACKGROUND_PREWARM_UNSUPPORTED');
    const worker=createBackgroundMonitoringWorker(access);
    // Reconcile an uncertain administrative response without replaying a write,
    // granting a retry exception, or contacting a provider.
    return await (input.prewarm_confirm_only===true?worker.confirmPreparation(input)
      :input.prewarm_only===true?worker.prewarm(input):input.status_only===true?worker.status(input):worker.tick(input));
  } catch(error) {
    // A host exception envelope can wrap a fixed application code in a stack
    // trace. Return that code directly for this optional phase instead of
    // parsing or forwarding host text. A failed result cannot certify caches.
    if((input.prewarm_only===true||input.prewarm_confirm_only===true)
      &&preparationErrorCodes.has(error?.message)
      &&(error.code===undefined||error.code===error.message))
      return {state:'failed',execution_code:error.message};
    if(input.prewarm_only!==true&&input.prewarm_confirm_only!==true)
      return {state:'failed',execution_code:operationErrorCodes.has(error?.message)
        &&(error.code===undefined||error.code===error.message)?error.message:'BACKGROUND_OPERATION_FAILED'};
    throw error;
  }
}
