# Daily rental price comparisons

The Pricing page switches between **Listing prices** and **Actual rentals**, with a separate timeframe selector. Both sources compare each portfolio gift with its collection, exact model, and exact model with a Black backdrop. “Gift” means its collection, identified by TON address. Model and Backdrop come from saved structured attributes, never from names or pictures. **Black means the exact named backdrop Black. Onyx Black and other dark backdrops are separate.**

Each gift shows its observed asking price, comparison averages, sample counts, and a suggested daily asking price based on the selected source. Sample size and comparison match are shown separately, so a broad collection estimate is distinguishable from a same-model comparison even when both have many gifts. Details show the median, range, timestamps, and missing-data explanations. All comparison rates are in GRAM/day. They are not sale valuations or estimates of your net income.

## Source and timeframe

| Source | Price used | Time used | Default when selected |
| --- | --- | --- | --- |
| Listing prices | Documented listing `price_per_day`, converted from nanoGRAM | When the listing was observed locally | Last 30 days |
| Actual rentals | Recorded full rental price normalized by its duration | Rental event `ts`, interpreted as Unix seconds | Last 30 days |

Both sources default to **Last 30 days**. Choose **Last 24 hours**, **Last 7 days**, **Last 30 days**, **Last 60 days**, **Last 90 days**, or **Custom dates**. Presets are rolling windows. Custom dates are inclusive calendar dates in **UTC**, with a maximum of **90 calendar days**; the end is capped at the current time. Apply edited custom dates to update the comparisons. A range longer than 90 days is rejected, not silently shortened. There is no unbounded history option in the dashboard.

Changing a source, timeframe, or Black comparison scope reads saved data only. It does not fetch older pages or start a provider job. If samples are insufficient, the timeframe stays unchanged; choose 60 or 90 days explicitly when useful. A wider window cannot fill gaps that were never collected. Historical custom ranges of up to 90 days remain available for inspecting saved data, and full historical records remain available through the CLI inspection reports.

For listings, each canonical NFT contributes its latest eligible observation within the selected window. A historical listing window describes observed asking prices during that period; it does not claim those prices are current. For rentals, the event timestamp determines inclusion even if the event was downloaded later. The rental's paid period can extend outside the selected event-time window.

## Comparisons and recommendations

| Comparison | Eligible comparison group |
| --- | --- |
| Collection average | Same canonical collection, all models and backdrops |
| Model average | Same collection and exact named model, all backdrops |
| Model + Black average | Same collection and model, exact Black backdrop |

Selecting the **Black backdrop** tab changes both the displayed portfolio rows and the comparison population. **Collection + Black average** includes only exact Black gifts in that collection across all models. **Exact model + Black** includes only that model with Black; the duplicate third comparison is hidden. Source and timeframe changes preserve Black scope, and gift details and CSV export use the same scope. Selecting another portfolio tab restores the all-backdrop collection/model comparisons. Search and collection controls narrow portfolio rows without changing the groups defined above.

**Sort by** orders the displayed gifts by the difference between the suggested daily price and the current observed asking price. **Largest price gap** puts the largest absolute differences first; **Biggest increase first** sorts from the most positive change down; **Biggest decrease first** sorts from the most negative change up. Positive means the suggestion is higher than the asking price. Missing or incompatible prices sort last, and ties retain their original order. Sorting uses full decimal precision before pagination; the signed difference is displayed to three decimals beside the suggestion and in gift details. The selected sort survives changes to source, timeframe, and Black scope. It changes the dashboard row order only; it does not alter averages or exported records.

For example, a Black Low Rider uses the collection average across Black Low Riders, not the collection average across every backdrop. With Black selected, suggestions can fall back from exact model + Black to collection + Black, but never to an all-backdrop group. Unknown backdrop metadata does not qualify.

The groups overlap and their averages are **not averaged together**. The recommendation uses the mean of the most specific applicable group with at least **three distinct NFTs**. In the default all-backdrop view, a Black gift first uses Model + Black, then Model, then Collection. Other backdrops use Model, then Collection; their Black average is comparison information only. Means from smaller groups remain visible, but cannot supply a recommendation. Rental record counts and distinct NFT counts are shown separately: ten rentals of one gift still provide only one distinct gift.

The **comparison match** describes the group used: **Collection estimate**, **Same model**, or **Model + Black**. In Black scope, a collection fallback is labelled **Collection + Black**; an exact-model match is **Model + Black**. A collection estimate can miss model premiums, and a same-model group can miss backdrop premiums. These labels describe the comparison, not its predictive accuracy. Missing rental evidence never silently falls back to listing prices; select Listing prices to use that source.

The **sample size** label uses distinct gifts in that comparison group:

| Distinct gifts | Sample size |
| --- | --- |
| 1–2 | Limited sample |
| 3–9 | Small sample |
| 10–29 | Medium sample |
| 30 or more | Large sample |

For listing comparisons, the listing sample count already counts distinct gifts. Actual-rental comparisons use the distinct-gift count, not the number of rental records: 100 rentals of two gifts are still a **Limited sample**. An explicit zero means no sample; a missing distinct-gift count remains unknown rather than being inferred from rental records. These are descriptive size bands, not statistical confidence levels or forecasts of demand, occupancy, or income. A large sample can still be biased, stale, or a broad comparison. The calculation and minimum of **three distinct gifts** for a suggestion are unchanged.

Your own portfolio NFTs and listings whose observed owner matches your wallet are included in both sources on the same terms as other gifts. The gift being compared can contribute to its own groups when its evidence is eligible. Canonical TON identity prevents friendly/raw address aliases from adding statistical weight. Conflicting collection or trait evidence is excluded or flagged. In the all-backdrop view, unknown model/backdrop metadata can leave a collection average available while narrower comparisons remain empty. Black scope requires verified exact Black metadata even for its collection average; unknown models may still contribute to that Black collection average.

## Listing evidence

Repeated pages, overlapping queries, and later snapshots do not make one NFT count multiple times in a listing group. Comparison-source provenance matters: a targeted Black query does not supply a collection-wide or model-wide sample, and a model-only query does not supply a collection-wide sample. Broader averages require observations from appropriately broad streams. With Black scope selected, a collection-wide Black query or a broad collection query can supply the collection + Black group after trait filtering; a model-specific query still cannot supply that collection group.

Listings can change or disappear after observation. A recently-touched, bounded scan can be biased and partial; even a completed traversal spans time and is not an instantaneous market snapshot. Stale or conflicting subject traits can prevent a model-specific recommendation.

## Actual rental evidence

The recorded daily rate is calculated with exact decimals:

```text
effective_daily_rate = price * 86400 / duration
```

Marketapp's public history labels the amount **Full Price**. Two saved API events match public UI prices, rental days, timestamps, and transaction hashes, supporting whole-rental prices, duration in seconds, and Unix-second event times. This is a versioned **observed UI interpretation**, not a guarantee in the pinned OpenAPI schema. See [the pinned evidence and limitations](rental-history-evidence.md).

The arithmetic mean gives each eligible, unambiguous rental record equal weight. It is not weighted by duration or by unique gift. A gift can contribute multiple separate rentals, but recommendations still require at least three distinct gifts. Missing transaction hashes alone do not disqualify an otherwise suitable record; hashes are linkage, not globally unique event identifiers.

The calculation excludes:

- Extensions (`is_extend=true`) and records where extension status was not supplied. Incremental versus cumulative extension duration is not verified.
- Non-GRAM currencies, inconsistent GRAM `price` / `price_nano` pairs, and invalid monetary values.
- Missing, zero, negative, or invalid durations, and invalid or out-of-window event timestamps.
- Conflicting collection/trait evidence.
- Ambiguous changed variants sharing NFT, timestamp, and parties. Identical canonical representations and page replays count once; ambiguous variants remain stored but do not receive extra votes.

Excluded counts are visible under sample coverage. Missing values remain empty rather than becoming zero. A supplied zero amount remains distinct from missing or invalid data.

History's documented response has no model/backdrop fields. Narrower rental comparisons join saved, validated structured metadata for the same NFT and collection. That metadata may have been observed after the rental and may be absent; it is not presented as traits recorded with the historical event. Current metadata freshness checks remain separate from the rental event window.

Reported amounts do not establish landlord net proceeds, fees, gas, refunds, or rental completion. An entry can describe an ongoing rental. Portfolio membership alone does not establish who received the proceeds of a historical rental.

## Arithmetic and exports

All arithmetic uses `Decimal`; API comparison values are rounded half up to one nanoGRAM, and the dashboard displays prices rounded half up to three decimal places. Monetary values remain decimal strings through SQLite, the local API, and the frontend. No outliers are silently removed: median and range expose the spread. Attribute rental floors, contract sale values, and undocumented discount calculations are not substituted for the selected source.

The dashboard CSV export follows the selected source, timeframe, and backdrop scope, including the same three means, counts, distinct NFT counts, recommendation, basis, units, warnings, time basis, and interpretation version. The existing backend and export `confidence` field remains unchanged for compatibility; it is not the dashboard's sample-size or comparison-match label. This display change does not alter API fields, cohort eligibility, or price calculations. The local data and export endpoints accept the same `pricing_source=listings|rentals` and `timeframe=24h|7d|30d|60d|90d|custom` parameters; custom ranges also use `date_from=YYYY-MM-DD` and `date_to=YYYY-MM-DD`. `pricing_backdrop=Black` selects exact Black comparisons and Black portfolio export rows; omit it for the all-backdrop view. The exported `pricing_backdrop` records that scope. Browsing and exporting require no provider token. The CLI `report` command remains the full historical inspection export.

## Populate comparisons

Configure `MARKETAPP_API_TOKEN` locally and start the dashboard with `--allow-network`. With Listing prices selected, **Collect comparison prices** queues a `prices` job. With Actual rentals selected, **Collect actual rentals** queues a `rental_prices` job. Requests stay on the existing free GET allowlist with raw-token authentication. Switching the view never submits a price update or starts collection automatically.

Desktop listing jobs create fixed collection, exact-model, and model + `backdrop=Black` streams from the selected portfolio, with 100 items per page. New jobs read collection-wide listings first, followed by models and Black groups. A completed broader traversal can cover narrower groups without fetching them again. Reuse requires an actual end cursor and sufficient, consistent structured traits to classify the relevant records. Partial scans keep their targeted fallbacks; a completed model scan can cover its Black subset. Telegram already collects each collection once and derives model and Black groups from those broad observations.

Reused desktop streams record `covered_by_listing_stream:<source-id>`. They retain the original observations and request provenance, without duplicate page occurrences or extra votes in averages. Job details and inspection reports identify this reuse. The versioned order and policy remain frozen on Resume; old paused runs retain their original behavior. These jobs read the catalog and listings.

Telegram has a one-hour cache of completed market traversals, shared by refresh jobs in its deployment. It reuses eligible listing and history coverage with original observation times and visible cache age; a force-refresh action bypasses reuse. History reuse cannot skip a required wider or weekly full-window scan or reset reconciliation clocks. See [Telegram cache rules](telegram-serverless.md#shared-market-cache). Desktop and Telegram retain separate stores and request allowances.

Rental jobs read the catalog and one history stream per eligible portfolio collection, with 100 items per page in both dashboards. History accepts collection filtering, not model/backdrop/date filters. No listing or attribute pages are fetched by this job. A new dashboard job freezes the selected UTC timeframe. Its first complete scan traverses newest first until it passes the lower boundary. Later scans can reuse completed coverage as described below. The whole boundary page is retained as evidence; displayed averages still exclude records outside the selected dates. For a past custom interval without reusable coverage, newer pages must still be traversed to reach it because the API has no date filter. Unknown or conflicting collection addresses do not trigger an unfiltered comparison scan. An empty portfolio refreshes only the catalog.

The early stop relies on the existing observed interpretation of `ts` as Unix seconds and the requested `new_to_old` ordering. Invalid or out-of-order timestamps disable that shortcut for the affected stream and prevent its reuse as a coverage baseline; the request caps still apply. A `timeframe_covered` result means this traversal reached the requested lower boundary, not that all lifetime history was collected. `incremental_history_covered` means recent pages plus older completed coverage serve the selected window. Resume retains the original bounded window, per-collection plan, page size and cursors, even if the UI selection changes or time passes. Start a fresh job for another timeframe. Legacy unbounded rental-history jobs cannot resume from the dashboard; start a fresh job with a supported timeframe. Existing observations remain saved.

Incremental history policy v1 uses a **48-hour overlap** before the previous completed scan's start time, never the maximum returned event timestamp. It requires a completed, ordered scan of the same collection covering the requested older boundary. The first run after this upgrade establishes that baseline; legacy/imported samples alone cannot. Coverage is promoted per collection only when the final page and checkpoint commit. Incomplete or failed scans cannot make the next run skip older pages. Canonical addresses match aliases, and monetary/record deduplication remains unchanged.

The next requested refresh **seven days after the last full-window scan began** must scan the selected window in full. Incremental refreshes do not reset that clock. A newly included collection, a wider window or invalid baseline also requires a full scan. If the overlap already covers the whole requested window, that scan counts as full after completion. There is no scheduler. Late or changed records inside the overlap are reread; older corrections may wait for the next full scan. Full and incremental scans both retain timestamp ties and changed variants and never stop at the first duplicate. Listing snapshots continue using their existing collection behavior; this optimization applies only to rental history.

New rental-history collection is limited to the most recent 90 days. For custom collection ranges, the earliest start is UTC today minus 89 days, giving 90 inclusive UTC calendar dates. Older custom ranges can inspect saved data but cannot launch a history scan, because reaching an old interval would require traversing every newer page. **Collect market listings**, which also gathers history, follows the same selected timeframe and safeguards. Listing-only comparison collection fetches current listings: the API cannot retrieve historic asking-price snapshots for a past date. Listing timeframe selection filters the snapshots already stored locally; collecting current prices cannot fill an older interval.

Dashboard batches still inherit `MARKETAPP_MAX_PAGES`, `MARKETAPP_MAX_ATTEMPTS`, and `MARKETAPP_RUN_SECONDS`, but automatic continuation now has an outer cap: **100 Marketapp HTTP attempts per start/resume, 500 per rolling 24 hours, and 300 seconds per start/resume** by default. Retries and catalog requests count. Marketapp pacing is at most one sequential request per second. The rolling counter persists across dashboard jobs and restarts in the queue database. These are application safeguards, not Marketapp-published quotas, and do not aggregate the separate CLI, Telegram prototype, other databases, or other clients using the token. Set `MARKETAPP_DASHBOARD_MAX_ATTEMPTS`, `MARKETAPP_DASHBOARD_DAILY_MAX_ATTEMPTS`, and `MARKETAPP_DASHBOARD_RUN_SECONDS` locally to change them.

Reaching an outer cap pauses with saved progress and requires **Resume**; a daily cap cannot be bypassed by resuming or starting another dashboard job. Provider `Retry-After` is honored, and a delay beyond the remaining job duration pauses promptly. Original queries and page size remain fixed; start a new job to refresh from the head or include changed portfolio scopes. No scheduler or automatic price change is activated. CLI invocations retain their existing page/request/time budgets and do not inherit the dashboard's selected timeframe.

The CLI supports both workflows without optional web dependencies:

```powershell
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 collect-prices --wallet YOUR_WALLET_ADDRESS
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 collect-prices --resume LISTING_RUN_ID
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 collect-rental-prices --wallet YOUR_WALLET_ADDRESS
& .\.venv\Scripts\python.exe -m marketapp_rent --db data\marketapp.sqlite3 collect-rental-prices --resume RENTAL_RUN_ID
```

`--review-directory PATH` includes explicitly selected reviewed portfolio gifts in a fresh manifest. `--page-size` overrides the default 100. `--max-pages`, `--max-attempts`, `--run-seconds`, `--requests-per-second`, `--timeout`, and `--retry-attempts` override invocation budgets. Exit statuses remain `0` complete, `3` partial/interrupted, `1` operational failure, and `2` invalid configuration. Use the matching command to resume a listing or rental run. Credentials, databases, and personal exports remain ignored by Git.

## Verification

Tests use mocked HTTP, fixed clocks, public evidence fixtures, and temporary databases. They cover decimal rates and averages, source/window selection, inclusive UTC dates, event-time versus observation-time filtering, aliases/replays/variants, own-portfolio inclusion, extensions, currencies, invalid amounts and durations, missing traits, exact Black, minimum distinct gifts, bounded resume, API exports, and offline source switching.
