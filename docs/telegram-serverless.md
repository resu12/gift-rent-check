# Telegram pricing dashboard

This guide covers the preserved private owner and invitation-only beta accounts. See [v0.4.0 release and upgrade steps](releases/v0.4.0.md) for the current deployment order, and the [compact-storage plan](development-storage-plan.md) for storage retention and the optional development reset. Older checkpoint-reference procedures below are explicitly marked as legacy; they are not the compact-layout upgrade.

## Data status in Status

**Status → Data status** shows separate dates for known-gift checks, comparison averages and each saved analytics period. Gift rows show green **Checked** after a complete check within one hour, dated from its original start. Unverified statuses and unavailable prices remain orange warnings; Checked does not mean every value was confirmed. Other rows show green **Fresh** for recent confirmed coverage, and orange for older, incomplete or missing evidence. Additional check counts and successful value dates stay in **About these updates**. A failed check retains previous successful dates. Loading the dashboard, connecting a wallet or starting an unrelated sync does not make another row fresh.

Known-gift requests can reuse a check for five minutes; the green **Checked** indicator describes a complete check within one hour. Comparison coverage is fresh for one hour, and analytics for fifteen minutes when captured for the current UTC day. Comparison status applies to the displayed pricing timeframe and portfolio collections. Cached checks keep their original source dates; a collection with missing or conflicting identity prevents full green coverage. Analytics reporting periods have independent capture dates, so a fresh monthly report does not refresh the annual report.

Use the row's **Refresh** for known-gift prices/status, **Update** for its comparison source, or **View** to open analytics. **Continue** resumes a compatible paused comparison scan with its saved cursor and period. Completed collection coverage updates as pages finish; an interrupted scan stops showing **Updating**. Known-gift refresh does not discover newly acquired gifts; use Find new gifts separately. The visible-page clock updates labels locally without provider calls. **About these updates**, **Last gift check**, previous syncs and recent observations hold additional detail; all request limits, saved checkpoints and manual Stop controls remain active.

After Stop, comparison controls show **Finishing…** until saved status confirms the last request has released its lease or the lease has expired. The saved cursor remains intact; the browser clock alone cannot enable Continue. Custom rental periods ending on the current UTC day retain completed checks through their original saved history watermark, shown in **About these updates**. They are dated samples, with the same one-hour freshness limit; they do not claim to include rentals after that watermark. Fixed historical periods still require coverage through the selected end date.

**Continue** displays starting or pause/error feedback beside the selected row. An expired invocation no longer blocks continuing another saved source, while an active invocation or live request lease still does. When the current allowance is exhausted, controls show its saved availability time and keep the checkpoint; old daily-limit reasons do not block a restored allowance.

## Connections in Status

Open **Status → Connections** to see each connection's status and manage it:

| Control | Purpose and actions |
| --- | --- |
| Wallet | **Connect wallet** and **Disconnect wallet** manage the wallet-app connection. The private dashboard retains its saved portfolio wallet after disconnecting. Invited accounts verify their own wallet through a separate read-only proof approval. |
| Marketapp login | **Connect Marketapp** approves a website login and refreshes 30-day personal analytics. A remembered login also enables personal gift and analytics refreshes, for up to seven days. **Disconnect Marketapp** removes that login and retains saved data. It does not clear the wallet connection or API key. This experimental login remains unavailable to invited beta accounts. |
| Marketapp API key | **Add API key**, **Change API key**, and **Clear API key** manage the credential for collection comparisons and rental history. Entry is masked, and Telegram stores changes encrypted on the backend without returning the key to the browser. Saving accepts the format without making a provider request or starting a sync. Clearing retains saved gifts, history and request usage. |

For the original private owner, the configured bootstrap key remains usable until a key is explicitly saved or cleared. After Clear, it cannot silently return on restart; use Add to enable comparisons again. Finish or stop an active comparison update before replacing a key. Clear remains available during an active update and revokes it before checkpoint cleanup; old workers and saved traversals cannot resume with another key. API-key controls do not affect independent TON checks or Marketapp website login.

Existing private deployments need the additive `private_provider_credentials` table before publishing this runtime, together with any other missing tables from the current schema. Build and run preflight, publish the schema, inspect `migrate-check`, apply `migrate-safe`, and follow the [v0.4.0 storage setup order](releases/v0.4.0.md#upgrade-an-existing-telegram-deployment) before publishing the runtime and assets. The guarded commands below require the explicit app ID. Never reset credential nonce counters; backup recovery follows the encryption-key rotation guidance in this document.

## Public beta with your own API key

Public Telegram accounts are an opt-in, invitation-first beta configured in the Git-ignored `serverless/tgcloud/lib/public-release-config.js`. The setup script creates it from `serverless/public-release-config.example.js` only if it does not exist; rerunning setup preserves the deployment's invitation list and settings. Keep `enabled: false` for an unconfigured deployment. Enabling invitation access requires the reviewed origin, policies, backend encryption key and provider configuration below. Open registration remains disabled. The rest of this guide describes the private app unless it explicitly says public beta.

### Invitations in the existing private bot

With `enabled: true` and `preservePrivateOwner: true`, the configured original owner keeps the private dashboard, portfolio, analytics and login. Other callers go through the invitation gate and receive separate account-scoped storage. Public account and wallet-management endpoints deny the preserved owner, preventing an accidental second account; API-key actions use a separate private-owner path. Missing identities and non-invited users cannot fall through to private data. No private-owner migration is performed in this mode.

For an existing-bot rollout, configure that deployment's exact HTTPS app origin and invited Telegram user IDs locally, and serve the privacy notice and beta terms as static pages. After publication, invited users must close and reopen the Mini App, verify their own wallet, save their own Marketapp API key and choose Discover my gifts. An independent remembered TON Connect connection does not grant access; the private wallet control appears only after the dashboard loads successfully. Do not commit a deployment's invitation list or local configuration.

Both account paths share the provider request gate. The first status/reservation imports the private owner's raw rolling Marketapp and TON attempt timestamps and cooldowns through an atomic, durable seed marker. Administrative private allowance resets do not erase shared usage, and seed races cannot import attempts twice. The owner engines seed before reserving a local attempt. Provider denial removes an unsent local attempt and saves the shared wait; no HTTP request is sent. Private website analytics retains its existing separate read-only flow and is not enabled for invited users.

An invited user opens the Mini App, verifies their own mainnet wallet through TON Connect, saves their own Marketapp API key, and chooses **Discover my gifts**. Verification requests a proof for Gift Rent Check's own domain, never a transaction. The server checks the wallet's state-init, supported wallet code, signature, challenge, domain, and expiry. Wallet V3R2, V4R2, and V5R1 are supported; unknown/custom wallet versions fail safely. Merely connecting a wallet or supplying an address does not establish ownership. This wallet verification is separate from signing in to Marketapp.

API-key entry is masked and cleared after submission. Keys are encrypted in backend storage and are never returned to the browser, persisted in browser storage, or included in exports. **Save** makes no provider request; **Check key** makes one bounded collection-catalog GET using the saved key, counted against the normal allowance. Public collection never falls back to the operator's personal Marketapp token. Replacing a key invalidates its comparison cache; key changes fence pending requests, and old comparison work cannot resume under a different key. **Remove key** remains available during discovery and at the saved-payload cap. It directly revokes the credential without requiring a history write, fences pending credential workers, and cancels saved comparison/discovery work through a bounded recovery checkpoint. Replacement does not reset request usage.

Telegram's verified identity selects the account on the server. Wallets, credentials, portfolio membership, evidence, jobs, projections, and analytics use separate account scopes; a browser-supplied user ID cannot switch accounts. **Export saved gifts** downloads JSON containing the saved dashboard, analytics, and jobs; it is not a complete raw-evidence backup. **Privacy** and **Terms** links are available from account setup before wallet verification and in account settings. **Delete my data** requires explicit confirmation, immediately blocks further work, and removes keys, wallet verification, saved records, and progress in bounded cleanup batches. If cleanup is still pending, use **Reload settings** until it finishes. A deleted account stays disabled until the user explicitly chooses **Start again**. Non-secret security tombstones, nonce counters, and usage ledgers remain to prevent replay and allowance resets. Disconnecting verification retains the account's original portfolio wallet; changing to another wallet requires deleting the saved account and starting again.

Public refresh requests carry the account generation observed when work started. Old tabs cannot advance, resume, or stop a new account's reused job ID after deletion/reactivation, and delayed old responses cannot restore its progress. Reload saved data when the account changes in another session. Wallet disconnect also invalidates approvals issued before disconnection, including an approval whose signature was checked but whose binding has not committed; reconnect requires a fresh approval. Comparison controls stay disabled until verification is restored.

### Public-beta safeguards and coverage

These are application safeguards, not a statement of Marketapp's or TON Center's official quotas. Retries count. All time-based provider allowances use a rolling 24-hour window and survive restarts, key replacement, and account deletion/reactivation.

| Default safeguard | Limit |
| --- | --- |
| Invited accounts | 25; open registration disabled |
| Verified gifts per wallet | 250 |
| Discovery candidates | 1,000 |
| Marketapp HTTP attempts | 500 per user, 500 per API-key fingerprint, and 500 across the service |
| TON Center HTTP attempts | 1,000 per user and 1,000 across the service |
| Retained event, structured evidence, analytics, and projection payloads | 8 MiB per account; 128 MiB across public accounts |
| Recovery-only storage headroom | Up to 256 KiB per account; service headroom is the configured account cap multiplied by 256 KiB |
| Discovery invocation | 60 attempts and two minutes per Start/Continue |
| Discovery pagination | 50 items per page, 25 addresses per verification batch, 50 enumeration pages per invocation, 200 per saved run |

Provider-specific gates serialize reservations and pace requests at one per second across the service. Marketapp and TON retry deadlines remain separate. A shared allowance can pause a user even when their own key has unused allowance, and two accounts using the same key share its credential allowance. The storage caps cover retained payloads, not the entire SQLite file or platform capacity; database indexes, security metadata, and provider ledgers need additional operator headroom.

Discovery retains account-scoped candidates and its frozen catalog. Compact accounts keep the current full checkpoint, resumable scan bodies and the newest 20 terminal scan bodies; legacy accounts retain their supported delta/reference format until explicitly converted. Validated source observations are retained, with repeated structured payloads shared per account generation. Full HTTP response copies are discarded after validation. Repeated scans still add dated observations: compaction does not provide unlimited retention. At the payload cap, new data writes stop without advancing progress; **Stop**, **Remove key**, and account deletion remain recovery options. The extra recovery headroom admits only bounded cancellation/revocation checkpoints and cannot store provider observations or raise request allowances.

A new discovery refreshes Marketapp's free collection catalog using the user's key. Resume keeps that catalog and the saved wallet, page size, decoder version, and traversal boundary. Discovery combines direct holdings, indexed successful transfers, and previously verified gifts, then verifies current ownership. Only canonical addresses in eligible collections and direct ownership or supported decoded Marketapp rental contracts can enroll gifts. Unknown holders, unsupported contracts, conflicting metadata, and movement during verification remain unresolved and do not become verified members.

Enumeration completion and ownership coverage are separate. Changing holdings, indexer lag/backfill, and bounded transfer-history traversal prevent an instantaneous or guaranteed exhaustive snapshot. Invocation/provider stops retain a resumable checkpoint. Candidate, gift, or total-enumeration caps can leave a saved run incomplete and non-resumable; start a fresh bounded discovery after reviewing the limit instead of assuming the entire wallet was checked. Invalid or incompatible saved state requires a fresh run. Existing records remain retained. Idle rental-contract terms do not prove a visible Marketapp listing, and an expired rental is not proof of return. Comparison history also retains the selected bounded window and existing maximum 90-day collection period; analytics reporting periods do not expand that collection window.

Keep `experimentalPersonalAnalytics: false` for the public beta. The private app's undocumented Marketapp website login/analytics flow is not enabled for public users until those website requests receive separate reviewed provider allowances. A personal API key does not grant access to personal website analytics, and public onboarding never copies the operator's snapshots or remembered login.

### Operator preparation and guarded rollout

Use a dedicated beta deployment, or explicitly preserve the private owner with the invitation routing above. Before enabling public mode, configure `public-release-config.js` with the exact HTTPS app origin, `invitedUserIds`, capacity/request limits, and HTTPS `privacyPolicyUrl` and `termsUrl`. The operator must review hosting/storage encryption, retention/deletion behavior, and provider permission/capacity for this use, including any shared hosting/IP restrictions, then explicitly set `storageEncryptionConfirmed: true` and `providerUseApproved: true`. These flags record operator review; setting them is not a substitute for that review. Credential encryption is application encryption; it does not claim end-to-end encryption or an independently certified hosting configuration. Leave `openRegistration: false` and website analytics disabled. Generate the ignored backend encryption key with `node serverless/tools/prepare-refresh-key.mjs`; never include private keys or personal data in static assets or source control. Do not replace the encryption key of an existing deployment during an invitation rollout.

Set the frontend `VITE_TONCONNECT_APP_URL` to the same origin as `publicReleaseConfig.origin`, in the form `https://appYOUR_APP_ID.tgcloud.ai`. The publish preflight requires the manifest, app origin, CLI credentials, and explicit target app ID to agree, and checks static assets for secrets. A checkout has no default deployment target. Do not reuse another bot's CLI token or silently convert the current private deployment.

Run local checks before a reviewed rollout:

```powershell
node --test serverless/tests/*.test.mjs
Push-Location frontend
node --experimental-strip-types --test src/data/*.test.ts src/serverless/*.test.ts config/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
Pop-Location
& .\.venv\Scripts\python.exe -m pytest
& .\scripts\build-serverless.ps1 -Pnpm 'C:\path\to\pnpm.cmd'
```

Use the existing Python 3.12 virtual environment and locked Node/pnpm dependencies. The checks exercise synthetic accounts, mocked providers, address/proof validation, bounded discovery and resume, isolation, deletion, and preserved private behavior without provider requests. They do not establish that the public beta has been deployed or tested with live user wallets. Before inviting users, separately validate the published app with at least two accounts, explicit wallet approvals and each account's own key, while keeping provider tests bounded.

The following guarded commands describe invitation-table deployment for a new installation. Review the target, additive `public_*` tables, and the `wallet_disconnect_revision` fence column on `public_wallet_challenges` before the safe migration; no existing private records should be dropped. For v0.4.0, also follow the [release upgrade order](releases/v0.4.0.md#upgrade-an-existing-telegram-deployment), installing compact-storage accounting and triggers before the runtime. Configure public mode only after operator review, then build and publish the reviewed code/assets:

```powershell
node serverless/tools/manage.mjs --action publish-schema --app-id YOUR_APP_ID
node serverless/tools/manage.mjs --action migrate-check --app-id YOUR_APP_ID
node serverless/tools/manage.mjs --action migrate-safe --app-id YOUR_APP_ID
node serverless/tools/compact-storage.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --action setup
node serverless/tools/manage.mjs --action publish --app-id YOUR_APP_ID
```

A fresh beta deployment needs no private-owner data copy. Preserving the private owner alongside invited accounts also needs no copy. The following copy procedure supports only legacy private storage: it rejects a source already using `operational_storage_version: 1`. If deliberately converting a supported legacy private app, first stop its writes and provider collection, then publish the additive schema and migration-capable reader while public mode stays disabled. Keep private provider collection stopped until its previous rolling 24-hour requests have aged out before enabling public mode: the new service ledger cannot govern earlier requests or collectors running elsewhere. Inspect the copy plan, then explicitly confirm the same configured legacy human owner; copy is bounded to 25 records per invocation and prints aggregate counts only:

The copy rejects a source exceeding the 8 MiB account payload cap or projected total exceeding the 128 MiB public-service payload cap before it begins. Larger private datasets require a separately reviewed archival/capacity plan; the tool does not discard evidence or silently raise limits. The invitation rollout keeps the private owner in place rather than using this copy procedure.

```powershell
node serverless/tools/migrate-public-owner.mjs `
  --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --mode check
node serverless/tools/migrate-public-owner.mjs `
  --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --mode apply `
  --limit 25 --confirm-legacy-owner YOUR_TELEGRAM_USER_ID
```

Repeat Apply until the copy reports complete, keeping private writes stopped; source changes abort migration. The tool preserves existing records and checkpoints, makes zero provider requests, and does not transfer the private provider key or encrypted website cookies. It preserves only non-secret session generation, nonce, and cookie-version counters; any future website login needs fresh approval. The migrated owner must verify their wallet and add their own key through account settings. Ordinary onboarding cannot request this administrative copy or import another account's membership. Public-account deletion does not erase the retained private migration source or operator backups; the operator must manage their retention separately and disclose it.

Check, Apply, and Clear require `publicReleaseConfig.enabled: false` in both the local checkout and deployed backend. If a partial copy is blocked by changed source data or incompatible migration metadata, use `--mode clear --limit 25 --confirm-legacy-owner YOUR_TELEGRAM_USER_ID` with the same explicit app and owner IDs. Repeat Clear until `pending_cleanup` is false, then inspect a fresh Check and repeat Apply while private writes remain stopped. Clear removes only the inaccessible partial public copy in bounded batches; it preserves the private source and retained non-secret replay-protection counters. It refuses an already-active completed account.

Back up the complete encrypted database and private encryption key under operator access controls. Never reset credential/session nonce counters or restore older counters under the same key. A database rollback requires a reviewed key rotation before writing encrypted credentials again; users may need to re-enter their API keys and approve logins. Deletion intentionally keeps those non-secret replay-protection counters. Saved progress and evidence survive ordinary request limits; clearing an allowance is not a recovery procedure for invalid credentials, incompatible decoders, unknown holders, or storage exhaustion.

## Personal rental analytics

### Refreshing your saved gifts

At the top of a Telegram page, pull down until **Release to refresh gifts** appears, then release. This uses the same bounded gift check as the refresh icon. While another update is running, or gift checks are unavailable, the prompt changes to **Release to reload saved data** and only reloads saved results and progress. Pulling does not start analytics approval or a comparison scan. Gestures on controls, charts and scrollable panels remain separate; the desktop dashboard keeps its existing buttons.

On a fresh Telegram opening, **Pricing** and **My gifts** share one bounded refresh. For the private owner, it reuses the encrypted Marketapp login remembered from Overview and reads the signed-in **My NFTs** gift pages. The current observed layout returns up to 100 cards per page. Asking prices and For rent/Rented labels are saved only for canonical NFT addresses already in the portfolio; this does not enroll new gifts, infer collections from names, or add comparison samples. Website layout changes fail closed.

The page's remaining-time labels are rounded, so they never become exact expiry timestamps. Cards show these times with `≈`, reducing the saved duration locally at the precision supplied by Marketapp while exact expiry is unavailable. Targeted TON checks fill missing prices/status and verify rented gifts' exact contract expiry. Without a usable remembered login, the same saved wallet and known portfolio are checked through TON. No active TON Connect connection or wallet approval is needed for those read-only checks. A TON idle contract remains distinct from observed Marketapp visibility. **Discovery** and comparison collection remain separate actions.

Automatic starts reuse an unchanged completed scope for five minutes; the refresh icons bypass this cache. Concurrent page openings share work and permanently bind their own session to the original result. **Stop** discards late evidence while retaining the provider fence until the request settles or its lease expires. A changed wallet, including a change and restoration, rejects old commits.

Progress distinguishes website card reads from additional TON checks. Once Marketapp data is saved, the second stage shows its own checked/total count instead of leaving all gifts checked at 99%. Provider cooldowns show **Waiting**; an exhausted invocation shows a paused check with saved data retained. **Finishing gift checks** has no percentage while the result is being confirmed, and does not claim all missing values were resolved.

An interrupted comparison request shows **Waiting** while the app checks its saved status. This makes at most two status reads, with a bounded wait for an existing request lease; it never repeats the provider request. Once both the invocation deadline and lease expire, the saved job appears paused and can be continued from its cursor. Collection percentages count finished collections; the first collection can remain at 0% while its record count increases.

If private storage fills, comparison and gift checkpoint writes clear only rebuildable dashboard projections and retry the same guarded insert once. A failed recovery retains a fixed storage error and leaves progress unchanged. Historical provider evidence and credentials are never removed by this fallback. Source, wallet and login fences are checked again when publishing each write. Legacy checkpoint references use exact-content checks and primary-key lookups; compact checkpoints retire superseded state atomically. If clearing cache is insufficient, use the applicable [storage maintenance procedure](storage-maintenance.md) rather than resetting provider allowances.

For legacy storage only, the jobs maintenance phase handles older TON checkpoints whose inline Marketapp job exactly matches an earlier immutable `job_json` column. It uses bounded partitions with an `after` cursor, preserves the newest checkpoint, and checks source identity and exact JSON again in the atomic rewrite. This reference rewrite leaves observations and legacy response copies intact; compact storage instead retires superseded operational bodies on accepted writes.

Each private combined refresh allows at most 20 HTTP attempts over two minutes, including website retries and supplemental TON requests. Website reads have a 30-second validation deadline, one-second pacing, at most two attempts per page, and a separate rolling allowance of 100 requests per account and across the service. Analytics and personal gifts share this website lease and allowance; provider Retry-After deadlines survive app reopening. Marketapp API comparison allowances are neither consumed nor reset by a website refresh. TON uses its existing account/service request safeguards. The Telegram runtime cannot cancel an already stalled SDK await; deadlines reject late evidence and invocation leases prevent overlapping steps during the saved invocation.

Invited beta accounts currently use their own saved-wallet TON fallback; the original owner's remembered website session and personal snapshots are never shared. Explicit wallet disconnect invalidates pending public-account work, while a subsequent read-only check can use that account's retained wallet and portfolio. Desktop keeps its existing TON refresh behavior.

### Analytics snapshots

The shared Overview can display wallet-scoped snapshots of Marketapp's personal rent analytics. Use **Refresh analytics** for the wallet-approved Telegram flow, or **Update analytics** to import a browser-captured JSON snapshot. Importing here sends the selected snapshot to this private Telegram backend; desktop snapshots remain local and are not synchronized automatically. Only the configured owner may import/read them. Volume is before fees and royalties, within the saved period; it is not net or lifetime income. **Reporting period** switches between separately saved windows, such as **Last 30 days** and **Last 1 year**. Chart grouping uses the selected snapshot's daily values; incomplete calendar years are marked partial. Switching periods or chart grouping makes no provider requests. See [capture, refresh, and storage details](personal-analytics.md).

Deployment requires the additive `personal_rental_analytics` and remembered-session tables alongside the endpoints and frontend; use the guarded safe migration for a checkout that does not have it yet. Existing cloud events remain unchanged. No personal snapshot is bundled in deployment assets. The snapshot parser/importer makes no provider requests; a separate owner-authorized refresh client uses the temporary website login described below.

### Refresh Marketapp analytics

In **Overview**, choose **Last 30 days** or **1 year** and press **Refresh analytics**. Choose your wallet, approve the Marketapp login, and keep the app open while the selected snapshot is read. The wallet must match the dashboard's saved mainnet address. Successful refresh saves a new immutable snapshot without changing prices, portfolio membership, comparison samples, or API collection counters. Failed refresh retains existing analytics. Desktop continues to use its signed-in-browser capture/import workflow.

A wallet-approved refresh uses a separate disposable TON Connect SDK 4.0.2 connector with Marketapp's public manifest. Its storage is in memory, SDK analytics/events are disabled, and SDK diagnostic logging is removed from the Telegram build. It does not restore or disconnect the ordinary Gift Rent Check wallet session. Approving this login sends the fresh account/proof/device reply to Marketapp's website authentication endpoint; it requests no transaction. Marketapp must explicitly return `verified: true`, and the returned analytics page must identify the saved wallet before a snapshot is accepted.

Login starts with an unchecked **Remember Marketapp login** option. Without it, the session is used only for this explicit refresh and authenticated cookies stay in function memory. With it, a validated session cookie is encrypted in a separate private backend table, bound to the Telegram owner and canonical saved wallet, for at most seven days or earlier provider expiry. The app never stores wallet proofs, signatures, wallet state-init, or full HTML. Neither the cookie nor its encrypted representation is sent to the browser or exported with snapshots. **Disconnect Marketapp** wipes the cookie and fences in-flight work so it cannot restore that login; a wallet change also invalidates it. A five-minute encrypted envelope carries the initial anonymous session between endpoints in volatile browser memory. Backend encryption uses the pinned public-domain [TweetNaCl.js 1.0.3](https://github.com/dchest/tweetnacl-js/tree/v1.0.3) secretbox implementation, with a privately generated 256-bit key and a unique attempt-bound nonce. Public assets are checked for both provider tokens and this key before publishing. Attempt metadata and challenge fingerprints remain owner-scoped, single-use, and independent of snapshots. Old attempt metadata is removed after 24 hours on the next start. Remembered sessions use a separate encryption domain and a unique nonce for every saved cookie revision. A rotated cookie cannot extend the original seven-day local limit. Marketapp's actual session lifetime is not guaranteed; expiry or rejection requires a new approval.

Disconnect retains the non-secret generation and nonce counters. Never delete or reset those counters under the same encryption key. If restoring an older database backup, rotate the private refresh encryption key before saving any new session; existing encrypted logins will require a new wallet approval.

The owner-only `getMarketappAnalyticsRefreshStatus` endpoint reads fixed refresh progress from the existing attempt metadata. It makes no provider requests and consumes no login or collection allowance. The Mini App checks it on mount/return and polls only an already-submitted update for a bounded period; it never restarts authentication. Fixed failure codes survive a remount. A planned snapshot fingerprint links status to the exact committed snapshot, including a crash between snapshot insertion and the final status write. The fingerprint and diagnostic stages remain backend-only; the response contains state, selected period, attempt ID and observation time. No old consumed attempt with missing diagnostics is treated as a successful refresh.

Starts share a one-minute cooldown and five-per-hour allowance with the earlier compatibility tests; failures and cancellations count. A limited manual refresh shows whether the cooldown or hourly allowance applies and counts down from the database-calculated retry deadline. It enables Refresh when the wait ends without automatically requesting another approval. Wallet-approved refreshes make at most three requests: anonymous homepage GET, one authentication POST, and one analytics GET. A remembered refresh makes only the analytics GET, under the same one-minute and five-per-hour limits. Authentication is never automatically retried. Website requests have bounded bodies/timeouts, manual redirects, and a fixed same-origin route allowlist. No provider API token is sent. The documented Marketapp API client remains GET-only and unchanged. Cancellation or navigation clears browser approval state; an already-sent backend request may finish. A new approval is needed when there is no valid remembered session. Transient provider failures and changed page structure retain the saved login and analytics.

On each fresh opening, the visible Telegram app checks analytics once after the known-gift refresh settles. It refreshes the latest saved 30-day or annual period using a valid remembered login, with at most one website GET. A successful compatible refresh is reused for 15 minutes; persisted attempts, including failures, also enforce a 15-minute pause across openings. The shared website lease prevents duplicate concurrent refreshes and collisions with gift checks or manual analytics. Busy work, limits, or unavailable login skip the automatic read and retain saved figures. Overview shows a small update status beside the saved time. Tab navigation and saved-data polling never restart this check, and wallet approval is never opened automatically. Manual refresh remains available; desktop keeps its existing import workflow.

Only the configured Telegram owner may start, finish, cancel, or read snapshots. Arbitrary URLs, another wallet, browser-supplied cookies, altered envelopes, reused attempts, and inconsistent analytics are rejected. Error codes contain fixed recovery text, never provider messages or supplied proof fields.

### Website integration evidence and limits

This integration is experimental because Marketapp has no documented personal-analytics API. Its public wallet bundle sends `{account, device, proof, ref}` to `/auth/checkTonProofAuth/`; the refresh sends `ref: null`. The analytics page exposes summary tiles and JSON chart attributes. The parser preserves numeric text and accepts only all-collection daily charts covering the requested 30 or 365 dates. It supports both the earlier separate income/count charts and the observed `profile.rent.activity` combined chart, checking the latter's three series, axes, types and units. Combined-chart summary totals reconcile at the precision displayed by Marketapp, including whole-GRAM annual totals; saved daily amounts retain their exact values. Mixed combined/separate financial layouts are rejected. Annual optional duration charts can be absent. The separately observed `profile.rent.durations` histogram is recognised and omitted from daily financial arithmetic; duplicate and unknown chart keys are still rejected. Login/markup changes fail safely. An annual refresh has been verified in the private Telegram app; later refreshes can use the optional remembered website session until it expires or is disconnected.

Validation on 9 October 2026 confirmed anonymous challenges, response-cookie forwarding, encrypted handoff and cancellation, plus complete mocked 30-day and annual refreshes in Telegram's runtime. A live wallet-approved annual refresh then confirmed provider login, page validation and snapshot storage. Approvals are single-use and cannot be reused for another refresh. No browser cookies are copied into Telegram. See the official [TON Connect protocol](https://github.com/ton-blockchain/ton-connect/blob/main/spec/connect.md) and [manifest specification](https://github.com/ton-blockchain/ton-connect/blob/main/spec/manifest.md).

The private Mini App reuses the main pricing screen and runs its price calculations and Marketapp collection in Telegram Serverless. Your PC is not needed for those operations. Keep the Mini App open while a collection runs: closing or hiding it stops further browser-driven steps; an already-sent request may finish. Each fresh opening shows saved data first, then automatically checks configured rent prices and rental status for existing portfolio gifts through TON Center. Marketapp collection still requires an explicit Start or Resume.

Every endpoint checks Telegram's platform-verified `ctx.initData.user.id` against the configured human owner ID before accessing data or providers. The browser cannot grant itself access by supplying an ID. The public static URL does not grant access to portfolio data.

Replace `YOUR_BOT`, `YOUR_TELEGRAM_USER_ID`, and `YOUR_APP_ID` below with your bot handle, your human Telegram user ID, and the numeric Serverless app ID reported by the official CLI. These are separate identifiers. Publishing, status, migration, import, export, and verification require an explicit app ID (`-AppId` in PowerShell or `--app-id` in Node commands). Credentials for another app are rejected; import also checks the reviewed manifest's destination. A checkout has no preconfigured deployment target.

## Included

- New openings default to **Actual rentals**, **Last 30 days**, and **Biggest increase first** (recommended daily price minus current asking price, descending). Changing these filters reads saved data only; startup checks use the opening selection as described below.
- **Simple** is the default pricing view on Telegram and desktop: two columns on mobile, large gift images, gift name, current saved daily price and recommended daily price. Prices use three decimals; unavailable values remain dashes. Tap a card for the full evidence and comparisons, or choose **Detailed** beside **Your gifts** for the original table. The view preference is remembered on the device.
- Price source and timeframe stay visible. Search and exact Black selection sit above the grid; collection, recommendation status and sorting are under **Filters**. On Pricing, **Refresh & export** starts collapsed and contains collection controls, gift-check activity, current sync cards and collapsed limits. **Status** shows gift-check status and full sync history; Overview and My gifts do not repeat these cards. Expanding the controls reveals the purpose, completed-check percentage and Stop/Continue. Technical counters and cache notes are under **Details**. Percentages describe completed checks, not time remaining; unknown discovery totals use an indeterminate bar. See [reading sync progress](dashboard.md#reading-sync-progress). Expansion is retained across saved-data updates and timeframe changes, and resets on tab navigation. Scrolling reveals more cards automatically.
- Jobs waiting for explicit Continue use the idle saved-data polling interval (15 seconds); active collection polls every 2.5 seconds. These reads do not request Marketapp data.
- Listing averages or observed actual-rental daily rates, including eligible owned gifts.
- Collection, model, and exact **Black** comparisons. Selecting Black also scopes the collection average to Black.
- Default 30 days; 24 hours, 7, 60, 90 days, or at most 90 inclusive UTC dates. No automatic expansion for sparse samples.
- Three-decimal display, recommendation-gap sorting, recorded rental counts, progressive rows, and local CSV export of the displayed calculations.
- Preserved imported membership, unresolved candidates, collection conflicts, labels, dated asking-price evidence and ownership provenance.
- Separate read-only listing and rental-history collection. Generic market collection includes both.

Portfolio membership and TON metadata remain imported snapshots. This release does not re-run TON discovery or enroll new acquisitions. The startup check verifies current holders and supported contracts to refresh rental status and configured prices; it does not change membership, traits, or prove marketplace visibility. An absent listing retains its last asking-price evidence with its timestamp. Valid saved model and backdrop traits remain usable for recommendations and comparison groups regardless of age, consistently with the local app. Their original dates remain visible; newer invalid or conflicting evidence still blocks the affected trait match. Price and rental-event windows remain unchanged.

Revision 88 validates this trait-age change with 961 backend tests passing (two skipped), 103 focused Python pricing tests and ten Python/JavaScript parity selections including old-trait subjects and peers. A deployed read-only check confirmed both highlighted Big Brother + Black books receive the same recommendation with unchanged metadata timestamps and no provider requests. The projection cache version changed so earlier results are rebuilt from saved evidence.

Recorded rental counts cover saved, unambiguous rental starts, regardless of the selected pricing timeframe; unknown does not mean zero. Rental daily rates use `price * 86400 / duration` under the observed `marketapp-rent-history-ui-v1` interpretation. They are not proof of completion or income received. Conflicting variants, unverified extensions, inconsistent GRAM amounts, and other currencies are excluded. See [pricing methodology](pricing.md).

## Automatic owned-gift price and status check

Pricing and My gifts have a refresh icon for an explicit check of the same known portfolio prices and rental status. **Refresh & export → More sync options → Refresh gift prices & status** starts the same check. It uses the same TON limits, progress and Stop control, and becomes available after any pending check settles. Repeated clicks do not queue extra checks. My gifts also offers separately remembered Simple cards and the existing Detailed table, with the same membership scopes, filters, progressive loading and gift details.

Rented gift images show remaining time beside the clock badge. A verified contract expiry takes priority; otherwise a current Marketapp Rented observation can supply an approximate countdown marked `≈`. Its original hours/minutes precision and observation time are retained, and its tooltip explains the source. Simultaneous compatible, verified TON and Marketapp Rented observations retain the exact expiry with separate TON provenance. A newer website observation does not reuse an older exact expiry, which may have changed through an extension. Timers update locally without provider requests and catch up when the page becomes visible; refresh gift status to check for extensions. An elapsed approximate time shows **Check time**, retaining the saved Rented status until checked. Unsupported or missing time keeps the clock alone. A known exact expiry removes the current-rental badge without claiming that the gift has returned. Small table thumbnails retain the clock, with time in its tooltip.

On each fresh Mini App page opening, after the saved dashboard loads and the page is visible, the shared gift check described above freezes the eligible portfolio addresses. Its TON phase reads NFT holders, batches their supported rental contracts, and rechecks NFT holder/logical time before committing separate price and rental-status observations. Direct holdings receive a holder/logical-time recheck too. The TON phase makes **zero Marketapp requests**; the private owner's website phase uses the remembered login. Neither phase performs wallet/transfer discovery, reads rental history or a collection catalog from providers, or refreshes comparison samples. Saved scope preparation streams bounded candidate evidence and retains only owned-gift identities and collection-conflict sets. A background preload waits for first visibility. Hiding an already-running check interrupts further steps; a fresh page opening starts or safely joins a bounded check. A retained Telegram page returning after at least five minutes away can start a new automatic check only after its previous check completed successfully. Brief app switches, polling, interrupted work, failures and uncertain requests do not trigger another check; those cases retain the manual Refresh action. Cached results retain their original observation dates. Status explicitly shows a failed portfolio check while keeping the true timestamp of the saved data. The [desktop dashboard](dashboard.md#automatic-rent-price-check) shares the frontend driver, startup gate, status display, and Stop control but uses its existing TON-only path without this retained-page recheck; enable it with `--allow-price-refresh`. The two versions keep separate databases and request ledgers.

Rental status requires canonical wallet/NFT/collection agreement, a supported active contract with validated code/data hashes and Marketapp operator, and an unchanged NFT holder/logical time. Direct holdings are classified independently of price availability. Newer failed or conflicting checks show uncertain status while retaining prior dated observations and membership. Legacy price-only records never become new status evidence. Overview's **Available** tile and My gifts filter combine saved Marketapp rent listings with freshly verified idle contracts, counting each gift once and excluding historical or uncertain idle states. Idle contracts retain their own status label. The separate **Marketapp listings** filter requires listing evidence; an idle contract alone does not prove website visibility. Rental expiry is preserved in explicit seconds and is checked again when reading saved data: an elapsed rental becomes expired pending return, never assumed returned.

Gift images show a small clock mark for current rented portfolio gifts. Historical, expired, conflicting, and unverified evidence receives no mark. Known expiry also removes the mark in an already-open view.

Only the settings field `configured_price_per_day_raw` is converted exactly from nanoGRAM. The active rental's payment rate is never substituted. Values are labelled **Observed contract terms** with their account-read timestamp; the later holder-check timestamp is recorded separately. Contract terms do not prove Marketapp listing visibility or settings propagation between original and derived contracts. Both pinned variants in [the decoder notes](../serverless/tests/fixtures/ton-price-decoder.md) are supported. Directly held NFTs and unknown contracts retain their previous dated prices with uncertainty.

The TON budget is independent of Marketapp: 50 addresses per batch, one request/second, at most 60 attempts and 120 seconds per run, three attempts per request, and 1,000 attempts per rolling 24 hours. All requests are GETs to TON Center mainnet `/api/v3/nft/items` or `/api/v3/accountStates`; no Marketapp token is sent. Retry deadlines and a two-minute in-flight lease prevent overlapping requests across page openings. A fresh page session is idempotent; another open view joins the same active run. Stop check affects only this combined TON check. Saved data remains usable on provider failure.

The transport requests a 20-second timeout and uses cancellation where available. Telegram's SDK does not document a hard timeout guarantee, so late responses are rejected using the trusted server clock, and the lease prevents an immediate overlapping retry.

Aggregate-only verification commands (the second intentionally performs a new bounded check):

```powershell
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --summary
node serverless/tools/verify-owned-prices.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --smoke
```

## Connect and disconnect a wallet

The wallet control can open **TON Connect** to approve a read-only connection in your wallet app, including compatible wallets launched through Telegram. It supports TON mainnet. Disconnect removes that connection from this browser; it keeps the saved portfolio and its refresh behavior. Reconnecting does not import gifts, change portfolio membership, or start a wallet scan. The saved dashboard remains tied to the wallet in its imported dataset, and a different connected wallet is identified separately so its address cannot relabel those gifts.

For this private-owner connection, Telegram's verified owner ID still controls access to backend data. This control requests no transaction, message signature, or `ton_proof`; the connected address is informational and grants no backend authorization. Do not treat it as proof that a visitor owns the saved portfolio. Invited-account verification is a separate flow that does request an ownership proof for the app's domain, as described under [public beta](#public-beta-with-your-own-api-key). A device may restore its previous TON Connect session when the app opens.

Set these **public** frontend settings before building for your deployment. Existing environment values override `frontend/.env.local`. A sample is in `frontend/.env.example`; never put API keys in any `VITE_` setting.

```powershell
$env:VITE_TONCONNECT_APP_URL = 'https://appYOUR_APP_ID.tgcloud.ai'
$env:VITE_TELEGRAM_RETURN_URL = 'https://t.me/YOUR_BOT?startapp'
& .\scripts\build-serverless.ps1 -Pnpm 'C:\path\to\pnpm.cmd'
```

Use the app's HTTPS origin with no path, query, credentials, or fragment. The optional return URL must be a `https://t.me/YOUR_BOT?startapp` Mini App link; omit it if the bot has no configured Main Mini App. Configured builds emit a public `/tonconnect-manifest.json` and a 180 × 180 PNG icon. Both must be reachable over HTTPS without authentication and allow cross-origin reads. The manifest identifies **Gift Rent Check**, the deployed origin, and its icon. The publish guard rejects a manifest for any app other than the explicit `-AppId` target.

Without `VITE_TONCONNECT_APP_URL`, builds leave wallet connections disabled, which keeps fresh checkouts and CI portable. The local Python dashboard continues to use its configured saved wallet. TON Connect does not add cloud wallet discovery or change the read-only provider API restrictions. See the official [TON Connect manifest requirements](https://docs.ton.org/applications/ton-connect/core-concepts#manifest).

## Marketapp request limits

| Limit | Default |
| --- | --- |
| Marketapp attempts per Start/Resume | 100 |
| Marketapp attempts per automatic startup batch | 20 |
| Rolling 24-hour attempts in this cloud database | 500 |
| Elapsed time per Start/Resume | 300 seconds |
| Elapsed time per automatic startup batch | 60 seconds |
| Automatic startup batches per account | At most one per hour |
| Request pace | At most one per second |
| Attempts per request, including first | 4 |
| Page size for new runs | 100 |

Retries and catalog requests count. Counters and provider retry deadlines survive reopening, new jobs, resumes, and deployments. The upgrade conservatively inherits recent prototype attempts. The old prototype's collection entrypoints are disabled so they cannot bypass the ledger. These are conservative application limits, not a published Marketapp quota or a guarantee against restriction.

Only authenticated GET requests to `/v1/collections/gifts/`, `/v1/rent/gifts/`, and `/v1/rent/gifts/history/` are constructed. Collections come from imported portfolio addresses, in stable address order. New runs fetch the catalog first, then rotate among collections after each committed page before reading deeper. Retries stay with their original request. The saved schedule and cursors survive interruption; older runs retain their original sequential schedule. An initial sample does not mean the collection is fully checked. Coverage is partial until the saved streams complete. Fresh collection starts at the head; Resume freezes the original scopes, page size, and timeframe. History stops after a valid descending page crosses the selected lower boundary; empty continuation pages continue, equality retains ties, and ordering anomalies disable the cutoff shortcut. Requests are bounded even if ordering is unreliable.

New Telegram jobs request 100 records per page, matching desktop pricing jobs. Existing paused jobs retain their original page size (including 10). The legacy-run notice offers **Start efficient refresh**, which starts a new run from the head using the saved timeframe choice and current defaults; it retains existing observations. **Continue** still resumes the original traversal. The one-request-per-second pace and all attempt, daily, and response-size caps remain unchanged. Larger pages reduce request overhead; they do not raise your allowance.

### Automatic comparison check

Once on each fresh visible Mini App opening, after the known-gift and personal-analytics checks settle, Telegram may refresh stale comparisons for the opening **price source and timeframe**. **Actual rentals** reads rental history; **Listing prices** reads asking prices. Changing tabs, filters or chart periods does not launch another comparison scan. This uses the account's configured **Marketapp API key**, independently of remembered website login or an active wallet-app connection. Invited accounts also require their saved wallet verification. It never discovers new gifts, submits transactions, or changes prices.

Only collections mapped to portfolio gifts are checked. Missing or conflicting collection mappings remain unresolved. Recent, completed, compatible scans are reused for one hour from their original observation time. If all required streams are reusable, no new job or catalog request is created. Otherwise a startup batch uses at most **20 API attempts and 60 seconds**, including catalog requests and retries, at the existing one-per-second pace. The same rolling daily and provider allowances still apply. A durable account-wide one-hour cooldown covers automatic batches across price sources, timeframes, app openings and failures; reopening cannot repeatedly spend another startup allowance.

Unfinished automatic work keeps its original window, scopes, page size and committed cursors. A later eligible opening can continue it within another small batch. **Continue** explicitly resumes with the normal manual allowance. Startup leaves paused manual work alone, and **Stop** prevents automatic continuation of that scan. Active jobs, missing setup, exhausted allowance and provider waits are skipped without adding empty Status cards. Progress appears in the existing comparison activity; saved recommendations remain usable throughout. Hiding the app interrupts further client steps, while an already-sent request may finish under the backend's lease and deadline checks. Desktop collection remains manual.

### Incremental rental history

Desktop and Telegram use the same versioned policy, with separate local/cloud coverage records. The first new-policy scan reads the entire selected window for each collection. Only an ordered, completed stream establishes reusable coverage; imported records, old runs without policy metadata, interrupted scans, and ambiguous ordering do not establish it.

Later refreshes still start at the head, but stop after crossing the previous scan's start time minus a **48-hour overlap**, or the requested window's lower bound if that is newer. Older saved records continue to participate in the same selected pricing window. Every returned page is stored intact, equal timestamps at the boundary are retained, and replayed representations do not add duplicate votes. Changed representations remain available and follow the existing ambiguity rules. A first duplicate never ends traversal.

After **seven days** from the last full scan's start, the next requested refresh scans the full selected window again. Incremental scans never postpone that deadline. A wider window, a new collection, invalid coverage, or a boundary already reached by the overlap also requires a full-window scan. Nothing runs on a schedule. Backfilled or corrected events older than the overlap may remain unseen until a deeper scan; incremental completion is not a newly downloaded full-window snapshot.

Each run freezes its per-collection plan and baseline provenance. Resume preserves that plan even if the seven-day interval passes or the displayed dates change. An unfinished or failed stream cannot advance reusable coverage. Saved job details show how many collections use recent updates and how many require a full-window scan. Existing observations, rental counts, selected timeframes, and membership are retained.

### Shared market cache

New Telegram jobs can reuse completed listing and compatible history traversals for **one hour**, measured from the source stream's first actual provider observation. Completion and cache reuse do not extend expiry. A traversal that already exceeds one hour is not reusable. The status shows when recent saved scans are reused and their age; original observation timestamps remain unchanged. **Force fresh comparison data** starts a new job that bypasses cache reuse, while retaining normal request limits and cooldowns. It can populate the cache with newly completed scans. Manual jobs fetch the catalog once per new job even if all market streams use cached coverage; automatic startup checks skip job creation and the catalog when every required stream is reusable.

The cache index contains public request scopes, source references, original observation times, and coverage bounds. Personal wallet settings, portfolio membership, labels, and TON ownership evidence are excluded. Existing provider records remain the comparison source; reuse creates no duplicate pages or observations and never makes old data appear newly observed. Public listing owners and history parties remain in the retained structured source records. Cache access follows the private-owner or invited-account authorization path; invited projections and evidence are account-scoped.

Only fully committed, valid traversals qualify. Incomplete scans and unordered or scope-conflicting history cannot populate the cache. Cached history must cover the new scan's required lower boundary and selected window. Incremental coverage cannot replace a wider or weekly full scan. Cache reuse never advances `checked_through` or `full_scan_at`; the original history baseline remains unchanged.

Cache decisions and source references freeze when a new job starts. Resume keeps that evidence even if the cache later expires. Job details show reused streams and their original observation time. Reused streams consume no provider requests or allowance; fresh requests and retries retain the existing shared Telegram ledger, pacing, and cooldowns. No scheduler is introduced.

The cache is **Telegram-only**, as selected for this release. Desktop remains separate and cannot share Telegram's allowance. Leave desktop `--allow-network` off while using Telegram for Marketapp collection; `--allow-price-refresh` still enables the separate TON-only owned-price check.

`Retry-After` applies across jobs. Authentication failures, malformed pages, cursor cycles, and rejected cursors stop collection without advancing that page. A rejected cursor requires a new collection. An in-flight lease prevents overlap; after an interruption, allow up to two minutes for it to expire before resuming. The current SDK does not document a configurable network timeout or cancellation primitive; the five-minute allowance prevents starting further requests, and the lease fences late results. It cannot force an already-sent SDK request to finish at exactly 30 seconds.

### Explicit one-day allowance reset

There is no recurring reset or reset button in the Mini App. When the owner explicitly requests a one-off reset, the private administrative tool can exclude the requests already made from allowance accounting until midnight **Europe/Berlin**. This is an application allowance reset, not a change to Marketapp's provider limits. The append-only request history, per-start limit, request pace, and provider cooldown remain intact. New requests count normally; the normal rolling 24-hour calculation resumes at midnight, including any prior requests still within that window. The reset starts no collection.

After that exemption expires, usage can exceed 500 because earlier requests count again. A paused sync displays **Available again** in the viewer's local timezone: the earliest time enough counted requests age out to allow another request. The calculation includes restored requests if an active exemption expires before that time. It assumes no additional requests; it does not promise a full batch or reset the provider's limits. **Continue** remains an explicit action.

```powershell
node serverless/tools/reset-market-budget.mjs --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID `
  --reset-id YOUR_UNIQUE_RESET_ID --confirm-reset-today
```

The tool validates the Telegram destination, requires owner authorization and no active request lease, and appends an idempotent event. Retry an uncertain result only with the same reset ID. A second distinct reset for the same date is rejected. The operation is not deployed as a callable Mini App endpoint.

Production timing uses SQLite wall time refreshed around database commits and provider responses. This prevents the runtime's JavaScript clock behavior from shortening retry delays or accepting an expired lease. Failure to read trusted time stops new provider requests. Lease fencing protects committed state; it cannot cancel an old transport request if the platform leaves it running.

**Use one active collector.** Desktop, CLI, and Telegram do not share an account-wide request ledger. Leave the local dashboard without `--allow-network` when using Telegram for collection; otherwise the two independent allowances can add together. No scheduler, automatic notifications, paid discovery, or price-changing function is enabled.

## Storage and migration

The existing `collector_state` prototype table remains intact. `cloud_events` and account-scoped `public_cloud_events` retain event identities and request checkpoints. In compact mode, only the current event holds the full operational state; superseded state becomes `{}` and duplicate job bodies retire atomically. Resumable scans retain their latest body, finished scan bodies are capped at the newest 20, and small run summaries/session bindings preserve replay lookup. Structured facts are stored once in `service_record_payloads`, with dated, ordered occurrences in `service_record_occurrences`. Private and invited evidence stays separately scoped.

One conditional SQLite INSERT and its installed triggers publish validated observations, the next cursor, archives and byte counters atomically. New saves discard the unused original HTTP response body; complete structured source fields remain part of the evidence identity. Legacy response copies can be removed with the owner-only [provider-body retention tool](storage-maintenance.md#storage-efficiency-review--11-october-2026). Writes do not rely on transactions spanning separate SDK calls. Compare-and-set revisions, account generations, credentials and leases fence concurrent calls and stale responses.

Install the additive schema and accounting/normalization/operational triggers before publishing the runtime, following [the release upgrade steps](releases/v0.4.0.md#upgrade-an-existing-telegram-deployment). Fresh accounts then use compact storage. Existing legacy accounts remain readable until an explicit conversion; the supplied [development reset](development-storage-plan.md#deployment-and-development-reset) removes comparison/owned-price observations and scan progress while preserving credentials, wallet/portfolio/trait data, analytics and security/request ledgers. Publishing code does not perform that reset. Compact accounts skip legacy checkpoint-reference cleanup and must not be written by an older runtime.

Import chunks have stable identifiers, content checks, and bounded size. Identical replay is acknowledged; conflicting replay is rejected. The seed compacts identical listing/history representations while preserving observation times and occurrence counts. Changed variants remain distinct. Original page occurrences remain in the local SQLite database. Reads never call Marketapp. Stored JSON keeps monetary strings, original source fields, and the missing/null distinction.

The compact reader merges independently bounded inline and normalized evidence streams in original event order, with at most 800 records and a 1 MiB UTF-8 target per batch. The legacy reader retains its bounded event-chunk path. A single oversized legacy record is read alone so traversal can advance. Reads freeze the revision and reject a changed reset floor or account generation. New provider pages must fit both the wire-response and normalized-record 1 MiB caps before progress commits; JSON wrapping of a discarded response copy is not an additional validity gate. Address, timestamp, and trait normalization is cached only within a calculation. Monitor storage growth before long-term collection: these bounds do not provide unlimited database capacity. See [storage monitoring and cleanup](storage-maintenance.md); older prototype behavior is documented separately in [the prototype guide](telegram-serverless-prototype.md).

The Telegram frontend requests the optional `gift-dashboard-v1` transport format for dashboard reads. Repeated object field names and text are transferred once and reconstructed exactly before normal dashboard and account validation. This changes neither stored evidence nor calculations; legacy clients keep ordinary JSON. Both sides bound nesting and payload size, and the decoder also bounds expanded data and rejects invalid references. Only `getDashboard`, `getDashboardRevision` and `getJobs` may retry a platform `INTERNAL` failure or a classified busy/deadline failure: at most two retries after 800 and 1,600 ms, inside the original 45-second deadline. Cancellation stops pending retries. Mutations, authentication refusals, unknown failures and invalid responses never retry. Persistent caught read failures use fixed `READ_BUSY`, `READ_TIMEOUT`, `READ_LIMIT` or `READ_FAILED` codes; raw runtime details stay private.

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

### Quick price actions

Tap the recommended price in Pricing, My gifts, or gift details to copy it. A small **Open Marketapp** icon opens the gift; details also offer **Check this gift**. Copying uses the displayed source, timeframe and backdrop recommendation, rounded to three decimals without units or grouping. Marketapp accepts the actual edit and any wallet approval; Gift Rent Check submits no transaction and does not prefill an undocumented editor URL. Clipboard denial opens a selectable number for manual copying.

**Check this gift** reads only the selected eligible portfolio gift through the existing TON verification engine. A supported rental contract normally needs NFT, account-state and NFT-recheck GETs; retries and pacing count against the same TON limits. No Marketapp API requests, history scan, membership changes or quota reset are added. An active price/status check must finish or be stopped before a different check can start. Returning from Marketapp never starts an automatic recheck.

The optional `nft_address` input on `startOwnedPriceRefresh` selects one canonical, account-authorized NFT. Omitting it preserves a full-portfolio refresh. Run summaries include scope, NFT, wallet and session identity; legacy runs remain portfolio checks. `getOwnedPriceRefresh` accepts a session ID to reconcile the exact original request after an interruption. Reusing a session for another gift/wallet is rejected. Single-gift UI checks require the Telegram-only `owned_price_refresh_single` capability; desktop requests are unchanged. This extension uses existing JSON summaries and needs no database migration.

Only verified saved observations update the displayed contract price and existing performance tracking. A copied recommendation is never recorded as an executed change. Failed checks retain dated evidence; other gifts keep their observations. Contract terms do not prove Marketapp listing visibility or immediate propagation to rental counterparts.

The provider token and human owner ID belong in ignored `serverless/tgcloud/lib/private-config.js`. They are private backend code and must never enter the frontend bundle. No bot API token is required. To configure a new checkout, set `MARKETAPP_API_TOKEN` in your local environment or root `.env`, then run:

```powershell
& .\.venv\Scripts\python.exe scripts/configure-serverless.py --owner-id YOUR_TELEGRAM_USER_ID
```

Generate the separate private refresh-encryption key once with `node serverless/tools/prepare-refresh-key.mjs`. The ignored key module is deployed only as backend code. The generator retains an existing key and prints no key material. Rotating or removing it invalidates pending refresh envelopes; saved snapshots remain available.

Environment values take precedence over `.env`; `--owner-id` takes precedence over `TELEGRAM_OWNER_USER_ID`. The script writes the private module without printing credentials. For an unconfigured local checkout, copying `serverless/private-config.example.js` to that path supplies empty values that deny access; never overwrite an existing private configuration just to run local tests.

In BotFather, open **@YOUR_BOT → Serverless**, enable it, and obtain the **CLI Access → Access token**. Log in through `scripts/login-serverless.ps1` and enter that token at its prompt; the Serverless CLI token is different from the bot API token. On a clean checkout, install the locked CLI dependencies first with `pnpm --dir serverless install --frozen-lockfile`. All supplied publishing/import helpers disable `TGCLOUD_DEBUG`, which otherwise can log private source payloads. Do not print private config or `.tgcloud` snapshots.

```powershell
& .\scripts\login-serverless.ps1
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action status
node serverless/tools/manage.mjs --action publish-schema --app-id YOUR_APP_ID
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action migrate-check
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action migrate-safe
node serverless/tools/compact-storage.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --action setup
& .\scripts\publish-serverless.ps1 -AppId YOUR_APP_ID -Action publish
```

These wrappers and the `serverless/package.json` commands use the same destination guard. It rejects custom `TG_CLOUD_API_URL` values and `TGCLOUD_BETA` before importing the CLI, then checks the resolved token against the explicit app ID. An inherited `TGCLOUD_TOKEN` takes precedence over saved credentials and must match; it never silently falls back to a different saved login. The validated token is pinned for the command, including status and migration. No token is printed or passed in command-line arguments.

Interactive login asks for its own token and refuses a nonempty `TGCLOUD_TOKEN`; unset that variable first so snapshot synchronization uses the token you enter. Remove custom API/beta overrides before using these production helpers. For direct Node/pnpm use, for example, `pnpm --dir serverless status --app-id YOUR_APP_ID` and `pnpm --dir serverless push --app-id YOUR_APP_ID` use the same checks. Login itself requires no app ID; later operations check the ID you supply. Use these guarded entrypoints instead of invoking the underlying deployment CLI directly.

Publishing targets schema, library, endpoints and static assets, preserving unrelated bot modules. Review conflicts; do not force an unknown remote revision. Migration is additive. Configure your bot's **Open app** menu or Main Mini App to use the exact URL reported by the CLI, in the form `https://appYOUR_APP_ID.tgcloud.ai/`.

### Legacy checkpoint-reference maintenance

This section documents the earlier reference layout, still supported for existing legacy accounts. It is not the compact development layout described above. Do not run these historical compaction procedures as the upgrade for a compact account; follow the [current release steps](releases/v0.4.0.md#upgrade-an-existing-telegram-deployment). Normal compact writes already retire superseded operational state.

The original archive update added `owned_refresh_runs`, `owned_refresh_sessions`, `owned_refresh_index` and `dashboard_projection_cache` before publishing its reader. For a current deployment, inspect all additions from the complete current schema instead of assuming those four tables are the entire migration. Legacy archive indexes can recover from committed events after interrupted migration or writes; compact accounts use summaries materialized as accepted events retire their old state. Historical session IDs retain replay protection.

Checkpoints store a matching Marketapp job once in its immutable `job_json` column, with a validated reference in `state_json`. TON checkpoints can reference an identical earlier committed job. A refresh's frozen gift list is also stored once: later checkpoints reference the earliest exact inline list for that run and wallet, without reference chains. Entire unchanged TON checkpoints can likewise reference an earlier exact inline checkpoint, including its validated gift-list reference. Referenced source rows remain permanent. Changed lists, labels and conflicting evidence retain separate representations. Reads restore the entire logical state before any mutation. This preserves missing/null fields, ownership archive recovery, leases and request accounting.

To reclaim existing exact duplicates, first publish the new reader, then inspect `node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode check`. Checks use at most 20 bounded calls; `owned_state_counts_partial` identifies an incomplete inventory. The job statistics count same-row duplicates; the bounded jobs apply phase also finds historical TON copies with an exact earlier source. Apply skips the full inventory and uses at most 20 hosted calls and 500 rewrites per invocation. Frozen-list batches contain 1–25 rows; job and unchanged TON-state batches contain 1–4 rows to fit hosted query limits. The output includes `phase`, `boundary`, `after` and `complete`. When incomplete, continue with the returned values:

```powershell
node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode apply --phase owned_states --boundary RETURNED_BOUNDARY --after RETURNED_AFTER
```

Use the reported `--phase` instead of `owned_states` if jobs or targets remain. A partition with zero rewrites can still have more rows to inspect; only `complete: true` establishes completion. Maintenance clears only replaceable projection cache entries for write headroom and reduces a batch to one row if storage or query limits reject it. It leaves the latest checkpoint and referenced sources untouched and changes only duplicate job, gift-list and unchanged TON-state copies, preserving every job, raw body, normalized record and other state value. The tool prints aggregate storage counts only and calls no provider API. Byte formatting of rewritten checkpoint JSON may change, while its reconstructed values remain identical. Do not roll back to a reader without reference support unless all references have first been restored. The refresh archive reads summaries through direct primary-key lookups rather than materializing historical checkpoint documents.

Telegram can also throttle administrative calls. After verified progress, HTTP 429 pauses maintenance with exit status `3`, `paused_reason: rate_limit`, the last verified cursor, and a numeric `retry_after_seconds` when provided. Wait before resuming with the reported phase, boundary and cursor. The tool does not automatically repeat the interrupted mutation; any unacknowledged exact-duplicate rewrites are safe to encounter again.

If Telegram storage fills, updates stop with `STORAGE_FULL` and retain their saved progress. Compaction does not reset the daily request allowance or start another provider request. After maintenance, continue the comparison scan from its saved checkpoint and use the gift refresh icon to start a fresh bounded status check. Normalized observations and required checkpoints still require storage; lossless duplicate compaction cannot provide unlimited capacity.

Gift refresh checkpoints also reuse exact unchanged `gift_refresh` objects through a single immutable source reference. This avoids copying the saved target list and results into subsequent comparison and TON checkpoints. Publish the updated private repository and historical gift-refresh reader before rewriting existing copies. The original source remains inline; maintenance preserves the latest checkpoint, referenced sources, session binding records, raw evidence, jobs, timestamps and provider allowances.

For a bounded gift-state inventory or direct recovery, run:

```powershell
node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode check --phase gift_states
node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode apply --phase gift_states
```

Continue incomplete maintenance with its returned `--boundary` and `--after`, keeping `--phase gift_states`. Each invocation makes at most 20 hosted calls; each gift-state call rewrites at most four exact duplicate wrappers. A partial inventory reports `gift_state_counts_partial`; zero rewrites do not prove the remaining ledger has been inspected. Do not roll back to a reader that cannot resolve gift references. A future private-to-public owner migration requires a public tenant-scoped reader for all existing checkpoint reference families before copying compacted private events; the current private dashboard and separately created invited accounts do not use that migration.

Allowance-reset receipts are permanent audit and idempotency evidence. Private checkpoints reuse an earlier exact inline receipt through `__checkpoint_budget_reset_sequence`; the reader resolves it before calculating any allowance. This does not create a new reset, change excluded attempts, extend expiry or change provider usage. Publish the receipt reader and atomic source fences before running receipt maintenance:

```powershell
node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode check --phase budget_resets
node serverless/tools/compact-checkpoints.mjs --app-id YOUR_APP_ID --mode apply --phase budget_resets
```

Receipt maintenance also replaces an eligible exact gift wrapper in the same SQL update. At a completely full database, one combined small checkpoint rewrite may succeed where gift-only compaction still requires unavailable temporary pages. Each call preserves the current head, both inline source roots and all immutable event columns. Continue with the returned frozen boundary and cursor; only `complete: true` confirms the entire partition was inspected. Receipt references must also be supported by any future owner-migration reader, and must not be rolled back to an older reader.

### Current dashboard reads and maintenance

Idle and active polling reads a revision and job progress; unchanged data does not reload rental history. Telegram's private cache keeps at most 16 replaceable dashboard selections and 16 MiB of cache data; invited caches also obey their account-specific limits. Each private projection is at most 4 MiB, split into immutable pieces of at most 256 KiB to bound host calls while avoiding hundreds of cache reads. A final manifest and content hash prevent interrupted/concurrent writes from mixing pieces. Missing or evicted pieces cause a rebuild. Source commits invalidate projections immediately. Time-dependent views (expiry and relative price windows) invalidate on a one-minute bucket; generated/observation timestamps retain their real values. Manual reload still reads a full dashboard, using a valid projection cache when available. Budgets and personal analytics are read fresh, and cached data contains no API key, login proof or session cookie. Cache failures rebuild from retained source records.

The comparison collector streams wire responses with a 1 MiB byte limit and separately bounds normalized records before saving. Marketapp uses a 30-second deadline, TON 20 seconds, both capped by remaining invocation/lease time. Telegram's currently tested runtime has no timer or abort controller, and its SDK fetch ignores the timeout option. In that runtime the code checks trusted server time after each await and rejects late evidence without advancing progress; it cannot interrupt a completely stalled SDK header/body request. Hosts with timers enforce an independent deadline as well. Saved leases and request budgets continue to fence results and retries. Analytics website requests retain their existing separate bounds and rate limits.

Actual-rental projections sum exact fractions in balanced groups to avoid repeatedly reducing an ever-growing denominator. History grouping keeps a single entry for an unambiguous event and allocates full variant keys only after a collision; unknown fields and address aliases keep their original comparison semantics. Rental views retain all market trait and collection evidence but build asking-price snapshots only for displayed gifts. These changes reduce transient memory without deleting, sampling or rounding saved observations early. Provider allowance status derives the caller's hashed identity once per probe, even with a full request ledger.

Dashboard reconstruction streams bounded event pages after a small portfolio/settings prepass. Both passes stop at the same captured revision, including when the repository has no projection cache. A membership row arriving later in the saved sequence still receives its older price evidence, while a concurrently appended gift or wallet change waits for the next read. Failed pages abort the projection before cache publication. Public reads also recheck the active account generation at completion. The pricing builder retains the latest applicable model/backdrop observations, including all exact-timestamp ties and conflicts, instead of their superseded history. Source records remain unchanged.

Full dashboard/revision polling runs every 15 seconds; active job progress continues every 2.5 seconds. Each read stream independently backs off after failures, up to 30 seconds, and resets after success. Manual Retry, mutation reloads and final collection completion bypass the delay. Errors remain visible with the last saved data; polling never starts provider collection by itself.

The Storage card distinguishes an individual maintenance request from the full cleanup cycle. **Cleaning…** remains disabled between scheduled chunks, including backend pacing waits. Startup housekeeping has a 24-request opening budget. **Clean up now** or **Continue cleanup** runs a manual foreground session for the current cycle, up to 300 requests or 15 active minutes; hidden time and provider waits do not consume that time allowance. The card explains each pause, resumes after temporary waits, and ends the session when the current cycle completes. Errors expose **Try again**. A saved backend `running` flag alone cannot claim active cleanup after a pause or failure. Additional taps during scheduled work cannot reset the session limit. Backend-blocked cleanup requires a manual retry; a completed cleanup's future cooldown does not disable a new manual request.

New clients request `progress: true` on storage status and step calls to receive a fixed cleanup-stage descriptor. Older requests retain their original response shape. Owners can see position within the current bounded private checkpoint scan; percentages cover that stage only, not total work or time remaining. Invited users receive only their account's seven-stage plan, without shared cursors or app-wide counts. Freed bytes change only when removable data is found, even while the scan position advances. Cleanup scheduling preserves the deadline from the last response through visibility/provider pauses; an already-running cleanup does not repeatedly fetch status and postpone its next step when other updates settle. Server pacing and the automatic/manual request bounds remain enforced.

Each backend request runs at most eight small batches with a durable checkpoint after every batch, a 128-work-query cap and an eight-second soft deadline. Compact accounts skip historical job/target/state reference-compaction stages; disposable cache and expired metadata still receive bounded cleanup. On legacy accounts, completed private history stages retain versioned scan positions, check newly added rows on later cycles, and schedule a full sweep after 24 hours. Invalid markers fall back to a full sweep. Daily storage-growth samples and logical safety budgets are described in the [storage guide](storage-maintenance.md); neither is a measurement of physical hosting quota.

Revision 89 validation passed 976 backend tests (two intentional skips), 615 frontend tests, TypeScript, the Telegram build and 14 Storage-card rendering cases. Three bounded production requests moved the saved history scan from 59% to 67%, preserving all 4,958 event rows, immutable-column byte totals and the decoded latest checkpoint. Verification made no provider requests and did not claim the full cleanup cycle was finished.

Revision 87 validation: 611 frontend tests and 959 backend tests passed (two backend tests skipped), along with TypeScript, the Telegram production build and 14 Storage-card rendering cases. Deployed read-only checks confirmed the optional stage response and preserved cleanup position without starting maintenance or making provider requests. The public entry and cleanup UI bundle match the tested build.

During collection, Status shows **Updating** consistently across page leases. An interrupted or stopped request can show **Finishing** until its saved lease clears. That lease can disable another comparison action without changing the other row's label. Dashboard status replies are ordered against newer step results so a delayed read cannot restore older progress or revive a completed scan.

Revision 84 validation: 940 backend tests and 592 frontend tests passed (two backend tests skipped), with TypeScript and the Telegram production build passing. An independent 360-case comparison preserved prior pricing and history-grouping results. A cold projection of 111,212 saved observations retained 10,422 eligible rental records in 3.21 seconds. The deployed full dashboard responses passed for actual rentals (3.69 seconds), exact Black rentals (4.08 seconds), and listing prices (4.12 seconds), each with 161 portfolio gifts and 33 unresolved candidates. Verification made no provider requests; these administrative checks do not replace the Telegram client authentication handshake.

Revision 85 addresses renewed runtime memory exhaustion as collection grew beyond that earlier dataset. Validation passed 955 backend tests (two skipped), 596 frontend tests, TypeScript and the Telegram build. The streaming projection passed a 70,000-rental test and 1,280 exact comparisons against the previous implementation. A read-only candidate check retained 22,987 eligible rental records with no database changes or provider requests. Deployed full responses loaded actual rentals in 4.61 seconds and listings in 4.78 seconds, each retaining all 161 portfolio gifts and 33 candidates. These timings describe the tested dataset, not a guarantee of unbounded history capacity.

For live validation, open the private dashboard with no active Marketapp collection and confirm startup checks run in order: known gifts, remembered-login analytics when enabled, then a bounded comparison batch when stale and eligible. The TON phase uses zero Marketapp requests; website reads and comparison API attempts use their separate ledgers. Reopen within an hour and confirm no additional automatic comparison batch starts. Start one manual listing collection, stop after a small number of requests, reload, and verify persisted counters and cursor. Resume explicitly; confirm completion/partial coverage remains distinct. Rejected callers must receive no portfolio data. Keep live verification bounded; unit and parity tests need no provider requests.

**Price changes** in Overview and expandable **Price changes & performance** in gift details use saved TON asking-price observations, with listing history as a fallback when no verified contract prices are available. Equal 7-, 14- or 30-day before/after windows show eligible recorded rental samples. This reads existing cloud records and adds no provider requests or database tables. New deployments invalidate the prior derived projection version while retaining raw observations and request ledgers. See [tracking methodology](price-tracking.md). To inspect synthetic price changes locally, set `MOCK_PRICE_TRACKING=1` before running `node tools/mock-server.mjs`; the fixture cannot modify a personal seed or reach a provider.

The administrative Marketapp smoke test requires explicit app and owner IDs plus a confirmation flag. It performs at most two collection step calls, with Stop/Resume between them; retry rules still apply:

```powershell
node serverless/tools/live-smoke.mjs `
  --app-id YOUR_APP_ID --owner-id YOUR_TELEGRAM_USER_ID --confirm-two-requests
```

Telegram's [Mini App Serverless API](https://core.telegram.org/bots/webapps#serverless) supplies verified identity to endpoints. Runtime/database details are documented in the pinned CLI's `src/templates/docs/tgcloud-sdk.md` and the [official Serverless documentation](https://core.telegram.org/bots/serverless). Background scheduling and reliable work while the Mini App is closed are not assumed.

Status also monitors estimated shared storage and performs bounded lossless cleanup. Collection reserves space before provider requests and pauses before the configurable application budget is exhausted. See [storage monitoring, retention guarantees and additive setup](storage-maintenance.md).
