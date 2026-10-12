# Changelog

## Unreleased

## 0.4.0 — 2026-10-12

Development / invitation-only beta. See [release notes and upgrade steps](docs/releases/v0.4.0.md).

### Added

- **Status** replaces Activity with separate freshness, last-check dates and actions for gifts, current prices, comparison averages and each analytics period. Connections clearly separate wallet verification, Marketapp login and API-key management.
- **My gifts** offers Simple and Detailed views, search, filters and remembered sorting. Last rented is the default; verified current rental starts remain stable during refreshes. Rented cards show a live remaining-time badge, with `≈` for website estimates.
- Telegram supports pull-to-refresh and bounded checks on opening. The private owner's remembered Marketapp login can refresh known gifts and personal analytics; TON checks fill missing gift details and rental expiry. Eligible comparison checks follow using the account's API key. Each source retains its own limits, cooldowns and saved dates.
- Quick price actions copy a recommendation when tapped, open the gift on Marketapp and verify an individual gift after a manual edit. Observed price changes include saved rental performance over equal 7-, 14- or 30-day periods; no automatic price changes are made.
- Analytics charts show period, volume and rental count when pressed or dragged. Volume displays to one decimal; gift prices retain three. The private owner can remember an encrypted Marketapp login for up to seven days and disconnect it separately.
- Invitation-only accounts verify their own wallet and use their own encrypted API key, isolated portfolios and resumable discovery. Account export, confirmed deletion and explicit reactivation are available. Open registration remains disabled.
- Storage monitoring shows estimated usage, cleanup progress and bounded daily growth samples. Capacity forecasts require enough recent observations; application budgets remain distinct from verified hosting capacity.

### Changed

- Compact Telegram storage retains full operational state only at the current checkpoint, the latest resumable scan bodies and the newest 20 terminal scan bodies. Event identities, replay bindings, request usage and small refresh summaries remain available.
- Repeated structured evidence shares an exact canonical payload within an account generation. Immutable occurrences retain dates, envelopes and order; conflicting or distinct source fields remain distinct. Full HTTP response copies are discarded after validated observations are saved.
- Storage admission accounts for normalized data and atomic checkpoint retirement. Cleanup runs bounded, resumable batches and skips legacy history compaction for compact accounts. Fresh accounts use the compact layout once its required triggers are installed; an existing account changes layout only through the explicit development-reset procedure.
- Dashboard reads use bounded evidence batches, compact lossless responses and lighter revision polling. Failed reads retry within a deadline and expose fixed diagnostics without private runtime details.
- Recommendations continue to use valid saved model/backdrop traits regardless of age. Source dates and age warnings remain visible; comparison windows, minimum samples and conflicting-evidence exclusions are unchanged.

### Fixed

- Gift refresh no longer looks stuck at 99% after Marketapp has read every card: additional TON checks have separate progress, provider waits show **Waiting**, and an incomplete check remains distinct from saved gift data. This includes the deployed revision 103 progress fix.
- Gift checks retain verified rental starts across intermediate website results and failed TON lookups. Cached checks retain their original dates, and a completed check can be green while unavailable values remain separate warnings.
- Continue, Stop and comparison progress respect saved request leases and reject stale replies. Empty final pages finish coverage immediately; retained Telegram pages can recheck gifts after a completed check and a sufficiently long absence.
- Cleanup buttons remain stable between batches and show **Waiting** during other updates. Paused, failed and completed cycles have distinct actions, and delayed scheduling cannot indefinitely postpone the next batch.
- Account generations, credential versions, wallet/session checks and atomic writes fence old workers after account deletion, wallet changes or key removal. Request ledgers and encryption nonce counters survive removal; keys never return to the browser.
- Stop and key revocation remain available through bounded recovery writes when collection storage is paused. Rebuildable cache can be reclaimed without erasing saved financial evidence or resetting allowances.
- Desktop pricing and exports bound malformed decimal expansion, reuse request-local calculations and filter rental performance by canonical gift identity.

### Upgrade and limitations

- Deploy the additive schema, safe migration and compact-storage accounting/triggers before the new runtime. The development reset is a separate, explicit destructive operation: it removes comparison history, owned price/status observations and scan progress while preserving credentials, wallet settings, portfolio/traits, analytics and request/security ledgers. Normal publication does not reset data.
- Compact storage is not compatible with an older writer; do not roll back the runtime over compact accounts. The legacy private-owner copy tool rejects compact sources.
- Marketapp website login is undocumented and remains private-owner-only. Invited accounts use TON for gift checks and their own API key for comparisons; website analytics is disabled for them. Closed-app background collection is not promised.
- Public registration remains gated on verified hosting capacity, backup/recovery validation and operator/provider review. Logical byte budgets exclude some database/index overhead and do not establish a supported public user count.

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
