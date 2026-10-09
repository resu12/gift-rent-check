# Historical Telegram Serverless prototype

This document records the earlier prototype's design and limits. Use the [current Telegram pricing dashboard guide](telegram-serverless.md) for setup, configuration, import, deployment, and verification. The current build produces the pricing dashboard, and its old prototype collection entrypoints are disabled so they cannot bypass the shared Marketapp request ledger.

The prototype tested a private Mini App, server-side Marketapp GET requests, Telegram's persistent database, and durable Stop/Resume. It did not migrate the Python database, portfolio ownership checks, rental history, or price recommendations. The local dashboard worked independently. The behavior below describes that historical prototype; the current dashboard adds imported portfolio evidence, pricing comparisons, and a bounded TON-only price check on opening.

The UI collects at most **two pages per click**, ten listings per page by default. An optional mainnet collection address scopes a fresh run. Each endpoint performs at most one provider request. Keep the Mini App open to continue the current two-page batch; closing it prevents further browser-driven calls, although an already-sent request may finish. Reopening reads saved state without starting collection. **Continue 2 pages** resumes the original cursor. **Start new collection** begins at the head and retains earlier raw evidence in the cloud document. The prototype UI shows only the current run.

Rows are public listing observations, not verified portfolio members. Prices use exact integer nanoGRAM conversion and half-up three-decimal formatting. Overlapping pages retain their individual observations; the UI separately counts distinct exact NFT address strings. Canonical TON membership and all recommendation calculations remain in the Python application.

## Build and local tests in the current checkout

Use Node 24 for the local mock SQLite test server; the official deployment CLI requires Node 18+. The CLI is pinned to `@tgcloud/cli` **0.2.0**, with transitive versions in `serverless/pnpm-lock.yaml`. Frontend dependencies retain their existing lockfile.

From the project root:

```powershell
powershell -File scripts/build-serverless.ps1
```

Use `-Pnpm 'C:\path\to\pnpm.cmd'` if pnpm is not on PATH. This installs locked dependencies, runs backend/frontend tests, type-checks, and builds the current dashboard into `serverless/dist`. It does not publish or replace the local dashboard assets. For an unconfigured checkout, copying `serverless/private-config.example.js` to `serverless/tgcloud/lib/private-config.js` supplies empty values that deny access. Preserve any existing private configuration.

Optional local UI exercise, using synthetic data only:

```powershell
node serverless/tools/mock-server.mjs
```

Open `http://127.0.0.1:8766`. It uses an in-memory SQLite database and a mock Telegram user 42. It never reads the private module or calls Telegram/Marketapp. `MOCK_PORT` chooses another loopback port; `MOCK_DB` can select a disposable database to test process restarts. The mock tool and mock SDK are outside `tgcloud/` and the static build and are never deployed.

## Private configuration

Every data and control endpoint requires the platform-verified `ctx.initData.user.id` to match the configured human Telegram user ID. The browser never supplies the authoritative user ID. Missing configuration and other users fail closed before database or provider access. Telegram authenticates the caller; our allowlist restricts that authenticated caller to the owner.

No bot API token is required. To configure a new checkout or rotate the provider token, set `MARKETAPP_API_TOKEN` in the environment or root `.env`, then replace `YOUR_TELEGRAM_USER_ID` with your human Telegram user ID:

```powershell
& .\.venv\Scripts\python.exe scripts/configure-serverless.py --owner-id YOUR_TELEGRAM_USER_ID
```

Existing environment values take precedence over `.env`; `--owner-id` takes precedence over `TELEGRAM_OWNER_USER_ID`. The script atomically writes `serverless/tgcloud/lib/private-config.js` without printing secrets. This module is private backend code uploaded to Telegram when publishing. It is excluded from Git and never imported by the frontend. This configuration uses a backend module, not a runtime secret-store integration. Keep project/deployment access private.

Never paste tokens into frontend settings, source tracked by Git, screenshots, CLI arguments, or chat. The CLI can print complete source payloads under `TGCLOUD_DEBUG`; supplied login/publish wrappers disable that flag. Avoid `tgcloud diff` on the private configuration, and avoid sharing `.tgcloud` snapshots because they may include backend source and credentials.

## Deployment configuration

Follow the [current deployment instructions](telegram-serverless.md#credentials-and-deployment) when publishing from this checkout. The shared setup is:

1. In BotFather, open **@YOUR_BOT → Serverless**, enable it, and open **CLI Access → Access token**. Replace `YOUR_BOT` with your bot handle. This token starts with `app…:` and is separate from the bot API token.
2. Run the local login helper and enter that token at its prompt:

   ```powershell
   & .\scripts\login-serverless.ps1
   ```

   Login records credentials and the remote revision through the official CLI. It does not publish. On a clean checkout, install the locked serverless dependencies first with `pnpm --dir serverless install --frozen-lockfile`.
3. Inspect the file-name status (it does not print secret source), and review any existing bot modules before publishing:

   ```powershell
   & .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action status
   ```

4. Build, review, publish, and migrate using the current guide. Publishing uploads the selected schema, backend modules and static assets; it does not upload the local SQLite database. Targeted push preserves unrelated update handlers. Review conflicts with existing modules; never use `--force` to overwrite unknown remote work.
5. Set the Mini App URL in BotFather to the exact URL reported by the CLI, in the form `https://appYOUR_APP_ID.tgcloud.ai/`. Replace `YOUR_APP_ID` with the numeric app ID. Open it inside Telegram using your allowed account. Opening the static URL alone does not grant access to data.

Current export, import, verification, runtime-probe, and live-smoke tools require an explicit `--app-id YOUR_APP_ID`. The PowerShell publication/status/migration wrapper requires `-AppId YOUR_APP_ID`; its npm equivalents require `--app-id`. These commands reject mismatched credentials and custom API/beta destinations. Interactive login rejects inherited `TGCLOUD_TOKEN` values so the entered token controls its snapshot. Owner-context operations also require `--owner-id YOUR_TELEGRAM_USER_ID`. The normal deployment verifier and its `--full-response` mode require `--expect-portfolio` and `--expect-unresolved` counts from your reviewed dataset. See the current guide for complete commands; no personal destination is built in.

## Historical prototype smoke-test behavior

The prototype's manual check was to open it as the allowed user, verify the displayed Telegram account, and collect two pages; then confirm page counts and three-decimal prices, close/reopen, and verify that no request began automatically. Continue resumed the saved cursor, and Stop interrupted further steps. A second account had to be denied before reading any records. Interrupted endpoints required allowing the two-minute lease to expire before retrying. For the current dashboard, follow the current guide's smoke test: a fresh opening can start its separate TON price check.

A normal first click makes at most two successful listing requests (up to four attempts per page when retryable failures occur). The fixed provider route is GET `https://api.marketapp.org/v1/rent/gifts/`, with raw `Authorization`, `sort_by=recently_touch`, `limit`, optional `collection_address`, and opaque `cursor`. No transaction, paid discovery, price update, or wallet scan is implemented here.

## Persistence and recovery

The prototype stores historical runs, raw valid/invalid responses, normalized observations, cursors, retry counts, and provider deadlines in one bounded JSON document. A conditional SQLite UPDATE publishes the full new revision atomically; a lease fences concurrent browser calls and stale requests. This avoids assuming undocumented cross-call transaction support. Only safe projected fields reach the UI; raw response bodies stay server-side and echoed provider tokens are redacted.

Requests are paced at one per second across runs. Network failures, 429, and transient 5xx retry at most four times with exponential backoff and jitter. `Retry-After` survives Stop, Resume, and new runs. Stop prevents a pending page from advancing its checkpoint, while still preserving a later throttle deadline. Authentication, malformed data, cursor cycles, and exhausted retries stop for attention. Start fresh for a rejected cursor or failed traversal.

Each run is capped at 100 pages; responses are capped at 128 KiB, and the retained document is capped at 2 MiB across all runs. Reaching a prototype limit is not traversal completion and must not be bypassed by automatic retry. There is no destructive reset/export control in this first UI: after the storage cap, preserve the evidence through an explicitly reviewed administrative export before a subsequent storage migration. Missing metadata is shown as unknown, and completion records observations at different times rather than an instantaneous snapshot.

## Platform assumptions and historical limits

The [official Serverless documentation](https://core.telegram.org/bots/serverless) describes V8 JavaScript modules, an SQLite-backed database, outbound SDK fetch, and Mini App static hosting (added October 6, 2026). There are no runtime npm modules or filesystem APIs, and foreign keys are disabled. [Mini App Serverless calls](https://core.telegram.org/bots/webapps#serverless) carry platform-verified identity to endpoints.

The prototype did not rely on a documented scheduler, durable background queue, hard runtime request timeout, or fixed invocation duration/CPU allowance. Its browser used a callback watchdog without automatically repeating an uncertain write. The backend's two-minute lease is a concurrency recovery mechanism, not a guarantee that Telegram terminated an old HTTP call. SDK fetch follows redirects according to the pinned SDK reference; the prototype requests `redirect: 'error'` and rejects a changed final URL, but this does not independently verify the live SDK's redirect/header handling. The only request destination constructed by the prototype was the fixed Marketapp route.

The prototype had no continuous closed-app collection or TON decoder. The current dashboard includes a portable decoder and bounded TON price refresh, while full wallet discovery remains local. Neither design assumes reliable background work while the Mini App is closed. The local Python dashboard retains its own worker and separate request limits.
