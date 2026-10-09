# Changelog

## 0.3.0 — 2026-10-09

This release adds personal rental analytics to Overview, including a wallet-approved refresh in Telegram, and makes desktop setup and saved sync recovery easier.

### Added

- Telegram Overview can refresh **Last 30 days** or **1 year** rental analytics after a fresh Marketapp wallet approval. A bounded, separate website client verifies login and imports the same-wallet daily snapshot. The temporary session and proof are never persisted; an encrypted, five-minute envelope stays only in browser memory. Website reads do not spend comparison-collection API allowance, and failed refreshes retain prior snapshots. Desktop capture/import stays unchanged.
- Retained the earlier **Connect Marketapp** proof-compatibility test as a fallback for deployments without analytics refresh. The current Telegram Overview uses **Refresh analytics**. SDK console logging is removed from the Telegram build.
- Personal Marketapp rental analytics snapshots in Overview, with a saved reporting-period selector and daily, weekly, monthly, and calendar-year volume/count charts. Annual statistics use a separately captured one-year snapshot; chart grouping does not change the reporting period. Calendar-year bars mark incomplete coverage as partial. A browser capture and private JSON import preserve source dates, gross-before-fees meaning, and previous snapshots without using the collection API or importing website credentials.
- Desktop API-key settings with masked entry, session-only use, optional Windows Credential Manager storage, and removal. Environment configuration retains precedence; entered keys never appear in responses, browser storage, or the application databases.

### Fixed

- Telegram analytics refresh accepts Marketapp's separate rental-duration histogram alongside the daily financial charts. Refresh results and fixed failure codes remain available after returning from the wallet or reopening the Mini App; saved snapshots are confirmed from storage before reporting success.
- Telegram analytics-refresh limits distinguish the one-minute cooldown from the rolling hourly allowance and show an exact retry countdown. Refresh is disabled while waiting and becomes ready without automatically issuing a wallet request. Previous snapshots remain visible.
- Legacy Marketapp compatibility tests explain failed wallet, network, website, challenge, timestamp, or signature-format checks using fixed reason codes, without revealing or storing wallet proofs.
- Repeated compatibility tests report their cooldown or hourly allowance explicitly. A successful approval remains visible if another start is blocked by the test limit.
- Paused desktop syncs explain missing setup or disabled collection instead of claiming they are ready to continue.
- Listing page saves gather collection evidence once per page, avoiding repeated full-history scans while preserving address aliases, conflicts, and atomic checkpoints. Pricing resumes reuse frozen targets without rebuilding the dashboard first.
- Listing comparison progress counts finished comparison checks, so completed model checks remain visible before an entire collection finishes. Older saved jobs use their existing check counts too.
- Older history scans without a supported saved timeframe offer a new 30-day scan instead of a Continue action that would fail. Their records and checkpoints remain intact; valid bounded scans keep their original timeframe on resume.

### Compatibility

Existing portfolio and price observations remain intact. Personal analytics use separate snapshots and do not change recommendations or comparison API allowances. The new analytics and login-attempt tables are additive; refresh results reuse the saved attempts and are confirmed against their committed snapshots. Telegram's website integration remains experimental and requires a fresh wallet approval for each refresh. Desktop retains browser capture/import. No scheduling, transactions, or automatic price changes are enabled.

## 0.2.0 — 2026-10-09

This release makes the desktop and Telegram dashboards easier to read, with clearer prices, shorter status messages, and expandable supporting evidence.

### Changed

- Improved text sizes, spacing, touch targets, and responsive layouts across Pricing, Overview, My gifts, Activity, and gift details. The app title now consistently uses **Gift Rent Check**.
- Refined the **Simple** grid with visible cues for saved prices, missing prices, and differing currency units. Available recommendations include a compact distinct-gift count and comparison match; full explanations remain in gift details.
- Separated **sample size** from **comparison match**. Size bands use distinct gifts: **Limited** (1–2), **Small** (3–9), **Medium** (10–29), and **Large** (30 or more). Match labels distinguish **Collection estimate**, **Same model**, **Model + Black**, and **Collection + Black**. These describe the evidence, not statistical confidence or forecast quality.
- Put current and suggested prices first in the detailed view and gift drawer. Comparison statistics, sources, rental-history dates, ownership evidence, addresses, and limitations expand separately.
- Simplified sync cards while keeping progress, pause causes, failures, and cached-data age visible. The main view shows one current sync, with other updates in Activity. Completed checks show compact summaries; **Refresh & export** groups the data actions.
- Added explicit **Your gifts**, **Candidates**, and **All** inventory scopes. Search, collection, and status filters apply within the selected scope, with a reset action for empty results. Overview links preserve the membership scope of their counts.
- Shortened error and wallet-connection messages while retaining details, retry actions, and the distinction between a connected wallet and the saved portfolio.

### Fixed

- Page navigation returns to the top and focuses the destination content.
- The gift drawer keeps its close control visible while scrolling, restores focus when closed, and distinguishes backdrop clicks from clicks inside the drawer.
- The latest-observation indicator includes successful price-only observations.

### Compatibility

Price calculations, the minimum of three distinct gifts for a recommendation, collection limits, and provider request behavior are unchanged. Existing API and export fields remain compatible, including the legacy `confidence` field; the dashboard presents sample size and comparison match separately. This release adds no scheduling, transactions, or automatic price changes.
