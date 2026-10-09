// A manually authorized, expiring allowance reset never deletes request evidence.
// No public endpoint exposes the administrative reset function.
const DAY = 86400000;
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value);

export function effectiveMarketAttempts(state, now) {
  const attempts = (state.attempts || []).filter(at => at > now - DAY);
  const reset = state.marketapp_budget_reset;
  if (!reset || !validId(reset.id) || !validTime(reset.at) || !validTime(reset.expires_at)
    || reset.at > now || now >= reset.expires_at || reset.expires_at <= reset.at
    || reset.expires_at - reset.at > 26 * 3600000 || !Array.isArray(reset.excluded_attempts)
    || reset.excluded_attempts.length > 10000 || reset.excluded_attempts.some(at => !validTime(at) || at > reset.at)) return attempts;
  const remaining = new Map();
  for (const at of reset.excluded_attempts) remaining.set(at, (remaining.get(at) || 0) + 1);
  return attempts.filter(at => {
    const count = remaining.get(at) || 0;
    if (count) {remaining.set(at, count - 1); return false;}
    return true;
  });
}

/** Private CLI only: one append-only event, idempotent by explicit reset ID. */
export async function applyMarketBudgetReset(repository, input) {
  if (!validId(input?.id) || !validTime(input.expires_at) || !/^\d{4}-\d{2}-\d{2}$/.test(input.local_date || '')
    || input.time_zone !== 'Europe/Berlin') throw new Error('Invalid allowance reset');
  const key = `marketapp-budget-reset:${input.id}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const {revision, state: saved} = await repository.read();
    const now = await repository.clock();
    if (await repository.event(key) !== null) return {reset: true, already_applied: true, reset_id: input.id};
    if (!validTime(now) || input.expires_at <= now || input.expires_at - now > 26 * 3600000) throw new Error('Allowance reset window expired or invalid');
    if (saved.marketapp_budget_reset?.local_date === input.local_date) throw new Error('An allowance reset was already applied for this date');
    if (['queued', 'running'].includes(saved.job?.state) || (saved.job?.lease_until || 0) > now) throw new Error('Stop the active collection and wait for its current request before resetting');
    const state = JSON.parse(JSON.stringify(saved));
    const excluded = state.attempts.filter(at => at > now - DAY);
    if (excluded.length > 10000) throw new Error('Unexpected allowance ledger size');
    state.marketapp_budget_reset = {id: input.id, at: now, expires_at: input.expires_at,
      local_date: input.local_date, time_zone: input.time_zone, excluded_attempts: excluded};
    if (await repository.append(revision, {key, state, job: null, records: [], raw_body: null, observed_at: new Date(now).toISOString()})) {
      return {reset: true, already_applied: false, reset_id: input.id, excluded_requests: excluded.length,
        effective_used: effectiveMarketAttempts(state, now).length, expires_at: new Date(input.expires_at).toISOString(),
        time_zone: input.time_zone, request_history_preserved: true, provider_cooldown_preserved: true, provider_requests: 0};
    }
  }
  throw new Error('Concurrent collection prevented the allowance reset');
}
