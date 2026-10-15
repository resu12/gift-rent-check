// Independent wake-up trigger. Telegram credentials stay in GitHub's protected
// monitoring environment; this worker can only dispatch the reviewed workflow.
export const SCHEDULER = Object.freeze({
  api: 'https://api.github.com/repos/resu12/gift-rent-check/actions/workflows/background-monitoring.yml',
  branch: 'main',
  cron: '7,22,37,52 * * * *',
  request_ms: 8000,
  response_bytes: 1048576,
  duplicate_ms: 10 * 60 * 1000,
});
const ACTIVE = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const STATUSES = new Set([...ACTIVE, 'completed']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class SchedulerError extends Error {
  constructor(reason, status) { super(reason); this.reason = reason; this.status = status; }
}
const stop = (reason, status) => { throw new SchedulerError(reason, status); };

function cancel(body) {
  try { const result = body?.cancel(); result?.catch?.(() => {}); } catch {}
}

async function readJson(response, signal) {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > SCHEDULER.response_bytes)) stop('response_too_large');
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '') || !response.body) stop('invalid_response');
  const reader = response.body.getReader();
  const onAbort = () => cancel(reader);
  signal.addEventListener('abort', onAbort, {once: true});
  if (signal.aborted) onAbort();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) stop('api_timeout');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SCHEDULER.response_bytes) stop('response_too_large');
      text += decoder.decode(chunk.value, {stream: true});
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { stop('invalid_response'); }
  } finally { signal.removeEventListener('abort', onAbort); cancel(reader); }
}

// One bounded request, with no redirects or retries (especially after a POST
// whose acceptance is uncertain). Never include upstream bodies in logs.
async function requestApi(request, token, path, method, timeoutMs) {
  const controller = new AbortController();
  let timer, response, stopped = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      controller.abort();
      cancel(response?.body);
      reject(new SchedulerError(method === 'POST' ? 'dispatch_unknown' : 'api_timeout'));
    }, timeoutMs);
  });
  const work = (async () => {
    response = await request(SCHEDULER.api + path, {
      method, redirect: 'error', signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gift-rent-monitoring-scheduler',
        ...(method === 'POST' ? {'Content-Type': 'application/json'} : {}),
      },
      ...(method === 'POST' ? {body: JSON.stringify({ref: SCHEDULER.branch, inputs: {scheduled: true}})} : {}),
    });
    if (stopped) stop(method === 'POST' ? 'dispatch_unknown' : 'api_timeout');
    if (response.redirected || response.status >= 300 && response.status < 400) stop('redirect_blocked');
    if (response.status === 429 || response.status === 403 && (response.headers.has('Retry-After') || response.headers.get('X-RateLimit-Remaining') === '0')) stop('rate_limited', response.status);
    if (response.status !== (method === 'POST' ? 204 : 200)) {
      stop(method === 'POST' ? (response.status >= 500 ? 'dispatch_unknown' : 'dispatch_rejected') : 'api_rejected', response.status);
    }
    return method === 'POST' ? null : await readJson(response, controller.signal);
  })();
  try { return await Promise.race([work, timeout]); }
  catch (error) {
    if (error instanceof SchedulerError) throw error;
    stop(method === 'POST' ? 'dispatch_unknown' : 'api_unavailable');
  } finally { clearTimeout(timer); stopped = true; cancel(response?.body); }
}

function runsFrom(value, {status, event} = {}) {
  if (!record(value) || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.workflow_runs)
    || value.workflow_runs.length !== Math.min(value.total_count, 1)) stop('invalid_response');
  for (const run of value.workflow_runs) {
    if (!record(run) || !Number.isSafeInteger(run.id) || run.id <= 0 || !STATUSES.has(run.status)
      || typeof run.created_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(run.created_at)
      || !Number.isFinite(Date.parse(run.created_at)) || typeof run.event !== 'string'
      || status && run.status !== status || event && run.event !== event) stop('invalid_response');
  }
  return value.workflow_runs;
}

export async function runScheduler(env = {}, {fetch: request = globalThis.fetch, now = Date.now, emit = value => console.log(JSON.stringify(value)), timeoutMs = SCHEDULER.request_ms} = {}) {
  const at = now();
  let reads = 0, dispatchAttempts = 0;
  const finish = (state, reason, status) => {
    const result = {event: 'cloud-monitoring-scheduler', at: new Date(at).toISOString(), state, reads, dispatch_attempts: dispatchAttempts,
      ...(reason ? {reason} : {}), ...(Number.isInteger(status) ? {http_status: status} : {})};
    emit(result);
    return result;
  };
  if (env.SCHEDULER_ENABLED !== 'true') return finish('disabled');
  const token = env.GITHUB_MONITORING_TOKEN;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{20,1024}$/.test(token)) return finish('blocked', 'missing_token');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCHEDULER.request_ms) return finish('blocked', 'invalid_timeout');
  try {
    // Query every active status separately: a long-running or approval-blocked
    // run must not disappear behind newer completed runs on a history page.
    for (const status of ACTIVE) {
      reads++;
      const payload = await requestApi(request, token, `/runs?status=${status}&per_page=1`, 'GET', timeoutMs);
      if (runsFrom(payload, {status}).length) return finish('busy');
    }
    reads++;
    const payload = await requestApi(request, token, '/runs?event=workflow_dispatch&per_page=1', 'GET', timeoutMs);
    const latest = runsFrom(payload, {event: 'workflow_dispatch'})[0];
    // Includes manual dispatches. Future timestamps also suppress dispatch:
    // clock disagreement must not cause repeated workflow creation.
    if (latest && Date.parse(latest.created_at) >= at - SCHEDULER.duplicate_ms) return finish('recent_dispatch');
    dispatchAttempts++;
    await requestApi(request, token, '/dispatches', 'POST', timeoutMs);
    return finish('dispatched');
  } catch (error) {
    return finish('blocked', error instanceof SchedulerError ? error.reason : 'api_unavailable', error instanceof SchedulerError ? error.status : undefined);
  }
}

export default {
  // No public trigger, administrative endpoint, or credential-bearing response.
  fetch() { return new Response('Not found', {status: 404}); },
  async scheduled(_event, env) { await runScheduler(env); },
};
