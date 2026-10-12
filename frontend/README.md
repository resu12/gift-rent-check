# Gift Rent Check frontend

React and TypeScript render the local dashboard and Telegram Mini App, with separate private-owner and invited-account paths. Both compare saved listing prices or recorded rental rates by collection, exact model, and exact Black backdrop. Pricing opens with Actual rentals, Last 30 days, and Biggest increase first; My gifts defaults to Last rented. Owned gifts participate in the averages. Gift prices display to three decimals, and insufficient evidence stays unknown. See the [v0.4.0 beta release notes](../docs/releases/v0.4.0.md).

## Development and builds

Use Node.js 24 and pnpm 11.25.0. From the repository root:

```powershell
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend test
pnpm --dir frontend build
pnpm --dir frontend build:serverless
```

Both builds include strict TypeScript checking. The local build writes `frontend/dist/`; the Telegram build writes `serverless/dist/`. Generated bundles are ignored by Git. Run `scripts/build-dashboard.ps1` to build and copy local assets into the Python package before launching the dashboard or packaging a wheel. Run `scripts/build-serverless.ps1` for the complete frontend/backend check and Telegram build; it does not publish.

For Telegram wallet connections, copy `frontend/.env.example` to `frontend/.env.local` and set `VITE_TONCONNECT_APP_URL` to your deployed HTTPS origin. Optionally set `VITE_TELEGRAM_RETURN_URL` to your bot's `https://t.me/YOUR_BOT?startapp` Main Mini App link. Process environment values take precedence. These settings are public and must contain no credentials. Without an app URL, the build disables TON Connect. Configured builds emit the public manifest and PNG icon; deployment validates the manifest against its explicit app ID. See the [wallet setup and limitations](../docs/telegram-serverless.md#connect-and-disconnect-a-wallet).

For local UI development, start the Python dashboard on port 8765, then run `pnpm --dir frontend dev`. Vite binds to loopback and proxies `/api` to Python. Use the Python server's production URL for normal operation and mutation/CSRF checks.

For the Telegram UI with synthetic data, build the serverless bundle and run `node serverless/tools/mock-server.mjs`, then open `http://127.0.0.1:8766`. This uses local SQLite and a mock Telegram identity. The mock SDK and tools are never included in the deployment.

## Data and authentication

Components use the `DashboardAdapter` interface. `src/data/local.ts` reads the local Python API and starts manual jobs with its server-issued CSRF token. `src/serverless/cloudAdapter.ts` calls Telegram endpoints; the backend uses Telegram's verified human user ID to select the private owner or an authorized, isolated invited account. Browser-supplied identity is not authorization, and open registration is disabled. See the [Telegram guide](../docs/telegram-serverless.md) for configuration and deployment. Deployment-specific invitation settings belong in the ignored `serverless/tgcloud/lib/public-release-config.js`; setup preserves an existing file and otherwise copies the disabled example.

Provider credentials and deployment snapshots stay outside the frontend. Production assets use self-hosted JavaScript, CSS, and system fonts. Gift images use backend-approved HTTPS URLs without a referrer. API failures preserve previous data with an error/stale indication; they do not substitute a demo dataset.

The private owner's optional mainnet TON Connect session exposes a connected address separately from the saved portfolio wallet. That connection requests no transaction or signed ownership proof and grants no backend access. Disconnect retains the private saved data and refresh behavior; connecting another wallet never reassigns imported gifts. Invited accounts instead approve a read-only ownership proof for the app's own domain before wallet discovery and comparison collection; disconnecting their verification disables those actions until a fresh proof is approved. The pinned SDK is bundled locally, while its wallet list and connection bridges use the SDK's external services.

The private owner's **Refresh analytics** uses a separate, temporary TON Connect session to request a fresh Marketapp login proof for the saved wallet. **Remember Marketapp login** optionally stores an encrypted website session in the private backend so later refreshes can skip wallet approval; **Disconnect Marketapp** deletes it. Saved analytics and the ordinary wallet connection remain intact. Invited accounts do not have website login or analytics refresh enabled. Rental volume displays to one decimal, while asking prices and recommendations keep three decimals. See the [analytics refresh workflow and limits](../docs/telegram-serverless.md#refresh-marketapp-analytics). Desktop keeps browser capture/import.

## Behavior

The UI includes grid and detailed pricing views, search, collection/state/Black filters, infinite scrolling with a Load more fallback, gift details, provenance, and resumable refresh jobs. Recommendations come from the backend, require at least three distinct gifts in the applicable cohort, and respect the selected source and timeframe. The Black filter restricts collection averages as well as model averages. Recorded rental rates are not proof of income received by the current owner.

My gifts also offers **Simple** cards and a **Detailed** table. Each section remembers its own display preference. Membership, search, collection and state filters, progressive loading and gift details remain available in both inventory views. The refresh icon in Pricing or My gifts explicitly checks known gifts' prices and status within the existing limits; it remains disabled while a check finishes or when checks are unavailable. Candidate-only views do not add candidates to the check.

Telegram's startup and manual refresh use the private owner's remembered Marketapp login when available, then targeted TON checks for missing details and exact rental expiry. Without that login, and for invited accounts, the known gifts are checked through TON. The TON phase uses no Marketapp requests; website reads have separate safeguards. Additional TON checks show their own progress and provider waits instead of leaving the website result at 99%. These checks do not discover gifts or change membership. Overview's **Available** tile and My gifts filter combine saved rent listings with freshly verified idle contracts, counting each gift once. An idle contract alone does not confirm a visible Marketapp listing; **Marketapp listings** remains a separate filter. Historical or uncertain idle evidence does not qualify. Desktop's icon remains a price check; its existing **Refresh gift status** command checks rental status. Gift images in both versions show a small clock mark for supported current rentals; expired or uncertain evidence receives no mark.

On a fresh visible Telegram opening, known-gift and remembered-login analytics checks settle before an optional automatic comparison batch. Comparison startup freezes the opening source/timeframe, requires the account's API key and eligible portfolio collection mappings, and reuses completed scans for one hour. A persisted hourly gate and a backend cap of 20 attempts/60 seconds prevent repeated openings from spending the manual allowance. The client quietly interrupts at its bound or on hiding, reconciles saved progress once, and never records an automatic timeout as the user's Stop. Manual comparison actions retain their normal budgets; existing paused manual work is preserved.

Desktop Marketapp collection still starts through an explicit action. Its separate known-gift startup check uses TON and is enabled with `--allow-price-refresh` (or `--allow-network`, which also enables manual collection). Without either flag the local dashboard is offline. The versions retain separate data stores, and neither changes prices or submits transactions. See [automatic Telegram comparison checks](../docs/telegram-serverless.md#automatic-comparison-check).

Tests cover filter defaults, decimal formatting, ownership/visibility distinctions, saved-data refresh, request drivers, interruption/resume, and safe links. Full evidence rules are in the [pricing guide](../docs/pricing.md).

Telegram storage uses the [compact-storage design](../docs/development-storage-plan.md), with bounded cleanup and growth monitoring described in the [storage guide](../docs/storage-maintenance.md). Publishing this frontend does not reset saved data or convert existing accounts; the development reset is a separate explicit operation.
