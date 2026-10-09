// Administrative, explicitly bounded smoke test of deployed collector endpoints.
// Two step calls at most; Stop/Resume between them. Never prints credentials,
// raw provider records, or private source. No background continuation is started.
import {fileURLToPath} from 'node:url';
import {validateVerificationDestination} from './verify-deployment.mjs';
import {option, requireId} from './destination.mjs';

process.env.TGCLOUD_DEBUG = '0';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
let token, sources, runFunction, jobId = null, stage = 'setup';
let context;
const summary = job => ({id: job.id, state: job.state, reason: job.reason,
  pages: job.progress.pages, observations: job.progress.observations,
  request_budget: job.progress.marketapp_budget});
async function call(name, input = {}) {
  const response = await runFunction(token, `endpoints/${name}`, sources, input, context);
  if (response.result?.error || response.result?.__error || !response.result) throw new Error('Unacknowledged endpoint call');
  return response.result;
}
try {
  if (!process.argv.includes('--confirm-two-requests')) throw new Error('Explicit bounded smoke flag required');
  const args = process.argv.slice(2);
  const appId = requireId(option(args, '--app-id'), '--app-id');
  context = {initData: {user: {id: Number(requireId(option(args, '--owner-id'), '--owner-id'))}}};
  const {resolveToken} = await import('../node_modules/@tgcloud/cli/src/core/credentials.js');
  const api = await import('../node_modules/@tgcloud/cli/src/api/endpoints.js');
  runFunction = api.runFunction;
  token = await resolveToken();
  validateVerificationDestination(token, appId);
  const deployed = await api.getFiles(token);
  sources = deployed.canonical_modules;
  const existing = await call('getJobs');
  if (existing.jobs.some(job => ['queued', 'running'].includes(job.state))) throw new Error('A collection is already active');
  const resumeIndex = process.argv.indexOf('--resume-existing');
  let first;
  if (resumeIndex >= 0) {
    const resumeId = Number(process.argv[resumeIndex + 1]);
    const saved = existing.jobs.find(job => job.id === resumeId);
    if (!Number.isSafeInteger(resumeId) || saved?.kind !== 'prices' || saved.state !== 'partial' || saved.progress.pages !== 1) throw new Error('Expected stopped catalog-only smoke job');
    jobId = resumeId;
    first = {job: saved};
  } else {
    stage = 'start';
    const created = await call('startJob', {kind: 'prices', source: 'listings', timeframe: '30d'});
    jobId = created.job.id;
    console.log(JSON.stringify({stage: 'started', ...summary(created.job)}));
    stage = 'first_step';
    first = await call('stepJob', {job_id: jobId});
    console.log(JSON.stringify({stage: 'first_step', ...summary(first.job)}));
  }
  stage = 'stop';
  const stopped = await call('stopJob', {job_id: jobId});
  console.log(JSON.stringify({stage: 'stopped', ...summary(stopped.job)}));
  if (first.job.state === 'failed' || first.job.state === 'complete') throw new Error('The initial page did not leave a resumable traversal');
  stage = 'resume';
  const resumed = await call('resumeJob', {job_id: jobId});
  console.log(JSON.stringify({stage: 'resumed', ...summary(resumed.job)}));
  // Default pacing may still be active. Never wait out a provider cooldown.
  const wait = Math.max(0, resumed.job.progress.next_allowed_at - resumed.job.progress.server_time);
  if (wait > 1500) throw new Error('Provider cooldown; smoke test remains stopped');
  if (wait) await new Promise(resolve => setTimeout(resolve, wait + 100));
  stage = 'second_step';
  const second = await call('stepJob', {job_id: jobId});
  console.log(JSON.stringify({stage: 'second_step', ...summary(second.job)}));
  if (second.job.state === 'failed' || second.job.progress.pages < 2) throw new Error('Two valid pages were not committed');
  console.log(JSON.stringify({smoke_passed: true, deployed_revision: deployed.revision, maximum_provider_attempts: 2}));
} catch (error) {
  console.error('Bounded smoke test did not complete. No private data or credentials were logged.');
  console.error(JSON.stringify({stage, status: Number.isInteger(error?.status) ? error.status : null}));
  process.exitCode = 1;
} finally {
  if (jobId !== null) {
    try {
      const result = await call('stopJob', {job_id: jobId});
      console.log(JSON.stringify({stage: 'final_stop', ...summary(result.job)}));
    } catch {
      console.error('Could not confirm the final Stop; inspect Activity before continuing.');
      process.exitCode = 1;
    }
  }
}
