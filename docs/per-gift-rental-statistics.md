# Per-gift rental statistics

Overview's **By gift** appears directly beneath **Rental analytics** and uses its **Report period** selector. The data comes from the connected wallet's Marketapp **Top items** table. It does not substitute public collection history or TON estimates for account analytics.

Overview opens with **All time** selected by default. Choosing a period applies to the charts and both statistics lists and survives data refreshes. **Status → View** still opens its specific report; a later normal visit to Overview returns to All time.

Opening an individual gift also shows **All time rentals**: its saved Marketapp rental count and volume, with rented days and price per day in **Report details**. This always uses All time, independently of the Overview selector, and matches the gift by its canonical NFT address within the current wallet. **Report details** shows the exact volume, included report periods, missing/partial days, and capture dates. Opening a gift makes no additional provider request. Gifts absent from the saved Top items have unknown totals rather than zero rentals.

For **Last 30 days** and **Last 1 year**, rentals, rented days, volume and price per day are the values Marketapp reported for that captured period. The capture age stays visible; exact report dates and times are in expandable details. Refresh the analytics report to update both the charts and Top items. This shares the existing authenticated request, wallet validation and request limits; it adds no separate provider requests. Browser imports support the same table.

Volume is before marketplace fees and royalties. It displays one decimal, as elsewhere in the app; expand a gift for the exact saved amount. Daily price displays three decimals. This is not net profit or income accrued day by day. Search, sorting and **Show more** only read saved data.

Overview rows display saved gift pictures matched by canonical NFT address. Collection rows show a representative saved gift from the exact named collection, identified as an example rather than official collection artwork. These thumbnails reuse the current dashboard's image links, load lazily without sending a referrer, and fall back to a gift/collection icon if an image is missing or fails. No image files are added to analytics storage; historical rows without a matching saved gift remain available with a fallback icon.

Marketapp supplies a ranked subset, so a gift absent from Top items is **unknown**, not zero. The table can include gifts no longer in the current portfolio. Older reports that did not capture Top items show a request to refresh the selected period; the app never fills them from another period.

## All time and retained history

Top items gives totals for a whole reporting period. It does not provide per-gift daily records, so two overlapping reports cannot safely be added or split. **All time** preserves compact per-gift report observations and selects non-overlapping periods covering the most saved days for each gift. It shows those dates, missing days and partial capture days when expanded. With one saved annual report, that is the available per-gift coverage; it is not a complete lifetime total.

Exact duplicates do not add rentals. Newer observations replace the same gift and exact period. Reports missing a previously observed gift do not erase its saved history. Gifts may therefore have different coverage, and their totals need not add up to the all-time daily chart. For combined periods, price per day is saved volume divided by rented days; one selected period retains Marketapp's reported price.

Normal snapshot replacement and cleanup preserve the compact per-gift archive. Account deletion removes that account's archive. Wallet and account boundaries apply to the period reports, archive and derived views. Desktop uses retained immutable snapshots; Telegram archives rows atomically with validated snapshot writes. No raw authenticated HTML, cookies or wallet proofs enter the archive.

The older **Saved market history** disclosure in gift details remains a separate diagnostic of incomplete public history and verified starts. Its source and coverage differ from personal Marketapp analytics.

## Statistics by collection

Overview also shows **By collection** for the same selected analytics report. Rentals, volume and price per day come directly from Marketapp's **By collection** table, including collections outside the ranked Top items list. Collection totals are never calculated by summing the displayed gifts. Search, sorting and expanding rows use saved data only.

Collection names identify the saved observations. Names are trimmed, whitespace is collapsed and case is ignored for matching; a renamed collection is treated as a separate identity. Refreshing analytics or importing a new browser capture saves this table alongside the charts and Top items, with no additional provider request. Older captures without the table ask for a refresh; absent collections have unknown figures rather than zero rentals.

All time preserves compact collection observations, selecting non-overlapping periods separately for each collection. Expanded rows show exact amounts and saved coverage. A single selected report retains Marketapp's price per day. When multiple periods are combined the rate is unknown: By collection does not report rented days, and dividing by rounded daily rates would invent a denominator. These partial saved totals can differ from the wallet's daily All time chart and are not a complete lifetime total. Account deletion removes the account's collection archive; ordinary cleanup and report replacement retain it.

Per-gift and collection views allow the same 30-second device clock difference as the analytics status. Visible-page clock updates and returning to the app revalidate figures, so a temporary clock mismatch cannot leave otherwise valid saved data hidden indefinitely.

### Telegram upgrade

Before publishing the collection feature, apply the additive schema for `personal_analytics_collection_reports` and `public_personal_analytics_collection_reports`, then rerun `install-analytics-daily-storage.mjs --action install` with the deployment's explicit app and owner IDs. The installer preserves existing daily/gift triggers and adds the collection triggers and storage accounting (24 archive triggers in total). Publish the new runtime and frontend next so that the new retention guard protects legacy collection evidence during concurrent refreshes. Then run the existing bounded backfill for both private and public scopes, following each returned cursor until complete. No data reset is needed. Captures without a By collection table need a normal analytics refresh after publication.
