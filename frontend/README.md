# Gift Rent Check frontend

React and TypeScript render the local dashboard and private Telegram Mini App. Both compare saved listing prices or recorded rental rates by collection, exact model, and exact Black backdrop. New openings use Actual rentals, Last 30 days, and Biggest increase first. Owned gifts participate in the averages. Prices display to three decimals, and insufficient evidence stays unknown.

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

Components use the `DashboardAdapter` interface. `src/data/local.ts` reads the local Python API and starts manual jobs with its server-issued CSRF token. `src/serverless/cloudAdapter.ts` calls Telegram endpoints; the backend checks Telegram's verified human user ID against its private allowlist. Browser-supplied identity is not authorization. See the [Telegram guide](../docs/telegram-serverless.md) for configuration and deployment.

Provider credentials and deployment snapshots stay outside the frontend. Production assets use self-hosted JavaScript, CSS, and system fonts. Gift images use backend-approved HTTPS URLs without a referrer. API failures preserve previous data with an error/stale indication; they do not substitute a demo dataset.

An optional mainnet TON Connect session exposes a connected address separately from the saved portfolio wallet. It requests no transaction or signed ownership proof and grants no backend access. Disconnect retains saved data and refresh behavior; connecting another wallet never reassigns the imported gifts. The pinned SDK is bundled locally, while its wallet list and connection bridges use the SDK's external services.

Telegram's **Refresh analytics** uses a separate, temporary TON Connect session to request a fresh Marketapp login proof for the saved wallet. It saves validated personal analytics without changing the ordinary wallet connection. See the [analytics refresh workflow and limits](../docs/telegram-serverless.md#refresh-marketapp-analytics). Desktop keeps browser capture/import.

## Behavior

The UI includes grid and detailed pricing views, search, collection/state/Black filters, infinite scrolling with a Load more fallback, gift details, provenance, and resumable refresh jobs. Recommendations come from the backend, require at least three distinct gifts in the applicable cohort, and respect the selected source and timeframe. The Black filter restricts collection averages as well as model averages. Recorded rental rates are not proof of income received by the current owner.

Marketapp collection begins only through an explicit action and stays within persistent limits. On each fresh visible page opening, a shared bounded TON-only check can update configured asking prices of already known gifts. It does not discover gifts or refresh comparison averages. Telegram enables this check; the local dashboard enables it with `--allow-price-refresh` (or `--allow-network`, which also enables manual collection). Without either flag the local dashboard is offline. Both versions share startup, progress, Stop, and browser visibility behavior; they retain separate data stores. Neither frontend changes prices or submits transactions.

Tests cover filter defaults, decimal formatting, ownership/visibility distinctions, saved-data refresh, request drivers, interruption/resume, and safe links. Full evidence rules are in the [pricing guide](../docs/pricing.md).
