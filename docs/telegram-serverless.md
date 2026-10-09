# Telegram pricing dashboard

## Personal rental analytics

The shared Overview can display wallet-scoped snapshots of Marketapp's personal rent analytics. Use **Refresh analytics** for the wallet-approved Telegram flow, or **Update analytics** to import a browser-captured JSON snapshot. Importing here sends the selected snapshot to this private Telegram backend; desktop snapshots remain local and are not synchronized automatically. Only the configured owner may import/read them. Volume is before fees and royalties, within the saved period; it is not net or lifetime income. **Reporting period** switches between separately saved windows, such as **Last 30 days** and **Last 1 year**. Chart grouping uses the selected snapshot's daily values; incomplete calendar years are marked partial. Switching periods or chart grouping makes no provider requests. See [capture, refresh, and storage details](personal-analytics.md).

Deployment requires the additive `personal_rental_analytics` table alongside the import endpoint and frontend; use the guarded safe migration for a checkout that does not have it yet. Existing cloud events remain unchanged. No personal snapshot is bundled in deployment assets. The snapshot parser/importer makes no provider requests; a separate owner-authorized refresh client uses the temporary website login described below.

### Refresh Marketapp analytics

In **Overview**, choose **Last 30 days** or **1 year** and press **Refresh analytics**. Choose your wallet, approve the Marketapp login, and keep the app open while the selected snapshot is read. The wallet must match the dashboard's saved mainnet address. Successful refresh saves a new immutable snapshot without changing prices, portfolio membership, comparison samples, or API collection counters. Failed refresh retains existing analytics. Desktop continues to use its signed-in-browser capture/import workflow.

A refresh uses a separate disposable TON Connect SDK 4.0.2 connector with Marketapp's public manifest. Its storage is in memory, SDK analytics/events are disabled, and SDK diagnostic logging is removed from the Telegram build. It does not restore or disconnect the ordinary Gift Rent Check wallet session. Approving this login sends the fresh account/proof/device reply to Marketapp's website authentication endpoint; it requests no transaction. Marketapp must explicitly return `verified: true`, and the returned analytics page must identify the saved wallet before a snapshot is accepted.

The session is used only for this explicit refresh. No authenticated cookie, proof, signature, wallet state-init, nonce, or full HTML is stored in the database or browser storage. A five-minute encrypted envelope carries the initial anonymous session between endpoints in volatile browser memory; after login, any rotated authenticated cookie remains in function memory only. Backend encryption uses the pinned public-domain [TweetNaCl.js 1.0.3](https://github.com/dchest/tweetnacl-js/tree/v1.0.3) secretbox implementation, with a privately generated 256-bit key and a unique attempt-bound nonce. Public assets are checked for both provider tokens and this key before publishing. Attempt metadata and challenge fingerprints remain owner-scoped, single-use, and independent of snapshots. Old attempt metadata is removed after 24 hours on the next start.

The owner-only `getMarketappAnalyticsRefreshStatus` endpoint reads fixed refresh progress from the existing attempt metadata. It makes no provider requests and consumes no login or collection allowance. The Mini App checks it on mount/return and polls only an already-submitted update for a bounded period; it never restarts authentication. Fixed failure codes survive a remount. A planned snapshot fingerprint links status to the exact committed snapshot, including a crash between snapshot insertion and the final status write. The fingerprint and diagnostic stages remain backend-only; the response contains state, selected period, attempt ID and observation time. No old consumed attempt with missing diagnostics is treated as a successful refresh.

Starts share a one-minute cooldown and five-per-hour allowance with the earlier compatibility tests; failures and cancellations count. A limited refresh shows whether the cooldown or hourly allowance applies and counts down from the database-calculated retry deadline. It enables Refresh when the wait ends without automatically requesting another approval or reading Marketapp. Each refresh makes at most three requests: anonymous homepage GET, one authentication POST, and one analytics GET. Authentication is never automatically retried. Website requests have bounded bodies/timeouts, manual redirects, and a fixed same-origin route allowlist. No provider API token is sent. The documented Marketapp API client remains GET-only and unchanged. Cancellation or navigation clears browser approval state; an already-sent backend request may finish. A new refresh needs a new approval.

Only the configured Telegram owner may start, finish, cancel, or read snapshots. Arbitrary URLs, another wallet, browser-supplied cookies, altered envelopes, reused attempts, and inconsistent analytics are rejected. Error codes contain fixed recovery text, never provider messages or supplied proof fields.

### Website integration evidence and limits

This integration is experimental because Marketapp has no documented personal-analytics API. Its public wallet bundle sends `{account, device, proof, ref}` to `/auth/checkTonProofAuth/`; the refresh sends `ref: null`. The analytics page exposes summary tiles and JSON chart attributes. The parser preserves numeric text and accepts only all-collection daily charts covering the requested 30 or 365 dates. Annual optional duration charts can be absent. The separately observed `profile.rent.durations` histogram is recognised and omitted from daily financial arithmetic; duplicate and unknown chart keys are still rejected. Login/markup changes fail safely. An annual refresh has been verified in the private Telegram app; every future refresh still requires a fresh wallet approval.

Validation on 9 October 2026 confirmed anonymous challenges, response-cookie forwarding, encrypted handoff and cancellation, plus complete mocked 30-day and annual refreshes in Telegram's runtime. A live wallet-approved annual refresh then confirmed provider login, page validation and snapshot storage. Approvals are single-use and cannot be reused for another refresh. No browser cookies are copied into Telegram. See the official [TON Connect protocol](https://github.com/ton-blockchain/ton-connect/blob/main/spec/connect.md) and [manifest specification](https://github.com/ton-blockchain/ton-connect/blob/main/spec/manifest.md).

The private Mini App reuses the main pricing screen and runs its price calculations and Marketapp collection in Telegram Serverless. Your PC is not needed for those operations. Keep the Mini App open while a collection runs: closing or hiding it stops further browser-driven steps; an already-sent request may finish. Each fresh opening shows saved data first, then automatically checks configured rent prices for existing portfolio gifts through TON Center. Marketapp collection still requires an explicit Start or Resume.

Every endpoint checks Telegram's platform-verified `ctx.initData.user.id` against the configured human owner ID before accessing data or providers. The browser cannot grant itself access by supplying an ID. The public static URL does not grant access to portfolio data.

Replace `YOUR_BOT`, `YOUR_TELEGRAM_USER_ID`, and `YOUR_APP_ID` below with your bot handle, your human Telegram user ID, and the numeric Serverless app ID reported by the official CLI. These are separate identifiers. Publishing, status, migration, import, export, and verification require an explicit app ID (`-AppId` in PowerShell or `--app-id` in Node commands). Credentials for another app are rejected; import also checks the reviewed manifest's destination. A checkout has no preconfigured deployment target.

## Included

- New openings default to **Actual rentals**, **Last 30 days**, and **Biggest increase first** (recommended daily price minus current asking price, descending). Changing these filters reads saved data only; the independent startup price check is described below.
- **Simple** is the default pricing view on Telegram and desktop: two columns on mobile, large gift images, gift name, current saved daily price and recommended daily price. Prices use three decimals; unavailable values remain dashes. Tap a card for the full evidence and comparisons, or choose **Detailed** beside **Your gifts** for the original table. The view preference is remembered on the device.
- Price source and timeframe stay visible. Search and exact Black selection sit above the grid; collection, recommendation status and sorting are under **Filters**. **Refresh & export** contains collection controls and collapsed limits. Sync cards remain visible when it is closed, with a brief purpose, completed-collection or gift-check percentage, and Stop/Continue. Technical counters and cache notes are under **Details**. Percentages describe completed checks, not time remaining; unknown discovery totals use an indeterminate bar. See [reading sync progress](dashboard.md#reading-sync-progress). Expansion is retained across saved-data updates and timeframe changes. Scrolling reveals more cards automatically.
- Jobs waiting for explicit Continue use the idle saved-data polling interval (15 seconds); active collection polls every 2.5 seconds. These reads do not request Marketapp data.
- Listing averages or observed actual-rental daily rates, including eligible owned gifts.
- Collection, model, and exact **Black** comparisons. Selecting Black also scopes the collection average to Black.
- Default 30 days; 24 hours, 7, 60, 90 days, or at most 90 inclusive UTC dates. No automatic expansion for sparse samples.
- Three-decimal display, recommendation-gap sorting, recorded rental counts, progressive rows, and local CSV export of the displayed calculations.
- Preserved imported membership, unresolved candidates, collection conflicts, labels, dated asking-price evidence and ownership provenance.
- Separate read-only listing and rental-history collection. Generic market collection includes both.

Ownership and TON metadata remain imported snapshots. This release does not re-run TON discovery or enroll new acquisitions. The startup check reads current holders and supported contracts only to validate price evidence; it does not refresh portfolio membership, ownership status, traits, or marketplace visibility. An absent listing retains its last asking-price evidence with its timestamp. Rental-model comparisons retain the local app's freshness rules: old traits can remain visible without qualifying for a model-specific recommendation. Refresh the local evidence and import another reviewed snapshot when necessary.

Recorded rental counts cover saved, unambiguous rental starts, regardless of the selected pricing timeframe; unknown does not mean zero. Rental daily rates use `price * 86400 / duration` under the observed `marketapp-rent-history-ui-v1` interpretation. They are not proof of completion or income received. Conflicting variants, unverified extensions, inconsistent GRAM amounts, and other currencies are excluded. See [pricing methodology](pricing.md).

## Automatic owned-gift price check

On each fresh Mini App page opening, after the saved dashboard loads and the page is visible, one independent TON check freezes the existing eligible portfolio addresses. It reads NFT holders, batches their supported rental contracts, and rechecks NFT holder/logical time before committing prices. It makes **zero Marketapp requests**, performs no wallet/transfer discovery, reads no rental history or collection catalog, and does not refresh comparison samples. A background preload waits for first visibility. Hiding an already-running check interrupts further steps; reopening starts or safely joins a bounded check. Merely returning to the same hidden page does not restart it. The [desktop dashboard](dashboard.md#automatic-rent-price-check) shares the same frontend driver, startup gate, status display, and Stop control; enable it with `--allow-price-refresh`. The two versions keep separate databases and request ledgers.

Only the settings field `configured_price_per_day_raw` is converted exactly from nanoGRAM. The active rental's payment rate is never substituted. Values are labelled **Observed contract terms** with their account-read timestamp; the later holder-check timestamp is recorded separately. Contract terms do not prove Marketapp listing visibility or settings propagation between original and derived contracts. Both pinned variants in [the decoder notes](../serverless/tests/fixtures/ton-price-decoder.md) are supported. Directly held NFTs and unknown contracts retain their previous dated prices with uncertainty.

The TON budget is independent of Marketapp: 50 addresses per batch, one request/second, at most 60 attempts and 120 seconds per run, three attempts per request, and 1,000 attempts per rolling 24 hours. All requests are GETs to TON Center mainnet `/api/v3/nft/items` or `/api/v3/accountStates`; no Marketapp token is sent. Retry deadlines and a two-minute in-flight lease prevent overlapping requests across page openings. A fresh page session is idempotent; another open view joins the same active run. Stop check affects only this price check. Saved data remains usable on provider failure.

The transport requests a 20-second timeout and uses cancellation where available. Telegram's SDK does not document a hard timeout guarantee, so late responses are rejected using the trusted server clock, and the lease prevents an immediate overlapping retry.

Aggregate-only verification commands (the second intentionally performs a new bounded check):

```powershell
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --summary
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --smoke
```

## Connect and disconnect a wallet

The wallet control can open **TON Connect** to approve a read-only connection in your wallet app, including compatible wallets launched through Telegram. It supports TON mainnet. Disconnect removes that connection from this browser; it keeps the saved portfolio and its refresh behavior. Reconnecting does not import gifts, change portfolio membership, or start a wallet scan. The saved dashboard remains tied to the wallet in its imported dataset, and a different connected wallet is identified separately so its address cannot relabel those gifts.

Telegram's verified owner ID still controls access to backend data. The app requests no transaction, message signature, or `ton_proof`; the connected address is informational and grants no backend authorization. Do not treat this optional connection as proof that a visitor owns the saved portfolio. A device may restore its previous TON Connect session when the app opens.

Set these **public** frontend settings before building for your deployment. Existing environment values override `frontend/.env.local`. A sample is in `frontend/.env.example`; never put API keys in any `VITE_` setting.

```powershell
$env:VITE_TONCONNECT_APP_URL = 'https://appYOUR_APP_ID.tgcloud.ai'
$env:VITE_TELEGRAM_RETURN_URL = 'https://t.me/YOUR_BOT?startapp'
& .\scripts\build-serverless.ps1 -Pnpm 'C:\path\to\pnpm.cmd'
```

Use the app's HTTPS origin with no path, query, credentials, or fragment. The optional return URL must be a `https://t.me/YOUR_BOT?startapp` Mini App link; omit it if the bot has no configured Main Mini App. Configured builds emit a public `/tonconnect-manifest.json` and a 180 × 180 PNG icon. Both must be reachable over HTTPS without authentication and allow cross-origin reads. The manifest identifies **Gift Rent Check**, the deployed origin, and its icon. The publish guard rejects a manifest for any app other than the explicit `-AppId` target.

Without `VITE_TONCONNECT_APP_URL`, builds leave wallet connections disabled, which keeps fresh checkouts and CI portable. The local Python dashboard continues to use its configured saved wallet. TON Connect does not add cloud wallet discovery or change the read-only provider API restrictions. See the official [TON Connect manifest requirements](https://docs.ton.org/applications/ton-connect/core-concepts#manifest).

## Marketapp request limits

| Limit | Default |
| --- | --- |
| Marketapp attempts per Start/Resume | 100 |
| Rolling 24-hour attempts in this cloud database | 500 |
| Elapsed time per Start/Resume | 300 seconds |
| Request pace | At most one per second |
| Attempts per request, including first | 4 |
| Page size for new runs | 100 |

Retries and catalog requests count. Counters and provider retry deadlines survive reopening, new jobs, resumes, and deployments. The upgrade conservatively inherits recent prototype attempts. The old prototype's collection entrypoints are disabled so they cannot bypass the ledger. These are conservative application limits, not a published Marketapp quota or a guarantee against restriction.

Only authenticated GET requests to `/v1/collections/gifts/`, `/v1/rent/gifts/`, and `/v1/rent/gifts/history/` are constructed. Collections come from imported portfolio addresses, in stable address order. New runs fetch the catalog first, then rotate among collections after each committed page before reading deeper. Retries stay with their original request. The saved schedule and cursors survive interruption; older runs retain their original sequential schedule. An initial sample does not mean the collection is fully checked. Coverage is partial until the saved streams complete. Fresh collection starts at the head; Resume freezes the original scopes, page size, and timeframe. History stops after a valid descending page crosses the selected lower boundary; empty continuation pages continue, equality retains ties, and ordering anomalies disable the cutoff shortcut. Requests are bounded even if ordering is unreliable.

New Telegram jobs request 100 records per page, matching desktop pricing jobs. Existing paused jobs retain their original page size (including 10). The legacy-run notice offers **Start efficient refresh**, which starts a new run from the head using the saved timeframe choice and current defaults; it retains existing observations. **Continue** still resumes the original traversal. The one-request-per-second pace and all attempt, daily, and response-size caps remain unchanged. Larger pages reduce request overhead; they do not raise your allowance.

### Incremental rental history

Desktop and Telegram use the same versioned policy, with separate local/cloud coverage records. The first new-policy scan reads the entire selected window for each collection. Only an ordered, completed stream establishes reusable coverage; imported records, old runs without policy metadata, interrupted scans, and ambiguous ordering do not establish it.

Later refreshes still start at the head, but stop after crossing the previous scan's start time minus a **48-hour overlap**, or the requested window's lower bound if that is newer. Older saved records continue to participate in the same selected pricing window. Every returned page is stored intact, equal timestamps at the boundary are retained, and replayed representations do not add duplicate votes. Changed representations remain available and follow the existing ambiguity rules. A first duplicate never ends traversal.

After **seven days** from the last full scan's start, the next requested refresh scans the full selected window again. Incremental scans never postpone that deadline. A wider window, a new collection, invalid coverage, or a boundary already reached by the overlap also requires a full-window scan. Nothing runs on a schedule. Backfilled or corrected events older than the overlap may remain unseen until a deeper scan; incremental completion is not a newly downloaded full-window snapshot.

Each run freezes its per-collection plan and baseline provenance. Resume preserves that plan even if the seven-day interval passes or the displayed dates change. An unfinished or failed stream cannot advance reusable coverage. Saved job details show how many collections use recent updates and how many require a full-window scan. Existing observations, rental counts, selected timeframes, and membership are retained.

### Shared market cache

New Telegram jobs can reuse completed listing and compatible history traversals for **one hour**, measured from the source stream's first actual provider observation. Completion and cache reuse do not extend expiry. A traversal that already exceeds one hour is not reusable. The status shows when recent saved scans are reused and their age; original observation timestamps remain unchanged. **Force fresh comparison data** starts a new job that bypasses cache reuse, while retaining normal request limits and cooldowns. It can populate the cache with newly completed scans. The catalog is fetched afresh once per new job, even if every market stream uses cached coverage.

The cache index contains public request scopes, source references, original observation times, and coverage bounds. Personal wallet settings, portfolio membership, labels, and TON ownership evidence are excluded. Existing provider records remain the comparison source; reuse creates no duplicate pages or observations and never makes old data appear newly observed. Public listing owners and history parties remain in the original provider records. The cache stays behind private Telegram authorization; this change does not enable public users.

Only fully committed, valid traversals qualify. Incomplete scans and unordered or scope-conflicting history cannot populate the cache. Cached history must cover the new scan's required lower boundary and selected window. Incremental coverage cannot replace a wider or weekly full scan. Cache reuse never advances `checked_through` or `full_scan_at`; the original history baseline remains unchanged.

Cache decisions and source references freeze when a new job starts. Resume keeps that evidence even if the cache later expires. Job details show reused streams and their original observation time. Reused streams consume no provider requests or allowance; fresh requests and retries retain the existing shared Telegram ledger, pacing, and cooldowns. No scheduler is introduced.

The cache is **Telegram-only**, as selected for this release. Desktop remains separate and cannot share Telegram's allowance. Leave desktop `--allow-network` off while using Telegram for Marketapp collection; `--allow-price-refresh` still enables the separate TON-only owned-price check.

`Retry-After` applies across jobs. Authentication failures, malformed pages, cursor cycles, and rejected cursors stop collection without advancing that page. A rejected cursor requires a new collection. An in-flight lease prevents overlap; after an interruption, allow up to two minutes for it to expire before resuming. The current SDK does not document a configurable network timeout or cancellation primitive; the five-minute allowance prevents starting further requests, and the lease fences late results. It cannot force an already-sent SDK request to finish at exactly 30 seconds.

### Explicit one-day allowance reset

There is no recurring reset or reset button in the Mini App. When the owner explicitly requests a one-off reset, the private administrative tool can exclude the requests already made from allowance accounting until midnight **Europe/Berlin**. This is an application allowance reset, not a change to Marketapp's provider limits. The append-only request history, per-start limit, request pace, and provider cooldown remain intact. New requests count normally; the normal rolling 24-hour calculation resumes at midnight, including any prior requests still within that window. The reset starts no collection.

```powershell
node serverless/tools/reset-market-budget.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID `
  --reset-id YOUR_UNIQUE_RESET_ID --confirm-reset-today
```

The tool validates the Telegram destination, requires owner authorization and no active request lease, and appends an idempotent event. Retry an uncertain result only with the same reset ID. A second distinct reset for the same date is rejected. The operation is not deployed as a callable Mini App endpoint.

Production timing uses SQLite wall time refreshed around database commits and provider responses. This prevents the runtime's JavaScript clock behavior from shortening retry delays or accepting an expired lease. Failure to read trusted time stops new provider requests. Lease fencing protects committed state; it cannot cancel an old transport request if the platform leaves it running.

**Use one active collector.** Desktop, CLI, and Telegram do not share an account-wide request ledger. Leave the local dashboard without `--allow-network` when using Telegram for collection; otherwise the two independent allowances can add together. No scheduler, automatic notifications, paid discovery, or price-changing function is enabled.

## Storage and migration

The existing `collector_state` prototype table remains intact. The additive `cloud_events` table stores immutable event chunks, compact run/checkpoint state, normalized evidence, raw valid and invalid responses, and request reservations. One conditional SQLite INSERT publishes each page's raw evidence, records and next cursor atomically. It does not rely on transactions spanning separate SDK calls. Compare-and-set revisions and leases fence concurrent calls and stale responses.

Import chunks have stable identifiers, content checks, and bounded size. Identical replay is acknowledged; conflicting replay is rejected. The seed compacts identical listing/history representations while preserving observation times and occurrence counts. Changed variants remain distinct. Original page occurrences remain in the local SQLite database. Reads never call Marketapp. Stored JSON keeps monetary strings, original source fields, and the missing/null distinction.

The dashboard reads normalized evidence in batches of at most five event chunks, with a 1 MiB combined UTF-8 budget, and calculates only the selected view in memory. A single oversized legacy chunk is read alone so traversal can still advance. New provider pages must fit both the raw and normalized 1 MiB caps before progress commits. This keeps larger pages from creating oversized host responses. Address, timestamp, and trait normalization is cached only within an individual calculation; caches are discarded afterward. It avoids the prototype's 2 MiB document cap, but it is not an unbounded data warehouse. Monitor growth before long-term collection. Raw responses are excluded from dashboard reads. Historical prototype behavior is documented in [telegram-serverless-prototype.md](telegram-serverless-prototype.md).

## Build and verify

Use Python 3.12+ and Node 24 for local SQLite tests. The official CLI remains pinned to `@tgcloud/cli` 0.2.0.

```powershell
& .\.venv\Scripts\python.exe -m pytest
& .\scripts\build-serverless.ps1 -Pnpm 'C:\path\to\pnpm.cmd'
```

The build runs frontend/backend tests and creates `serverless/dist`. It does not replace local dashboard assets or publish. A mock-only UI is available with `node serverless/tools/mock-server.mjs` at `http://127.0.0.1:8766/`. It uses synthetic gifts, SQLite, a fake Telegram user, and fake provider responses. It never reads production credentials or contacts providers. `/mock-metrics` reports mock request counts.

## Prepare and import private data

Preparing an export is entirely local and opens the source SQLite database read-only:

```powershell
& .\.venv\Scripts\python.exe -m marketapp_rent.serverless_export `
  --db data/marketapp.sqlite3 `
  --app-id YOUR_APP_ID --out data/telegram-seed --days 90
node serverless/tools/import-seed.mjs --app-id YOUR_APP_ID --manifest data/telegram-seed/manifest.json
```

Review `manifest.json` before upload and check its destination app ID. If you have a separate reviewed ownership export, supply its directory with the exporter's optional `--review-directory` argument. The seed contains wallet/NFT addresses, portfolio and unresolved evidence, names/labels/image links, saved relevant prices/history, structured traits, timestamps and provenance. It excludes credentials, raw TON account/contract state, raw provider pages, and filesystem paths. Public comparison history is limited to the exported 90 days; owned-gift history also includes older saved records for counts. Exporting does not enroll unresolved candidates.

The second command above validates and previews without network access. After approval of that exact dataset, use the approval_sha256 printed by the preview (the hash of the exact manifest, which binds its chunk hashes):

```powershell
node serverless/tools/import-seed.mjs `
  --app-id YOUR_APP_ID `
  --manifest data/telegram-seed/manifest.json `
  --approve-sha256 REVIEWED_MANIFEST_SHA256 --owner-id YOUR_TELEGRAM_USER_ID --max-chunks 50
```

Repeat the same command until `finished` is true. It uses the official CLI authentication/API helpers, sends records only to the linked Telegram app, records acknowledgements in `upload-receipt.json`, and makes no Marketapp requests. Stop active collection before import. A lost acknowledgement can safely replay the same chunk. Keep the manifest and receipt; do not rebuild a different dataset under an old approval. Data and receipts belong under ignored `data/` or `exports/`, never in static assets or source control.

For a local numerical cross-check against the Python database:

```powershell
& .\.venv\Scripts\python.exe scripts/check-cloud-pricing.py `
  --db data/marketapp.sqlite3 `
  --manifest data/telegram-seed/manifest.json --out data/cloud-pricing-expected.json
```

The administrative read-only verifier executes the deployed source against its actual database, checks all four pricing selections and rejects missing or foreign owner contexts, without advancing the database or provider ledger. Replace the expected-count placeholders with counts from your reviewed dataset; the normal verifier and `--full-response` mode require both counts explicitly:

```powershell
node serverless/tools/verify-deployment.mjs `
  --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID `
  --expect-portfolio EXPECTED_PORTFOLIO_COUNT --expect-unresolved EXPECTED_UNRESOLVED_COUNT
```

`--diagnostic` inspects the deployed runtime without requiring expected membership counts. The synthetic runtime probe needs only `--app-id`; it makes no provider requests or database writes:

```powershell
node serverless/tools/runtime-probe.mjs --app-id YOUR_APP_ID
```

These checks exercise endpoint code with an administrative test context. Opening **@YOUR_BOT → Open app** in Telegram remains the client authentication and display check.

## Credentials and deployment

The provider token and human owner ID belong in ignored `serverless/tgcloud/lib/private-config.js`. They are private backend code and must never enter the frontend bundle. No bot API token is required. To configure a new checkout, set `MARKETAPP_API_TOKEN` in your local environment or root `.env`, then run:

```powershell
& .\.venv\Scripts\python.exe scripts/configure-serverless.py --owner-id YOUR_TELEGRAM_USER_ID
```

Generate the separate private refresh-encryption key once with `node serverless/tools/prepare-refresh-key.mjs`. The ignored key module is deployed only as backend code. The generator retains an existing key and prints no key material. Rotating or removing it invalidates pending refresh envelopes; saved snapshots remain available.

Environment values take precedence over `.env`; `--owner-id` takes precedence over `TELEGRAM_OWNER_USER_ID`. The script writes the private module without printing credentials. For an unconfigured local checkout, copying `serverless/private-config.example.js` to that path supplies empty values that deny access; never overwrite an existing private configuration just to run local tests.

In BotFather, open **@YOUR_BOT → Serverless**, enable it, and obtain the **CLI Access → Access token**. Log in through `scripts/login-serverless.ps1` and enter that token at its prompt; the Serverless CLI token is different from the bot API token. On a clean checkout, install the locked CLI dependencies first with `pnpm --dir serverless install --frozen-lockfile`. All supplied publishing/import helpers disable `TGCLOUD_DEBUG`, which otherwise can log private source payloads. Do not print private config or `.tgcloud` snapshots.

```powershell
& .\scripts\login-serverless.ps1
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action status
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action publish
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action migrate-check
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action migrate-safe
```

These wrappers and the `serverless/package.json` commands use the same destination guard. It rejects custom `TG_CLOUD_API_URL` values and `TGCLOUD_BETA` before importing the CLI, then checks the resolved token against the explicit app ID. An inherited `TGCLOUD_TOKEN` takes precedence over saved credentials and must match; it never silently falls back to a different saved login. The validated token is pinned for the command, including status and migration. No token is printed or passed in command-line arguments.

Interactive login asks for its own token and refuses a nonempty `TGCLOUD_TOKEN`; unset that variable first so snapshot synchronization uses the token you enter. Remove custom API/beta overrides before using these production helpers. For direct Node/pnpm use, for example, `pnpm --dir serverless status --app-id YOUR_APP_ID` and `pnpm --dir serverless push --app-id YOUR_APP_ID` use the same checks. Login itself requires no app ID; later operations check the ID you supply. Use these guarded entrypoints instead of invoking the underlying deployment CLI directly.

Publishing targets schema, library, endpoints and static assets, preserving unrelated bot modules. Review conflicts; do not force an unknown remote revision. Migration is additive. Configure your bot's **Open app** menu or Main Mini App to use the exact URL reported by the CLI, in the form `https://appYOUR_APP_ID.tgcloud.ai/`.

For live validation, open the private dashboard with no active Marketapp collection and confirm that opening triggers only the bounded TON price check described above, with zero Marketapp requests. Start one manual listing collection, stop after a small number of requests, reload, and verify persisted counters and cursor. Resume explicitly; confirm completion/partial coverage remains distinct. Rejected callers must receive no portfolio data. Keep live verification bounded; unit and parity tests need no provider requests.

The administrative Marketapp smoke test requires explicit app and owner IDs plus a confirmation flag. It performs at most two collection step calls, with Stop/Resume between them; retry rules still apply:

```powershell
node serverless/tools/live-smoke.mjs `
  --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --confirm-two-requests
```

Telegram's [Mini App Serverless API](https://core.telegram.org/bots/webapps#serverless) supplies verified identity to endpoints. Runtime/database details are documented in the pinned CLI's `src/templates/docs/tgcloud-sdk.md` and the [official Serverless documentation](https://core.telegram.org/bots/serverless). Background scheduling and reliable work while the Mini App is closed are not assumed.
