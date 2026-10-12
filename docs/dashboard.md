# Private local dashboard

The dashboard reads the collector's SQLite database and presents portfolio counts, gift search and collection/status filters, daily price observations, ownership evidence, activity, and a CSV export. It keeps unresolved candidates separate from portfolio members. Amounts stay decimal strings through the API and display; unknown prices stay empty.

**My gifts** opens the portfolio by default. Search and the **All**, **Available** and **Rented** quick status buttons stay above the gifts. **Available** combines saved Marketapp rent listings and freshly verified idle rental contracts, counting each gift once. The Overview tile opens this same filter. Idle contracts keep their own status label: availability does not establish that they are visible on Marketapp. Historical, conflicting and uncertain idle states stay excluded. Expand **Filters** for collection, status (including the separate **Marketapp listings** filter) and **Include**: **My gifts**, **Unverified candidates** or **Gifts and candidates**. The active-filter count and **Reset filters** make the chosen scope explicit; reset returns to the portfolio with all statuses and collections. Search can be cleared separately. Overview links preserve the membership scope of their counts. Switching pages returns to the top without changing saved data.

Gift details put current and recommended prices first, with the chosen sample size and comparison match visible. **Comparison averages** and **Rental history** are collapsed by default; statistics, sources, ownership evidence, addresses and uncertainty notes remain available on demand. A known recorded rental count appears in the Rental history summary. The close button stays visible while scrolling. Wallet details distinguish the connected wallet from the saved portfolio and do not change which portfolio is shown.

**Overview** prioritizes the personal analytics period, rent volume before fees and rental count including extensions. **More statistics** holds the remaining metrics and breakdown table. Portfolio summary counts and recent observed price changes remain visible; recently checked gifts and the complete status breakdown are under **Portfolio details**. Telegram's optional remembered login is under **Login options**, with consent and refresh failures still visible beside the action.

Pricing and My gifts reveal more rows automatically as you approach the end of the list, keeping earlier rows visible. Pricing adds 15 gifts at a time and My gifts adds 20. Search, collection, state, sort, and comparison changes restart the visible list; routine background refreshes preserve the number already shown. The footer reports how many matching gifts are visible and provides a **Load more** button for keyboard use or browsers without automatic scroll detection. Scrolling displays saved dashboard results and does not start provider collection jobs.

Detailed views show **Rentals** beside or beneath each portfolio gift's name. Simple cards keep the count in the expandable **Rental history** section instead. This counts confirmed rental starts in **all saved Marketapp history**, independent of the selected pricing timeframe, price source, model, or backdrop. Extensions, records with an unknown extension flag, and ambiguous record variants are excluded; repeated pages and TON address aliases do not add rentals. Counts include all currencies and do not depend on whether a daily price can be calculated. A count is the number recorded locally, not a complete lifetime total or proof of rentals during your ownership. Missing confirmed history displays **Unknown**, never an assumed zero. Gift details and CSV exports include coverage, excluded-record counts, event dates, and the history observation timestamp. Select **Actual rentals → Refresh & export → Update comparisons** to gather more history, and resume partial jobs in Status.

The default **Pricing** page switches between **Listing prices** and **Actual rentals**, showing collection, model, and model + exact Black averages and a daily asking-price suggestion. Both sources default to 30 days. Choose 24 hours, 7/30/60/90 days, or inclusive custom UTC dates covering at most 90 calendar days. The window never expands automatically when samples are insufficient. Listing windows use observation time; rental windows use event time. Source/window changes read saved data only, and exports follow the same selection. The **Black** quick filter restricts both portfolio rows and every comparison to exact Black: collection + Black across all models, and exact model + Black. Its collection fallback never uses other backdrops. This scope persists when changing source or timeframe, and applies to details, summary counts, and CSV exports. Selecting another gift group restores the all-backdrop view. Search and collection row filters remain selected while comparison data reloads. Saved observations do not establish complete market coverage. See [pricing rules and evidence limits](pricing.md). The primary **Update comparisons** action follows the selected source. Its adjacent menu offers **Update gift details**, **Find new gifts** and **Update listings & rentals**; these are the existing bounded workflows with clearer names.

Sample size and comparison match describe different things. **Limited sample** means 1–2 distinct gifts, **Small sample** 3–9, **Medium sample** 10–29, and **Large sample** 30 or more. Rental comparisons count distinct gifts rather than rental records; absent counts stay unknown. The match is **Collection estimate**, **Same model**, or **Model + Black**, with **Collection + Black** for a collection fallback in Black scope. These labels describe the amount and relevance of saved evidence, not statistical confidence or forecast quality. Suggestions still require three distinct gifts; prices and comparison eligibility are unchanged.

Simple pricing cards keep evidence on one compact line below both prices, for example **131 gifts · Collection**. The count is eligible distinct gifts, not rental records. Open a gift for the full sample-size label, comparison match and explanations; detailed pricing retains those labels too.

## PowerShell setup and launch

New openings default to **Actual rentals**, **Last 30 days**, and **Biggest increase first**. Both the local and Telegram dashboards use these display defaults. Opening the local dashboard does not start Marketapp collection. Telegram can run a small stale-only comparison batch after its other startup checks; see [automatic comparison checks and limits](telegram-serverless.md#automatic-comparison-check). Both versions can separately check configured TON contract prices for known gifts using the same startup controls and progress display.

Use **Simple / Detailed** beside **Your gifts** to switch views. **Simple** is the default on both versions and shows gift images and names with only Current and Recommended daily prices. It uses two columns on mobile and more columns on wider screens. Select a gift for its full evidence. **Detailed** restores the comparison table; methodology and coverage explanations are under **How prices are calculated**. The browser remembers your choice, including an existing Detailed preference. Switching views keeps filters, source and timeframe, and does not start another price check. Refresh controls and desktop Export remain available under **Refresh & export**.

**My gifts** has its own **Simple / Detailed** switch. Simple cards retain saved-status and candidate labels alongside daily prices; Detailed keeps the inventory table. The separate preference, filters, membership scope and loaded gifts survive switching views. The refresh icon in Pricing or My gifts checks the already-discovered portfolio's TON daily contract prices within the limits below. It is disabled while a previous check finishes, and updates the saved prices as batches complete.

**Sort by** is visible above My gifts in both views, including the **Rented** section. **Last rented · newest first** is the default; you can also choose original order, name, current daily price (highest or lowest first), or soonest known rental end. Later choices are remembered on this device. Sorting uses already-loaded gifts after filtering; it makes no provider requests. Missing or unsupported values appear last. **Last rented** combines confirmed starts in saved rental history with the current start from a verified supported rental contract. The contract's exact expiry minus its accumulated rental duration preserves the original start through extensions; refresh times and rounded countdowns are never used as rental starts. **Rental ending** uses eligible exact end times; rounded or unknown remaining-time labels do not establish an exact end date.

Telegram also retains the latest previously verified contract start as dated evidence for sorting. A newer Marketapp page result, unavailable TON check, or return to the wallet does not erase that known past rental. This date is separate from the current rental start, status, exact expiry and saved Marketapp rental count, so sorting stays stable while current details are being checked.


A small clock mark on gift images identifies a currently rented portfolio gift. It appears across grids, tables, featured gifts and gift details, without changing row height. Expired, historical, conflicting and unverified states receive no mark. Telegram checks rental status with its startup and manual TON refresh; desktop keeps the existing **Update gift details** action for that check.

From the project directory, use Python 3.12 and the tested dependency constraints:

```powershell
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -c requirements-dev.lock -e '.[dev,dashboard]'
powershell -File scripts\build-dashboard.ps1
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 dashboard
```

Open <http://127.0.0.1:8765>. Stop the foreground server with Ctrl+C. A different local port can be selected with `--port 8766`. The dashboard selects `MARKETAPP_OWNER_ADDRESS`, `--wallet`, or the sole wallet already stored in discovery runs. It requires an explicit wallet when the database contains several wallets.

Overview also supports your own Marketapp rental analytics through a saved browser snapshot: rent volume before fees, rental counts, and daily/weekly/monthly/yearly totals. **Update analytics** captures the signed-in page and imports its JSON. These figures retain their reporting period and capture time, separately from pricing comparisons. No Marketapp session or API requests are imported; desktop and Telegram store their own snapshots. See the [personal analytics workflow](personal-analytics.md).

### Add a Marketapp API key in the desktop UI

Open **API key** in the header and paste the raw Marketapp key into the masked field. Choose session-only use, or enable **Remember on this computer** to save it in Windows Credential Manager for your Windows user and the selected database. Session-only keys last until the desktop service stops, even if the browser closes. Other platforms offer session-only use when secure storage is unavailable.

Saving makes the key available to the running desktop service. It checks the input format locally; it does not contact Marketapp, verify account access, start collection, or change request limits. **Remove key** clears the dashboard-managed configuration and its saved credential. Replacing a remembered key with a session-only key removes the previous saved key. Finish or stop active collection before changing a key.

The UI never returns a saved key to the browser. Keys entered here are not written to browser storage, `.env`, SQLite, exports, or Git. Persistent storage uses the [Windows credential service](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew). A key already supplied through the environment or `.env` takes precedence and must be changed there. The CLI and Telegram use their own existing configuration; this setting applies only to the local dashboard.

Manual Marketapp collection still requires the service to start with `--allow-network`. If collection is disabled, the UI shows that reason beside paused work. Restart with the same database, wallet, and review options, adding the flag:

```powershell
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 dashboard --allow-network
```

A remembered key is loaded on restart; re-enter a session-only key afterward. Then use **Continue** or a collection action when ready. Enabling manual collection does not automatically resume paused Marketapp work.

The production frontend is served by Python. Generated assets are excluded from Git, so a fresh clone needs Node 24 and pnpm 11.25.0 for its initial build. Python serves the resulting files without Node at runtime. To rebuild:

```powershell
powershell -File scripts\build-dashboard.ps1
```

`-Pnpm 'C:\path\to\pnpm.cmd'` selects an existing pnpm installation. The script installs the locked frontend dependencies, runs its tests and TypeScript checks, builds, and copies the assets into the Python package. It does not publish anything. Reload the browser after rebuilding. The build artifacts under `src/marketapp_rent/dashboard_static` must be present when building a Python wheel.

## Continuous collection and resumable work

### Automatic rent price check

To enable the same startup price check as Telegram while leaving desktop Marketapp collection disabled:

```powershell
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 dashboard --allow-price-refresh
```

Each fresh visible page opening loads saved data first, then checks only existing portfolio gifts through TON Center. It requests NFT holders, supported rental-contract settings, and a holder/logical-time recheck. It does not scan transfers, discover gifts, refresh comparison samples, request Marketapp data, or change membership or ownership labels. No Marketapp token is required; `TONCENTER_API_KEY` is optional and remains on the Python side. The saved wallet and collection mapping determine the targets.

The frontend driver, startup gate, status text, and **Stop check** control are shared with Telegram. The check starts once per page opening, waits if the page is initially hidden, and stops issuing steps when hidden or closed. Returning to the same page or the 15-second saved-data poll does not start another check. Use the refresh icon for an explicit new check, or reopen/reload. Repeated clicks join pending work and do not queue another check; concurrent pages join existing work rather than duplicate provider calls. **Stop check** retains committed observations.

The limits match Telegram: 50 gifts per batch, one TON request per second, 60 attempts and two minutes per run, three attempts per request, a 20-second timeout, and 1,000 attempts per rolling 24 hours. Persistent leases and request counters live in the dashboard database. Manual wallet discovery/ownership refresh and this price check cannot run concurrently in the same dashboard. CLI invocations and Telegram retain separate provider budgets. Desktop and Telegram have separate data stores and allowances; this is behavior parity, not live data synchronization.

Fresh verified settings appear as **Observed contract terms**, using the contract observation time. Only the configured asking rate is used, never an ongoing rental's payment rate. Directly held gifts, unsupported contracts, and failed checks keep their previous dated price with uncertainty. Marketapp visibility, recommendation samples, traits, and rental counts remain unchanged. The dashboard CSV includes price-check time and reason.

`--allow-network` also enables this startup check, alongside the existing manual collection controls. Omit both flags for fully offline operation. Only the price check follows browser visibility; the manual job worker described below can continue while the browser is closed.

Saved prices remain visible while the same comparison refreshes. Dashboard reads run one at a time, with the next poll scheduled after the previous response completes. Job progress is checked separately, and a finishing job triggers another read of its saved results. Switching the price source, timeframe, or backdrop cancels the old view's requests.

**Update gift details** reads configured asking prices from supported rental contracts, including gifts currently rented out. **Update listings & rentals** reads public listing observations across the selected collections and continues automatically through its request batches. It does not refresh the contract settings of a rented gift absent from those listings. The asking price shows its own source and observation time, also included in CSV exports. Newer valid evidence supersedes older evidence by its price timestamp. A contract's configured asking price can differ from the rate of an ongoing rental; that existing rental rate is never substituted for the asking price. Historical prices stay dated when a newer check fails.

The default dashboard reads saved observations with provider requests disabled. To permit manual refresh jobs, configure `MARKETAPP_API_TOKEN` and `MARKETAPP_OWNER_ADDRESS` in your local `.env`, optionally `TONCENTER_API_KEY`, and launch:

```powershell
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 dashboard --allow-network
```

Environment variables override `.env`. Tokens stay on the Python side and are not sent to the browser. Apart from the independent TON startup price check, no new job begins until you click a collection action or Resume; its batches then continue automatically:

- **Update gift details** verifies the known portfolio and unresolved candidates against a newly saved eligibility catalog. It does not enumerate the wallet again. Its seed list is frozen for resume.
- **Update comparisons** with **Listing prices** selected collects the portfolio's fixed collection/model/Black listing groups with 100 items per page, using the same job queue and automatic batches. Its averages are calculated from saved observations.
- **Update comparisons** with **Actual rentals** selected queues a `rental_prices` job for the portfolio's eligible collection scopes, with 100 history records per page plus the catalog refresh. It fetches no listing or attribute pages. History-derived daily means include your own portfolio on the same terms as other gifts, including the gift being compared. They exclude unverified extensions and incompatible or ambiguous records; suggestions require three distinct gifts. Replayed records do not add extra weight. Use `collect-rental-prices` or `collect-rental-prices --resume RUN_ID` for the same CLI workflow.
- **Find new gifts** runs bounded direct-holdings and full indexed transfer enumeration plus verification. It starts a fresh traversal using the current decoder registry.
- **Update listings & rentals** starts Marketapp listing/history collection for the selected wallet's known collection scopes, plus a bounded unfiltered scope when a portfolio gift has no unambiguous collection mapping. With no portfolio gifts, only the catalog is refreshed. Listing visibility remains distinct from TON ownership.

Dashboard jobs continue automatically through batches until completion or a safety cap. By default each start/resume permits **100 Marketapp HTTP attempts** and **300 seconds** across all its batches. A shared **500-attempt rolling 24-hour cap** persists in the queue database across jobs, resumes, and restarts. Retries and catalog refreshes count; TON Center requests have separate provider budgets. Marketapp requests remain sequential, at most one per second even if the CLI rate setting is higher. Provider Retry-After cooldowns are honored, and a cooldown beyond the remaining duration pauses without waiting through it. Repeated clicks reuse the active job.

The pricing page displays these limits, remaining daily allowance, and saved job usage. Configure them with `MARKETAPP_DASHBOARD_MAX_ATTEMPTS`, `MARKETAPP_DASHBOARD_DAILY_MAX_ATTEMPTS`, and `MARKETAPP_DASHBOARD_RUN_SECONDS` in `.env`; restart the service afterward. They are conservative local safeguards, not a published Marketapp allowance or a guarantee against restrictions. The counter covers this dashboard queue, not CLI runs, the separate Telegram dashboard, other database queues, or other clients using the same token. Existing requests from before this upgrade are not backfilled into the new counter. When using Telegram as the Marketapp collector, omit desktop `--allow-network`; `--allow-price-refresh` can independently enable the TON-only check.

**Update comparisons** with **Listing prices** selected starts with broad collection listings. New runs rotate among pending streams after each committed page so large collections do not prevent later collections from receiving an initial sample. A completed, classifiable collection scan supplies its model and Black groups; only groups still needing coverage use separate requests. Partial scans and uncertain traits retain targeted fallbacks. Resume retains the saved schedule; legacy runs keep sequential fetching. Job details show reused groups, and original observations remain unchanged. Telegram's separate one-hour market cache and force-refresh option are described in [the Telegram guide](telegram-serverless.md#shared-market-cache).

**Update comparisons** with **Actual rentals** selected freezes the displayed timeframe for each new job. Its first complete scan reads that selected window; later refreshes can reuse completed collection coverage and reread recent records with a **48-hour overlap**. The next requested refresh after **seven days** from the last full scan rechecks the whole window; a wider window or new collection also needs a full scan. This does not schedule work. Each crossing page is retained in full, timestamp ties are kept, and ordering anomalies disable early stopping and coverage reuse. Older late/corrected records may wait for the next full scan. Job details distinguish recent updates from full-window scans; neither establishes complete lifetime history. New history scans are capped at the last 90 days. Custom history scans must start within the last 90 inclusive UTC calendar dates; older custom ranges can inspect saved data only. **Update listings & rentals** also includes history and uses the same policy. Resume preserves the original window and per-collection plan; changing the displayed timeframe only reads local data. Start a fresh job to collect a different window. Legacy unbounded history jobs require a fresh bounded run; they cannot resume from the dashboard. Previously collected data is retained. Current listing refreshes cannot request historical listing snapshots; past listing windows use data saved at those times. See [pricing collection details](pricing.md).

Use **Stop** on the active job card or in **Status** to stop further requests while retaining saved progress. A queued job stops immediately; an active job shows **Stopping…** until its current request or verification yields. An in-flight request may take up to its configured timeout. **Resume** continues the saved run with a fresh invocation budget; it cannot bypass the shared daily cap. Authentication, rejected cursors, malformed responses, exhausted request retries, skipped scopes, and repeated batches with no progress require attention instead of endless automatic retries. Closing the browser leaves the local service working within these caps; shutting down the dashboard stops its worker. Interrupted jobs require an explicit Resume after restart. CLI collection commands retain their bounded invocation behavior.

The queue is stored next to the collector database as `<name>.dashboard.sqlite3`. The collector schema stays v2. A worker lease and fenced updates prevent two dashboard workers from claiming the same queued job. Stale running jobs become partial after a restart; resume is explicit. A persisted stop request prevents further automatic batches and is cleared only by an explicit Resume. Stopping the app leaves committed pages intact. A provider request already in flight may run until its configured timeout before the worker stops. Credentials and `--allow-network` are required for all dashboard resume actions; the CLI can still resume a discovery with an already committed catalog without a Marketapp token.

Status includes job state, partial/failure reasons, provider run IDs, saved run coverage, and historical observations. These are observations at individual times. An expired rental does not prove that the gift returned, and an idle contract alone does not establish a visible listing. Historical gift payments are not treated as your income.

## Reading sync progress

Desktop and Telegram share the same sync cards. Each card explains whether it is checking your own gift prices, updating listing comparisons, reading actual rentals for the saved timeframe, or finding wallet gifts. Open **Refresh & export** on Pricing or visit **Status** to see progress. **Stop** saves progress; a paused collection offers **Continue**.

The main Pricing view keeps current sync and gift-check activity inside **Refresh & export**, collapsed by default. **Status** starts with compact data rows: one check/update time, a clear state and a direct action. Expand a row for exact dates, coverage and explanations. Green indicates recent checks or data; unavailable values retain their own warning even after a completed check.

Active updates keep visible progress and **Stop** controls. Paused scans, finished updates, older failures and recent observations share **Update history**, collapsed by default. Expand a dated entry for its full progress, details and recovery actions. Saved scans, checkpoints and evidence are kept; superseded empty pauses stay hidden. Wallet, Marketapp login and API-key controls remain visible under **Connections**. Storage details and **More tools & export** expand when needed. Overview and My gifts do not show refresh activity cards.

When the rolling Marketapp request allowance is exhausted, the sync card shows **Available again** with a date, local time and timezone. This is the earliest time enough requests leave the 24-hour window to permit another request, assuming no additional requests. It also handles usage above a configured cap. Saved-status polling updates Telegram's allowance; if the saved time has passed, the card suggests trying **Continue**. Collection never starts from the time display. Older responses without an availability time retain a generic pause message.

Listing comparisons count finished collection, model, and backdrop checks, including the initial catalog check. A collection with unfinished model checks can still contribute its finished comparisons to progress. Other market jobs count completed collections (all requested scans for each collection), and ownership checks count checked gifts when the gift total is known. Percentages do not estimate elapsed time: checks can differ greatly in size. Wallet discovery shows an indeterminate bar until enumeration establishes the total. Unresolved gift checks count as checked, not as successfully updated. Request allowances, saved dates, cache information, and technical reasons are under **Details**. Completed automatic price checks use a compact summary.

## Price changes and performance

Overview lists recent observed asking-price changes. Each gift's expandable **Price changes & performance** section compares eligible saved rental records before and after a change over 7, 14 or 30 days. Prices and the compact before/after table are shown first; source dates, methodology, exclusions and saved price history are grouped under **Comparison details**. Comparison windows have equal elapsed durations and exclude the uncertain interval between old and new price observations. Tracking uses existing evidence without additional provider requests; saved samples do not establish net revenue, complete coverage or a causal price effect. See [tracking rules](price-tracking.md).

## Supplemental local review

An explicit `--review-directory PATH` adds dated review annotations from `updated_inventory.csv`, `holder_review.csv`, and `unresolved.csv`. There is no automatic search for neighboring folders. The parser validates required columns, wallet identity, and canonical addresses. Optional saved `evidence/live-recheck` responses can be verified offline against the pinned decoder. The UI distinguishes automatic database members, review annotations, and validated supplemental evidence.

Review annotations do not write portfolio membership or replace newer conflicting ownership evidence. Review-only gifts remain visibly reviewed. If a newer verification fails or finds a different owner, membership history is retained with uncertainty. A decoder upgrade alone does not enroll gifts: a fresh verification must meet the ownership checks.

The CSV export contains the displayed portfolio and unresolved candidate rows, membership sources, state, monetary units, observation times, provenance, and uncertainty. Pricing means and recommendations use the currently selected source, timeframe, and backdrop scope (Black export rows are limited to exact Black portfolio gifts), with window bounds, time basis, rental interpretation version, record counts, and distinct NFT counts included. It is generated locally with UTF-8 BOM and spreadsheet formula escaping. The existing CLI `report` remains the complete historical CSV export.

## Local security and future Telegram hosting

This release binds only to loopback. It checks request origin/host and uses a per-process CSRF token for queued actions. It has no public-user login and should not be exposed through a tunnel. Remote gift images may load from saved HTTPS metadata URLs in the browser; reading the dashboard otherwise needs no provider API requests. No scheduler, Telegram messages, transactions, or price changes are activated.

The React data adapter interface is isolated in `frontend/src/data/types.ts` and its implementation in `local.ts`. Telegram UI bridge use is optional; it is not authentication. The local dashboard does not validate Telegram `initData` or expose its database publicly. The deployed [private Telegram pricing dashboard](telegram-serverless.md) uses platform-verified endpoint identity, its own cloud storage and bounded Marketapp collection. The approved portfolio/history snapshot has been imported into Telegram; the original Python database remains local. Cloud collection does not synchronize new observations back to this database or refresh TON ownership.

## Verification

Each desktop projection shares a request-local evidence cache capped at 20,000 rows and 16 MiB of estimated serialized payload plus row overhead. Larger reads stream without truncating evidence. Rental counts and performance tracking use canonical NFT identity filters, while comparison evidence retains the history needed for traits and conflict detection. Status keeps only its newest 100 candidates before formatting. No persistent cache or data deletion is introduced.

Decimal evidence is checked before fixed-point formatting: at most 1,100 coefficient digits, an exponent between -1,000 and 1,000, and 2,200 input/output characters. These are resource limits, not a currency scale or rounding policy. New unsupported numeric evidence is rejected with a fixed error; unsupported saved amounts remain stored and are excluded from calculations/display. Historical CSV exports preserve their original compact representation with formula escaping.

Desktop requests have a 45-second deadline covering both HTTP response and JSON body decoding. A stalled request releases loading/Retry controls and keeps the last saved view. Mutations are not retried automatically when their outcome is unknown. Scheduled polling checks a lightweight local revision before rebuilding the dashboard; source changes and a one-minute time bucket invalidate it. The revision route uses collector/review file metadata, configuration flags and cached indexed markers for new ownership observations, analytics snapshots and request attempts. Worker heartbeat and job-progress writes do not invalidate gift data; progress is read separately. These checks call no provider API and load no history records.

```powershell
& .\.venv\Scripts\python.exe -m pytest
Push-Location frontend
pnpm test
pnpm build
Pop-Location
```

API tests require the `dashboard` extra. They cover loopback/origin/CSRF restrictions, offline data/export, secret redaction, job creation/resume, and static file isolation. Additional tests cover crash recovery, leases, frozen refresh seeds, resume without repeated enumeration, exact decimals, supplemental review provenance, and both supported rental contract variants. The original collector and discovery suite remains applicable. No live credentials are needed for these tests.

Dashboard startup uses the existing CLI exit codes: configuration errors are `2`, local operational failures are `1`, and an interrupted command is `3`. Collection results appear as job states in the UI; HTTP 202 means a job was accepted, not that its traversal finished.
