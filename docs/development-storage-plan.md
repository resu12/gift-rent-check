# Storage plan for a public release

The app remains an invited development service. Each user supplies their own API key, but all accounts still share the same database, app request guards and hosting capacity. An individual key does not provide independent storage.

## Implemented design

1. **Stop retaining full operational snapshots.** In compact mode the current event holds the full state. Older events keep their sequence and replay key, but their superseded state becomes `{}`. Only the latest body of each resumable scan is retained. Finished scan details are capped at the newest 20 jobs; small refresh summaries and session bindings remain available for safe replay.
2. **Store repeated facts once.** Canonical market and gift evidence is stored once per account generation. Small immutable observations reference that payload and preserve the exact original envelope, date, query filters and event order. Full source fields remain part of identity: conflicting rental variants cannot disappear through over-aggressive deduplication. All changes publish in the same SQLite statement as the accepted event.
3. **Keep byte guards accurate.** The new tables participate in global and per-account byte accounting. Admission includes conservative observation/index-row payload overhead. Existing account, wallet, credential, session and compare-and-swap fences remain in force. SQLite pages and physical indexes are still outside these logical estimates.
4. **Measure actual growth.** Status can show up to 31 daily samples. A rough runway appears only after three sampled dates spanning at least 48 hours, with recent measurements. It measures net growth after cleanup against the app's write guard. It is not a promise of provider capacity or a supported user count.
5. **Use a development reset to avoid a large historical migration.** Preserve API keys, wallet settings, portfolio/trait metadata, analytics reports, request ledgers, nonce counters and monotonic IDs. Clear old comparison observations, owned price/status observations and scan progress. A new record floor hides obsolete evidence immediately; bounded disposal reclaims the bytes afterwards. Retain event keys to prevent replaying an old import into the fresh data.

## Retention decisions

Full HTTP response copies are already discarded. Rebuildable dashboard caches and expired request metadata are bounded by existing cleanup. Compact mode removes superseded operational state on every accepted write; this does not depend on a long foreground cleanup completing.

Unique rental facts and dated price changes are retained rather than replaced with daily averages. Exact medians, distinct rental counts, variant rejection and price-change performance cannot be reconstructed from simple sums or averages. Repeated facts now share one payload, while detailed terminal scan history is bounded. Account/global admission prevents unbounded ingestion when allowances are reached.

A future optional time-retention policy must first expose the available history window and retain portfolio rental facts, verified rental starts, collection-conflict evidence and latest model/backdrop information independently. It must also explain what an old custom-date query can return. This is a separate reporting change; silent loss of historical pricing evidence is not used as a storage optimization.

## Deployment and development reset

Run the complete backend/frontend tests, TypeScript and Telegram production build. Publish the additive schema and apply its safe migration. Run the owner tool's `setup` action to install accounting before normalization/operational triggers. Publish the tested runtime before resetting an existing account.

`serverless/tools/compact-storage.mjs` requires explicit `--app-id`, `--owner-id` and `--action`. A `reset` additionally requires `--scope private` or `public:<id>` and a unique `--reset-id dev-reset:<uuid>`. Its result provides the floor and account generation. Continue `dispose` using that same reset ID, floor, generation and returned `after` cursor until `complete:true`. An uncertain request retries the same ID. The tool prints only aggregate counts/cursors, never records or credentials, and makes no provider requests.

Deletion/reactivation, a different reset, stale writes and missing triggers fail closed. Disposal is scoped, bounded and resumable. Repeated resets preserve both inline and normalized gift metadata. Existing clients negotiate growth monitoring separately so an open older client continues to work.

## Gate before public registration

Keep registration invitation-only and keep the current account/service safety guards. Verify the actual hosting database quota and its index/transaction overhead with the provider; the pinned SDK and available documentation do not expose a verified quota measurement. The configured 512 MiB app budget, 8 MiB account allowance and 128 MiB invited-data allowance are application choices, not purchased capacity.

Use measured storage growth and representative usage to choose an account cap. Obtain hosting with sufficient verified capacity, backups and a recovery test before opening registration. An external database or paid capacity requires a chosen provider/account and migration design; this implementation does not purchase infrastructure or claim the current free host is ready for unlimited users.

## Development rollout results

The owner and invited development account now use the compact layout. The reset reduced measured payload to 3.7 MB, or about 4.9 MB after rebuilding the dashboard cache. Aggregate checks confirmed preservation of both accounts' credentials, wallet bindings, analytics reports, portfolio and request budgets. The live dashboard still loads its saved 194 gift/candidate rows, and the compact response decodes identically to the full response. A hosted round-trip of one unchanged existing collection record verified normalized publication and exact byte accounting. Verification used no Marketapp or TON requests.

Synthetic repeated-history testing retained all observations while reducing 10,000-record storage from about 15.1 MB to 3.0 MB. After correcting the initial query plan, the compact reader was comparable to the legacy reader at 10,000 and 20,000 observations. These are development benchmarks, not estimates of supported public account count.

Validation passed 1,094 backend tests (two intentional skips), 720 frontend tests, TypeScript and the Telegram build. The final recovery tests cover stopping a 400 KB checkpoint while storage is paused; only bytes retired in that exact atomic write are credited, and the existing 256 KiB net-growth recovery allowance remains enforced. Account deletion/recreation, reset races, quota limits, replay controls, unknown evidence fields and historical-read boundaries are covered. Published as revision 102.

## Multi-user release follow-up

Invited accounts now have a scoped Marketapp login, encrypted remembered sessions, personal analytics and signed-in gift refresh with TON fallback. Public gift outcomes use a small account-scoped archive installed alongside existing compact triggers. No further data reset is needed.

The [registration checklist](telegram-serverless.md#registration-readiness-and-recovery) now enforces explicit capacity evidence at deployment. [Encrypted backup and recovery verification plus concurrent workload tools](backup-recovery-and-capacity.md) are available. Local workload results do not establish hosted capacity. Keep registration closed until the remaining provider and operational evidence is recorded.

### Verification on 12 October 2026

Published revision 107 after the additive archive migration and accounting setup. Backend validation passed 1,131 tests with two intentional skips; all 733 frontend tests, TypeScript and the production build passed. The live invited-account dashboard and analytics-status probe passed, as did missing-identity denial and archive readiness. The probe made no provider requests and changed no saved record sequences. This administrative check does not replace the user's first real Marketapp wallet approval in Telegram.

The example and current pilot cap are five accounts. A local 16-account workload with 200 gifts and three observations each passed isolation, quota, generation and concurrent-write checks; its timing does not prove hosted capacity. Live backup attempts failed safely: the current database is roughly 60 MB across about 75,000 rows, above the bounded exporter's 32 MiB limit, and the host rejected atomic snapshot queries. No backup/recovery receipt was recorded. Open registration remains disabled pending verified hosting capacity, a working backup/recovery path for the current dataset, and representative hosted load evidence.
