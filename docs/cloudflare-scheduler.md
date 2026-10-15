# Independent cloud monitoring scheduler

`serverless/scheduler/worker.mjs` adds a Cloudflare Cron trigger so closed-app monitoring does not depend solely on GitHub's scheduled-event delivery. It wakes every 15 minutes, at minutes **7, 22, 37, and 52 UTC**, and dispatches the existing monitoring workflow. The hourly GitHub cron remains a fallback. No phone, browser, or desktop process needs to stay open.

The trigger does not perform gift checks itself. GitHub still runs the bounded monitoring driver, and Telegram retains the gifts, rules, provider credentials, checkpoints, and approval queue. The six-hour minimum between automatic cycles and wallet approval for every proposed price change remain unchanged. An accepted dispatch is not a completed check, and this architecture does not remove dependence on GitHub runner availability.

## Fixed operation and credentials

The only dispatch target is `resu12/gift-rent-check`, workflow `background-monitoring.yml`, branch `main`, with this fixed body:

```json
{"ref":"main","inputs":{"scheduled":true}}
```

The boolean `scheduled` input defaults to false for a human **Run workflow**. The workflow grants the manual retry exception only for `workflow_dispatch` with `inputs.scheduled != true`. Cloudflare always sends true, so it cannot use that exception to run a failed or partial cycle repeatedly before the normal due time. Merge this workflow change into protected `main` before activating the trigger.

Create a dedicated **fine-grained GitHub personal access token** with resource owner `resu12`, repository access **Only select repositories → gift-rent-check**, and repository permission **Actions: read and write**. Leave unrelated permissions ungranted; GitHub supplies required metadata access. Choose an expiry and arrange rotation before it expires. The workflow dispatch API requires Actions write permission; read permission supports the active-run checks. See [GitHub's dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Store this token only as the Cloudflare Worker secret `GITHUB_MONITORING_TOKEN`. Never copy the Telegram administration credential, bot token, Marketapp session, wallet key, or general-purpose GitHub credential into Cloudflare. The Worker's code restricts calls to one workflow, but its token has Actions authority across the selected repository; it is not a token restricted by GitHub to a single workflow. Protect it accordingly. Keep `TGCLOUD_TOKEN` in the existing GitHub `price-monitoring` environment.

The Worker has no public trigger: `workers.dev` and preview URLs are disabled, and its HTTP handler returns 404. Its requests stay on the fixed GitHub API origin, reject redirects, and use bounded time and response sizes. Logs contain only fixed states, dates, request counts, and HTTP status codes. They omit credentials and upstream response bodies.

## Deploy and activate

Run these commands from the repository root with an approved Wrangler installation. Use the intended Cloudflare account and verify its account selection during login. No account identifier or credential belongs in this repository.

1. Merge the reviewed scheduler source and updated workflow into protected `main`. Confirm the live workflow includes the `scheduled` boolean input and the manual-retry guard above. Confirm `BACKGROUND_MONITORING_ENABLED=true`, that the workflow is active, and that the `price-monitoring` environment allows the intended default-branch run without a per-run approval. Preserve existing branch and environment protections.
2. Authenticate to Cloudflare and deploy the disabled Worker from the committed configuration:

   ```sh
   npx wrangler login
   npx wrangler deploy --config serverless/scheduler/wrangler.jsonc
   ```

   The configuration deliberately sets `SCHEDULER_ENABLED` to `"false"`. A disabled wake performs no GitHub request. Keep the committed default disabled to prevent accidental activation in another account.
3. Add the dedicated GitHub token using Wrangler's secret prompt; paste the value at the prompt, never into a command argument or source file:

   ```sh
   npx wrangler secret put GITHUB_MONITORING_TOKEN --config serverless/scheduler/wrangler.jsonc
   ```

   Alternatively, use **Workers & Pages → gift-rent-monitoring-scheduler → Settings → Variables and Secrets**, choose type **Secret**, and deploy the change. Secret updates deploy a new Worker version. See [Cloudflare secret handling](https://developers.cloudflare.com/workers/configuration/secrets/).
4. Enable the intended production deployment explicitly:

   ```sh
   npx wrangler deploy --config serverless/scheduler/wrangler.jsonc --var SCHEDULER_ENABLED:true
   ```

   Confirm the deployed variable is the string `true` and the deployed cron is `7,22,37,52 * * * *`. Include the explicit enabled variable on subsequent production deploys; an ordinary deploy uses the disabled value from the committed configuration. Keep HTTP routes disabled.
5. Verify the complete path below. A successful Worker deployment alone is not evidence of an unattended monitoring cycle.

Cron changes can take up to 15 minutes to propagate. Cloudflare cron uses UTC, so daylight-saving changes do not alter these minute offsets. Manage the cron in `wrangler.jsonc`; later Wrangler deployments replace the configured trigger list. See [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Verify the scheduled path

Keep the app closed during the check being verified. In Cloudflare, inspect the Worker's Cron Events and Worker Logs after a scheduled wake. Look for `event: "cloud-monitoring-scheduler"` and its state; do not treat the invocation's platform success alone as proof of dispatch. New-worker Cron Events can appear later than the actual invocation; Worker Logs and GitHub run timestamps provide additional evidence.

| Scheduler state | Meaning and next check |
| --- | --- |
| `disabled` | No request was made. Check the deployed `SCHEDULER_ENABLED` value. |
| `busy` | An existing workflow is queued, running, or waiting. Inspect it in GitHub, including any environment approval. |
| `recent_dispatch` | A dispatch was observed within the last ten minutes. Inspect that GitHub run. |
| `dispatched` | GitHub accepted the fixed workflow dispatch. Verify the resulting run and its worker result. |
| `blocked` | No successful dispatch was confirmed. Inspect the fixed reason and HTTP status, then token permissions/expiry, rate limits, or GitHub availability. |

In **GitHub → Actions → Background price monitoring**, find the corresponding `workflow_dispatch` run on `main`. Confirm the worker step has `BACKGROUND_MONITORING_MANUAL_RETRY: false`. If the six-hour due time has not arrived, the runner should exit quickly with the previous result and `retry_at`; this is expected and must not be presented as a fresh completed check.

For a check that is due, verify the workflow reaches its terminal result and that the Telegram app's saved **Latest run started**, **Latest run finished**, and **Last complete check** advance to this new cycle. A green GitHub job with `partial` output still means unfinished provider work. If the result is blocked or incomplete, inspect the existing monitoring reason instead of deleting its checkpoint or resetting provider limits.

The scheduler checks active states separately and suppresses recent dispatches, but this is not an atomic reservation. A GitHub cron trigger or another invocation can race with it. Delivery is not guaranteed exactly once: the workflow's concurrency group and the monitoring worker's durable lease, checkpoints, and six-hour due-time checks prevent overlapping provider work. A timeout after dispatch is logged as an unknown outcome; there is no immediate POST retry. Inspect GitHub before attempting manual recovery.

## Pause, recover, and rotate

To pause only Cloudflare dispatches, deploy its disabled setting:

```sh
npx wrangler deploy --config serverless/scheduler/wrangler.jsonc --var SCHEDULER_ENABLED:false
```

GitHub's hourly fallback continues. To prevent monitoring jobs from **both** triggers, also set the repository variable `BACKGROUND_MONITORING_ENABLED=false` or disable the workflow. Pause all rules in the app when you want monitoring policy paused as well. None of these actions cancels a job already running; cancel it in GitHub if required, allowing any in-flight remote request and saved lease to settle.

For token rotation, pause Cloudflare dispatches, create a replacement with the same selected repository and Actions-only permissions, replace `GITHUB_MONITORING_TOKEN` with the secret command above, and enable the Worker. Verify a scheduled dispatch before revoking the old token. If compromise is suspected, revoke the old token immediately rather than waiting for verification. Do not change or copy `TGCLOUD_TOKEN` as part of scheduler-token rotation.

After resolving a provider or credential failure, a human may use **Run workflow** with **scheduled** unchecked for the existing bounded manual retry. Automatic Cloudflare dispatches always keep it checked. Do not shorten the six-hour cadence, bypass a paused rule, or remove a provider cooldown to force a result.

The independent trigger improves delivery opportunities; it is not a service-level guarantee. GitHub API/runner outages, workflow disablement, environment approvals, expired tokens, Cloudflare failures, and provider limits can still delay a check. The dashboard displays the last saved monitoring result and does not continuously attest to either scheduler's configuration.
