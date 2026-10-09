# Changelog

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
