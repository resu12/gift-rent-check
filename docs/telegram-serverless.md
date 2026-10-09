# Telegram pricing dashboard

The private Mini App reuses the main pricing screen and runs its price calculations and Marketapp collection in Telegram Serverless. Your PC is not needed for those operations. Keep the Mini App open while a collection runs: closing or hiding it stops further browser-driven steps; an already-sent request may finish. Each fresh opening shows saved data first, then automatically checks configured rent prices for existing portfolio gifts through TON Center. Marketapp collection still requires an explicit Start or Resume.

Every endpoint checks Telegram's platform-verified `ctx.initData.user.id` against the configured human owner ID before accessing data or providers. The browser cannot grant itself access by supplying an ID. The public static URL does not grant access to portfolio data.

Replace `YOUR_BOT`, `YOUR_TELEGRAM_USER_ID`, and `YOUR_APP_ID` below with your bot handle, your human Telegram user ID, and the numeric Serverless app ID reported by the official CLI. These are separate identifiers. Publishing, status, migration, import, export, and verification require an explicit app ID (`-AppId` in PowerShell or `--app-id` in Node commands). Credentials for another app are rejected; import also checks the reviewed manifest's destination. A checkout has no preconfigured deployment target.

## Included

- New openings default to **Actual rentals**, **Last 30 days**, and **Biggest increase first** (recommended daily price minus current asking price, descending). Changing these filters reads saved data only; the independent startup price check is described below.
- **Grid** is the default Telegram pricing view: two columns on mobile, large gift images, gift name, current saved daily price and recommended daily price. Prices use three decimals; unavailable values remain dashes. Tap a card for the full evidence and comparisons, or choose **Detailed** for the original table. The view preference is remembered on the device.
- Price source and timeframe stay visible. Search and exact Black selection sit above the grid; collection, recommendation status and sorting are under **Filters**. Collection controls, limits and full saved-progress cards are inside **Refresh prices & activity**. When collapsed, paused runs show only a saved-progress hint; an active collection retains a compact Stop control. Expansion is retained across saved-data updates and timeframe changes. Scrolling reveals more cards automatically.
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

On each fresh Mini App page opening, after the saved dashboard loads and the page is visible, one independent TON check freezes the existing eligible portfolio addresses. It reads NFT holders, batches their supported rental contracts, and rechecks NFT holder/logical time before committing prices. It makes **zero Marketapp requests**, performs no wallet/transfer discovery, reads no rental history or collection catalog, and does not refresh comparison samples. A background preload waits for first visibility. Hiding an already-running check interrupts further steps; reopening starts or safely joins a bounded check. Merely returning to the same hidden page does not restart it.

Only the settings field `configured_price_per_day_raw` is converted exactly from nanoGRAM. The active rental's payment rate is never substituted. Values are labelled **Observed contract terms** with their account-read timestamp; the later holder-check timestamp is recorded separately. Contract terms do not prove Marketapp listing visibility or settings propagation between original and derived contracts. Both pinned variants in [the decoder notes](../serverless/tests/fixtures/ton-price-decoder.md) are supported. Directly held NFTs and unknown contracts retain their previous dated prices with uncertainty.

The TON budget is independent of Marketapp: 50 addresses per batch, one request/second, at most 60 attempts and 120 seconds per run, three attempts per request, and 1,000 attempts per rolling 24 hours. All requests are GETs to TON Center mainnet `/api/v3/nft/items` or `/api/v3/accountStates`; no Marketapp token is sent. Retry deadlines and a two-minute in-flight lease prevent overlapping requests across page openings. A fresh page session is idempotent; another open view joins the same active run. Stop check affects only this price check. Saved data remains usable on provider failure.

The transport requests a 20-second timeout and uses cancellation where available. Telegram's SDK does not document a hard timeout guarantee, so late responses are rejected using the trusted server clock, and the lease prevents an immediate overlapping retry.

Aggregate-only verification commands (the second intentionally performs a new bounded check):

```powershell
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --summary
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --smoke
```

## Marketapp request limits

| Limit | Default |
| --- | --- |
| Marketapp attempts per Start/Resume | 100 |
| Rolling 24-hour attempts in this cloud database | 500 |
| Elapsed time per Start/Resume | 300 seconds |
| Request pace | At most one per second |
| Attempts per request, including first | 4 |
| Page size | 10 |

Retries and catalog requests count. Counters and provider retry deadlines survive reopening, new jobs, resumes, and deployments. The upgrade conservatively inherits recent prototype attempts. The old prototype's collection entrypoints are disabled so they cannot bypass the ledger. These are conservative application limits, not a published Marketapp quota or a guarantee against restriction.

Only authenticated GET requests to `/v1/collections/gifts/`, `/v1/rent/gifts/`, and `/v1/rent/gifts/history/` are constructed. Collections come from imported portfolio addresses, in stable address order. Coverage is partial until the saved streams complete. Fresh collection starts at the head; Resume freezes the original scopes, page size, and timeframe. History stops after a valid descending page crosses the selected lower boundary; empty continuation pages continue, equality retains ties, and ordering anomalies disable the cutoff shortcut. Requests are bounded even if ordering is unreliable.

`Retry-After` applies across jobs. Authentication failures, malformed pages, cursor cycles, and rejected cursors stop collection without advancing that page. A rejected cursor requires a new collection. An in-flight lease prevents overlap; after an interruption, allow up to two minutes for it to expire before resuming. The current SDK does not document a configurable network timeout or cancellation primitive; the five-minute allowance prevents starting further requests, and the lease fences late results. It cannot force an already-sent SDK request to finish at exactly 30 seconds.

Production timing uses SQLite wall time refreshed around database commits and provider responses. This prevents the runtime's JavaScript clock behavior from shortening retry delays or accepting an expired lease. Failure to read trusted time stops new provider requests. Lease fencing protects committed state; it cannot cancel an old transport request if the platform leaves it running.

**Use one active collector.** Desktop, CLI, and Telegram do not share an account-wide request ledger. Leave the local dashboard without `--allow-network` when using Telegram for collection; otherwise the two independent allowances can add together. No scheduler, automatic notifications, paid discovery, or price-changing function is enabled.

## Storage and migration

The existing `collector_state` prototype table remains intact. The additive `cloud_events` table stores immutable event chunks, compact run/checkpoint state, normalized evidence, raw valid and invalid responses, and request reservations. One conditional SQLite INSERT publishes each page's raw evidence, records and next cursor atomically. It does not rely on transactions spanning separate SDK calls. Compare-and-set revisions and leases fence concurrent calls and stale responses.

Import chunks have stable identifiers, content checks, and bounded size. Identical replay is acknowledged; conflicting replay is rejected. The seed compacts identical listing/history representations while preserving observation times and occurrence counts. Changed variants remain distinct. Original page occurrences remain in the local SQLite database. Reads never call Marketapp. Stored JSON keeps monetary strings, original source fields, and the missing/null distinction.

The dashboard reads normalized evidence in batches of five event chunks and calculates only the selected view in memory to limit database response size and runtime work. Address, timestamp, and trait normalization is cached only within an individual calculation; caches are discarded afterward. It avoids the prototype's 2 MiB document cap, but it is not an unbounded data warehouse. Monitor growth before long-term collection. Raw responses are excluded from dashboard reads. Historical prototype behavior is documented in [telegram-serverless-prototype.md](telegram-serverless-prototype.md).

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
