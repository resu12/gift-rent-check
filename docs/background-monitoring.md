# Background price monitoring

The cloud worker refreshes the private owner's saved gifts and checks enabled price rules while the dashboard is closed. It can add suggestions to the approval queue. It cannot approve, sign, submit, or automatically change a rental price. Open the app to review a proposal and approve its transaction in your wallet.

This first version serves only the configured private owner. It does not enumerate public users or run their policies. Paused rules and disabled gifts stay paused. Existing provider limits, ownership checks, saved-data checks, storage limits, and wallet approval safeguards still apply.

The dashboard's **Status → Monitoring** card shows enabled gift monitoring, pending approvals, the latest saved cloud result, and the next planned check. Open its details for the last run and last fully successful check. **Manage rules** opens the existing rule controls and approval queue. The card reads saved status once a minute while the Status page is visible; **Refresh status** only reloads that information and does not launch a cloud run, collect provider data, or request wallet approval. A missing cloud record means no cloud check has been reported for that account, not proof that the GitHub schedule is disabled.

## How it runs

Telegram hosting has no scheduler exposed by the repository's current deployment tools. `.github/workflows/background-monitoring.yml` supplies an external wake-up every hour, at minute 37 UTC. The worker starts an automatic check only when its saved due time has arrived, at least six hours after the previous cycle started. Early wake-ups read the saved checkpoint and exit without provider requests or database writes. A later wake-up can catch a missed trigger without replaying every missed interval. A manual **Run workflow** can still retry an incomplete or failed check before it is due, using the same operation and safeguards; it cannot repeat a completed check early.

The runner retrieves the app's canonical deployed source, requires the version-1 private monitoring access protocol, adds the reviewed local worker and its fixed bridge to an administrative `/run` request, and resolves only their module dependencies. It does not publish modules, change the deployed manifest, or install a public endpoint. Application credentials and private configuration are read from the existing deployed app; no local configuration files are uploaded. The bridge also requires a fixed administrative context marker so an accidental Mini App endpoint publication cannot grant ordinary callers owner access.

Each invocation has a random runner identifier, a 20-minute deadline, and at most 200 steps. Individual administrative requests have a 90-second timeout and bounded response sizes. Waiting states honor their saved `retry_at`. A lost response or unexpected error stops the runner; it does not blindly repeat an operation with an unknown outcome. The core's durable checkpoints and leases support later recovery. A timeout does not imply that the most recent remote step was rolled back.

Cloud gift checks target only retained gifts with enabled, unpaused rules. They use a five-minute window; ordinary dashboard refreshes keep their existing two-minute limit. Recognized candidates and unmonitored gifts do not consume the cloud check's TON work.

If a cloud gift check reaches its time window, the worker can continue the same saved TON traversal once within that cycle, for up to five more minutes. Completed results, the cursor, and the shared 20-request allowance are preserved; the continuation does not reset provider or daily budgets. At least five minutes remain reserved for rental history. Provider cooldowns, active leases, changes to the monitored gifts, and a manual Stop still prevent an unsafe continuation.

If the bounded continuation cannot finish, the result stays incomplete and the next cycle starts with the first unfinished TON check. A website count showing every gift checked does not mean the additional TON verification is complete. Results from different six-hour cycles are not combined into a falsely fresh, completed check.

History collection uses a 30-, 60-, or 90-day window according to the enabled rules, with at most 100 collection steps per cycle. An unfinished traversal can continue from its saved cursor in a later cycle only when it is known to belong to this worker. After finishing an older traversal, the worker checks the recent head again before treating history as current. Manual collections and an explicit Stop remain respected. Each new cycle sets its next automatic due time six hours after its actual start, including a delayed catch-up or manual retry. Older saved schedules also respect this minimum. The Status page's next planned time is the earliest due time; the next hourly wake-up may start later.

An inactive manual listing-price scan that ended at its request or time allowance does not block a separate cloud rental-history check. This also covers a scan left marked running or queued when both its saved invocation deadline and request lease have expired. Its saved data and cursor remain available for manual Resume. Explicitly stopped scans, active requests, and unfinished manual rental-history scans still block that switch.

For longer idle rules, the app retains a bounded record of overlapping, completed and verified history coverage for each unchanged availability baseline. This lets continued monitoring support rules up to 365 days without repeatedly downloading an ever-growing history window. The latest completed coverage must still include the latest gift observation. Missing or ambiguous history cannot extend that coverage, and a changed availability baseline starts it over.

Logs contain only fixed status names, counts, and dates. Provider responses, addresses, gifts, credentials, private source, and remote error messages are not printed or uploaded as artifacts. A `partial` result means the runner reached a bound or saved work for a later wake-up; `blocked` or `failed` makes the workflow fail so the operator can investigate.

## Credential trust and repository protection

`TGCLOUD_TOKEN` is the full Telegram app administration credential, **not a restricted monitoring token**. Someone who obtains it can administer the app beyond this worker. The worker intentionally uses a narrow fixed operation, but that does not reduce the credential's underlying authority.

Use the protected GitHub environment named `price-monitoring`. Restrict it to the repository's default branch and protect that branch against unreviewed pushes. Review changes to the workflow, worker, runner, and imported administrative helpers before merging. Required reviewers can protect the initial rollout; if required for every job, each scheduled run will wait for approval and will not be unattended. GitHub documents these [environment protection and secret-access controls](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments).

The committed workflow permits only `resu12/gift-rent-check` and its default branch. It has no pull-request trigger, uses read-only GitHub repository permissions, pins the checkout and Node actions to immutable revisions, retains no checkout credential, and exposes the Telegram secret only to the worker step. It runs directly on Node 24 without installing packages or running dependency installation scripts. Do not add debug dumps, shell tracing, source artifacts, or arbitrary user-supplied commands to this credentialed job.

## Activation

The workflow is inert until explicitly configured. Adding these files alone does not start monitoring.

1. Merge the reviewed worker, runner, and workflow into the default branch. Publish the required private monitoring access protocol and associated status-display changes using the normal deployment checks **before enabling the schedule**. The runner rejects older deployed runtimes. The worker itself is supplied to `/run` and does not consume another deployed module slot.
2. Create the `price-monitoring` environment in **Settings → Environments**. Limit deployment branches to the default branch and configure the review protections appropriate for the rollout.
3. In that environment, add secret `TGCLOUD_TOKEN` with the app's existing administration credential and variable `TGCLOUD_APP_ID` with the explicit numeric app ID. Never place the token in a repository variable, file, issue, workflow input, or command-line argument.
4. Create the **repository-level** Actions variable `BACKGROUND_MONITORING_ENABLED` with value `true`. The job condition reads this repository variable before environment variables become available. Remove it or set it to `false` to disable future runs.
5. Use **Actions → Background price monitoring → Run workflow**, on the default branch. Inspect the sanitized status and the app's monitoring status/approval queue. An expired Marketapp login, missing required data, quota exhaustion, or a paused rule may prevent useful work even when the workflow is configured correctly.

For a local read-only connection and source-layout check, provide `TGCLOUD_TOKEN` securely through the process environment and run:

```sh
node serverless/tools/run-background-monitoring.mjs --app-id YOUR_NUMERIC_APP_ID --check
```

`--check` contacts only the official Telegram `/manage/get` endpoint, verifies the deployed version-1 monitoring access protocol, and validates the administrative dependency bundle. It does not execute the worker, create jobs, refresh providers, or prove that a future monitoring cycle will complete. It works before enabling the schedule. The ordinary CLI requires `BACKGROUND_MONITORING_ENABLED=true`; otherwise it exits as `disabled` without contacting Telegram. It accepts no endpoint, SQL, user identity, source path, or arbitrary operation argument.

## Pausing and recovery

Pause all rules or individual gifts in the app to stop their rule monitoring. To stop future scheduler launches, set the repository variable `BACKGROUND_MONITORING_ENABLED=false` or disable the workflow. To stop a running job immediately, cancel it in GitHub; a remote step already in progress may still finish and save its checkpoint. Uncertain in-flight work remains subject to the saved lease rather than being force-cleared.

Runs are serialized with `cancel-in-progress: false`; a new invocation does not cancel one already holding a checkpoint. After resolving a failure, use **Run workflow** to retry a failed, blocked, partial, or previously paused check without waiting for the next six-hour slot. The workflow sets a fixed manual-retry flag only for `workflow_dispatch`, and the runner sends it only on its first tick. It cannot bypass a successful check's normal due time, an active lease, a provider cooldown, or rules that remain paused. Repeated manual retries are rate limited. Do not delete checkpoints, lift request limits, or reset provider budgets to force progress. If the administration secret may have been exposed, rotate it through the hosting platform and update the environment secret before re-enabling the workflow.

GitHub schedules are best effort. Runs can be delayed or dropped under high load, and public-repository schedules are disabled after 60 days without repository activity. Scheduled workflows run only from the default branch. Hourly wake-ups provide more catch-up opportunities but cannot guarantee delivery. With on-time wake-ups, automatic checks are generally six to seven hours apart; provider and scheduler delays may extend that gap. Check Actions periodically and re-enable a disabled schedule when needed. See GitHub's [schedule behavior and limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Long gaps, incomplete rental history, or unavailable ownership evidence can delay suggestions or restart an idle observation period. Active gift rules need a maximum observation gap longer than the six-hour schedule; even an exact six-hour gap can be exceeded by scheduling or provider delays. The app warns about enabled, unpaused gifts whose effective gap is six hours or less and recommends the default 36 hours. It does not change saved settings automatically. The worker preserves the conservative rule checks instead of inventing activity during missed checks. No hosted storage allowance or successful unattended run is implied by installing this workflow.
