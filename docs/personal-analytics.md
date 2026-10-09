# Personal rental analytics

Overview can show a saved snapshot of your own Marketapp rental analytics. This is separate from the gift-price recommendation samples and public NFT history. Importing analytics does not alter portfolio membership, asking prices, recommendations, or provider request counters.

## Refresh in Telegram

In the private Telegram app, open **Overview**, select **Last 30 days** or **1 year** beside **Refresh analytics**, choose your wallet, and approve Marketapp's login request. The app signs in for this refresh, reads all-collection analytics with daily grouping, and saves the validated snapshot. It shows the capture time; reporting-period and chart-grouping switches continue to read saved data only.

Every refresh requires a fresh approval from the saved mainnet wallet. The separate connection uses memory only and leaves the dashboard wallet connection alone. Login cookies and proofs are not retained in the database or browser storage. Closing Overview or reloading cancels the pending approval; a request already sent may finish. Start again if the five-minute approval expires. Starts share a one-minute cooldown and five-per-hour allowance with connection tests. A refresh makes at most three Marketapp website requests, with no automatic authentication retries or collection API requests.

This uses Marketapp's website integration rather than a documented analytics API. Login rejection, wallet mismatch, missing/changed HTML, inconsistent totals, redirects, and timeouts leave earlier analytics available. A successful wallet connection alone is not a successful refresh: the backend requires Marketapp to accept the proof and return the saved wallet's requested daily period. A wallet-approved annual refresh has been verified in the private Telegram app; future refreshes still require a fresh approval.

Returning from the wallet or reopening Overview checks the last refresh result from the private backend without requesting a new approval or contacting Marketapp. An update already sent can finish while the app is in the background. Failed results keep their fixed `MA-…` code visible; if status cannot be read, **Check status** reloads only saved progress. A saved result is confirmed against the exact committed snapshot. Only fixed stages, timestamps, booleans and an internal snapshot fingerprint are retained for this check, never login data or website HTML.

Marketapp's **Rent duration** histogram is recognised separately from the four daily financial charts. Its duration categories do not supply dates or values for the saved daily statistics. Missing daily data, changed totals and unknown chart types still fail validation.

## Capture and update on desktop

1. Open **Overview → Update analytics** and open your Marketapp analytics page in a normal browser where you are signed in to Marketapp.
2. Select **Rent**, **all collections**, the desired reporting period, and **By Day**. Daily source values are needed to build weekly, monthly, and calendar-year charts. To capture annual statistics, choose Marketapp's **1 year** reporting period before capturing. The app accepts up to 366 consecutive daily dates; this is independent of the 90-day comparison-history collection limit.
3. Use the capture bookmarklet supplied by the dashboard. Save it as a browser bookmark, with the copied `javascript:` code as its URL, and run that bookmark on the analytics page. The browser downloads `marketapp-rent-analytics-YYYY-MM-DD.json`. Browsers may remove `javascript:` when pasting into the address bar; saving a bookmark avoids that problem.
4. Return to Overview and choose **Import snapshot**. Select the downloaded JSON file. Importing it in the desktop app stores it locally. Importing it in the private Telegram app sends it to that app's private backend. The two stores remain separate.

To refresh, capture a new snapshot from the signed-in Marketapp page and import it again. The dashboard's normal saved-data polling only reloads the imported snapshot; it does not sign in to Marketapp or automatically refresh personal analytics. The capture code reads visible metric tiles and chart data attributes. It does not read cookies, wallet proofs, API keys, browser storage, or the rest of the account page, and makes no network requests of its own. Loading the Marketapp page still uses Marketapp's website normally.

The **Reporting period** selector uses separately saved snapshots, captured in the browser or refreshed in Telegram. Save both **30 days** and **1 year** to switch between their source totals. Changing chart grouping only changes the breakdown within that saved period. It does not fetch a longer period. The newest capture for each period length is available, up to eight lengths; exact dates and capture time are always shown. Older snapshots remain stored. Shorter-period distinct items and duration averages are not calculated from an annual snapshot.

The source must be a Marketapp rental analytics page for the dashboard's saved wallet. Address aliases are compared by canonical mainnet TON identity. Collection-filtered captures, aggregated charts, malformed files, inconsistent totals, and mismatched wallets are rejected. An unsuccessful import leaves existing analytics in place. Manual captures are user-supplied snapshots. Telegram refresh additionally verifies the website login and page wallet/period; neither workflow is an on-chain payment attestation or ownership proof.

## Meaning of the figures

- **Rent volume** is the amount renters paid for your items during the captured period, in GRAM, **before marketplace fees and royalties**. It is not net proceeds received, wallet balance, or lifetime revenue.
- **Rentals** includes new rentals and extensions. Their counts are also available separately. **Rented items** is Marketapp's distinct-item count for the entire captured period; it cannot be reconstructed or subdivided from daily aggregate counts.
- **Price per day** is Marketapp's rent volume divided by rented days. The app retains that reported aggregate; it does not average the daily rates. Reported average duration, extension share, and spending remain separate metrics.
- Daily volume and counts are summed for weekly buckets starting Monday, calendar months, and calendar years (January 1–December 31). The first and last bucket may cover only part of a week, month, or year. **By year** is a calendar-year chart grouping, while **Last 1 year** is the rolling reporting period for its summary. A 365-day rolling capture can span two partial calendar-year bars; their combined volume covers the saved reporting period. No missing months are projected and overlapping snapshots are never added together. The capture day may still be in progress. All period dates and grouping use UTC.
- Zero volume or counts remain zero. Missing optional values remain unknown. Money is retained as decimal text and summed exactly at the provider's supplied precision; chart values themselves may already have been rounded by Marketapp. The period volume preserves Marketapp's reported tile value. Daily sums must reconcile after rounding to that tile's precision, with at least two decimal places; rental counts must agree exactly. Small differences in the final decimals can therefore remain between a reported period volume and grouped chart totals.

The displayed period and capture timestamp accompany the saved figures. The source can include rentals of gifts that you no longer own. A finite reporting period does not establish lifetime income. No daily distinct-item count or net revenue is invented from the available aggregates.

## Storage and access

Snapshot imports are limited to 256 KiB. Raw capture JSON and normalized data are retained as immutable snapshots, scoped to the saved wallet. Reimporting identical data is idempotent. Importing an older capture does not replace a newer one. Original Marketapp collection records and their fingerprints are unchanged.

The desktop import endpoint is loopback-only and requires the dashboard's same-origin/CSRF protection. It can import and display snapshots while provider networking is disabled. Telegram imports and refreshes require the private app's existing owner authorization. The refresh endpoints accept only a freshly issued encrypted envelope and bounded wallet approval, not user-supplied website cookies or arbitrary URLs. The documented Marketapp API GET allowlist is unchanged. Only extracted snapshot JSON is saved; authenticated HTML, cookies, proofs and wallet state-init are discarded.

Personal snapshot downloads, local databases, and exports are private operational data. `marketapp-rent-analytics*.json` is ignored by Git. Keep snapshots outside source folders and do not add them to test fixtures or releases. Tests use synthetic data.
