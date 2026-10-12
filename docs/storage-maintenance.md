# Telegram storage monitoring and cleanup

## Compact development layout (12 October 2026)

New accounts use compact storage once its atomic triggers are installed. The owner and invited test account were explicitly reset into this layout on 12 October. The current checkpoint is stored once, each resumable job keeps its latest body, and finished job bodies are limited to the newest 20. Older event keys and small refresh/session summaries remain for replay safety. Repeated market facts share canonical payloads with immutable dated observations. The three additional tables bring measured source tables to 31 and byte-accounting triggers to 93.

Compact scopes skip the old reference-compaction phases described below. They still clean disposable caches and expired metadata. Record publication, run archiving, superseded-state retirement and byte counters commit together. This prevents the repeated full-state growth that previously required long cleanup scans.

The development reset retained API credentials, wallet bindings, portfolio/trait metadata, personal analytics and provider request budgets. It cleared comparison/owned-price observations and old scan state. Event payload before the reset was 454,615,573 bytes, including 311,260,073 bytes of repeated state/job copies. After bounded disposal, total measured application payload was 3,744,369 bytes; after rebuilding the dashboard cache it was about 4.9 MB. This is a development reset result, not a claim that arbitrary production history compresses by the same amount.

Status also supports scoped daily storage-growth measurements. At most 31 samples are kept. Runway estimates need three sampled dates spanning 48 hours, with a recent final sample. They refer to the application write guard; physical provider quota remains unverified. Older open clients do not receive the new fields unless they request `growth:true`.

See [the public-release storage plan](development-storage-plan.md) for retention decisions, reset administration, verification and the remaining hosting-capacity gate. The historical sections below describe the legacy layout and its migrations.

Status shows a compact Storage card. Green means a recent complete check, orange means a check is pending or storage is close to the safety budget, and red means new updates are paused. Details show estimated payload bytes, last completed cleanup and reclaimed space. **Clean up now** runs the same bounded maintenance used automatically while the Mini App is visible.

This measures application payload, not SQLite file size or Telegram's verified physical quota. Indexes, pages and platform overhead are excluded. The default **512 MiB application safety budget** deliberately leaves headroom. Operators can change `serverless/tgcloud/lib/storage-config.js`; both monitoring and admission validate and use the same policy. Do not increase the budget without checking platform capacity and overhead.

## Limits and accounting

- Start automatic cleanup at 75%; warn at 85%; pause new collection at 90%.
- Once paused, resume below 80%, avoiding repeated pause/resume at the boundary.
- Keep 16 MiB for control and metadata operations. Stop, logout, credential revocation and read-only access remain available within this reserve.
- Private and invited accounts share one global counter. Invited accounts also retain an 8 MiB account cap and see only their own usage.
- Invited-account cleanup starts at 75% of its own cap, or earlier when less than 4 MiB remains for collection work. The same working-space pressure produces a warning even below 85%; the account pauses at its cap. Global pressure can also pause an account. Its monitoring cursor, check date and cleanup history are separate; global budgets and reclaimed bytes remain private.
- Atomic SQLite triggers cover all 28 source, cache, credential, session, request-ledger and source-pin tables. Source writes and byte deltas commit or roll back together.
- Before provider collection, reserve a conservative bounded result allowance. The final checkpoint or analytics insert rechecks the reservation, current bytes and existing account/wallet/session fences in its own SQL statement. Cache writes cannot consume reserved space. Expired reservations are purged without resetting provider allowances.

Accounting metadata itself is bounded and covered by the reserve. Normal status reads use small counters rather than rescanning history. A missing accounting baseline fails closed; it never appears green.

Reservations exclude discarded provider response copies. Comparison and TON collection retain conservative checkpoint and normalized-record headroom; analytics still reserves both its source snapshot and normalized report. Final writes enforce live byte limits atomically, so a smaller estimate cannot bypass capacity checks. Bounded wire responses and normalized record limits remain enforced independently of an unused JSON-wrapped response copy.

Invited dashboard caches leave at least 4 MiB of the account cap for collection work. If a reservation still fails, the repository can delete at most 128 of that account's disposable projection-cache rows and retry admission once. Every delete and retry retains the active account/credential checks; concurrent reservations still count. Unique records, analytics and saved progress are not eligible for this recovery. Jobs whose exact reservation exceeds the remaining space still stop safely.

Revision 91 deployed the cache-headroom and comparison-startup fixes on 11 October 2026 after 988 backend tests passed (two intentional skips). Read-only verification confirmed all four changed backend modules match the tested files and the storage-status endpoint returns a complete inventory. No schema migration, saved-data deletion or provider request was needed for publication or verification.

## What cleanup changes

One global lease prevents overlapping maintenance. Each small batch removes at most 25 disposable rows or rewrites at most four exact duplicate checkpoints, with a durable cursor. A request runs up to eight batches, reusing bounded source lookups, and saves progress after every confirmed batch. It stops starting work after an eight-second soft deadline or 128 work queries; small SQL page limits remain unchanged. A failure or lost lease stops further work, and an interrupted batch can safely repeat from its last saved position. It first evicts rebuildable caches, then expires old non-secret login/challenge/request metadata, and then replaces redundant checkpoint copies with validated immutable references. The current checkpoint and referenced source roots are retained. Private and public readers use their own supported reference formats.

Invited-account maintenance applies those phases only to the caller's cache, expired metadata and supported checkpoint duplicates. Every write checks its active account generation and the shared lease; deleting or reactivating an account invalidates an old worker. Monitoring cursors are bounded to 100 accounts. Both owner and invited maintenance publish the global pause bit from the current counter and current hysteresis state in one SQL statement, preserving concurrent admission decisions.

Before reference-based cleanup, each account builds a small source-protection index from at most 25 historical events per pass, with a 512 KiB input target. A larger legacy event advances alone. Four atomic event triggers capture new references during and after this one-time scan. All duplicate root markers and integral numeric spellings are pinned conservatively; pins remain permanent and count toward storage usage. Publication checks both index readiness and the exact source contents in SQL. This avoids a full historical JSON scan that exceeds Telegram's query allowance.

Private checkpoint maintenance also fixes the physical row and byte window before inspecting JSON or looking for an exact source. It prefers recent pinned roots, then a bounded recent-event window. Unmatched rows advance the saved cursor and remain intact. Distant duplicates may be retained when they fall outside those windows; cleanup prioritizes predictable work and preservation of unique data.

The five private history stages save versioned scan positions after completing their ranges. Later cycles examine newly appended history and the former protected head, rather than repeatedly scanning every old row. A full sweep is due after 24 hours, or when saved markers are invalid or incompatible. A legacy partial scan retains its current position without certifying its older range, so the next cycle may need one additional full sweep. Expired metadata and invited-account queries are still reconsidered each cycle.

Automatic lossless cleanup does **not** remove unique rental/listing records, asking-price observations, analytics snapshots, legacy raw evidence, saved cursors, account tombstones, credential/session nonce counters or replay bindings. The separate provider-body retention change below deliberately removes unused response copies. Maintenance does not make Marketapp or TON requests, reset request allowances or add a sync-history entry per pass. Maintenance failure preserves its last durable phase, cursor and reclaimed-space count. A manual retry resumes that saved phase; an uncertain browser mutation is not automatically retried.

Invited analytics imports use a separate retention policy: keep the newest capture per wallet and reporting span, plus captures referenced by active attempts, recent results or the latest provider confirmation. A validated incoming report can replace an older eligible capture in one SQL statement, crediting the old bytes against the new write. This removes the previous ten-capture lifetime ceiling without deleting the previous report before its replacement commits. After a confirmed save, at most 25 obsolete captures are pruned with the same account, wallet and session fences. Malformed or unsupported legacy layouts are retained. Private-owner analytics retention is unchanged.

Revision 83 deployed these corrections on 11 October 2026. Validation passed 935 backend tests (two intentional skips), 587 frontend tests and the Telegram type-check/build. Read-only production checks confirmed healthy storage at 321,174,574 logical bytes, exact accounting across 84 triggers, allowed update admission, owner/invited authorization isolation and all 194 saved dashboard rows. Verification made no provider requests.

Automatic maintenance starts after saved data loads, waits while provider refresh is active, and stops when the page is hidden. Each opening runs at most 24 paced requests. **Clean up now** or **Continue cleanup** starts a manual foreground session for the current cycle, allowing up to 300 requests or 15 active minutes. Hidden time and provider waits do not consume that time allowance; continuation resumes when the app is visible and those updates settle. Completion ends the session even if storage remains above its warning threshold. The card explains whether cleanup is waiting for updates, paused at a session limit, or needs a retry after an error. It is not a background job while Telegram is closed.

Revision 89 deployed this acceleration on 11 October 2026. Validation passed 976 backend tests (two intentional skips), 615 frontend tests, TypeScript, the Telegram production build and 14 Storage-card rendering cases. Three bounded live requests advanced the existing sync-history stage from cursor 2,964 to 3,338 (59% to 67%). All 4,958 saved event rows, immutable-column byte totals and the decoded latest checkpoint matched their pre-request checks; no provider requests were made. These inspected rows contained no removable duplicates, so reclaimed bytes stayed unchanged. This verifies progress and preservation, not completion of the entire cleanup cycle.

While another gift, comparison or analytics update is running, idle cleanup actions show disabled **Waiting…**, including paused, blocked, failed and completed cleanup states. The underlying error or session limit remains visible, and its action returns when the update settles. Only previously scheduled cleanup resumes automatically; waiting does not queue a new manual request or retry an uncertain failure. An already-sent maintenance request keeps its in-progress label until it returns.

If all safe duplicates and disposable data are gone but usage remains above the resume threshold, updates remain paused. Archiving or deleting unique history requires a separate retention decision; cleanup does not silently discard it.

## Additive deployment setup

Deploy the six service metadata tables with the guarded schema tools, inspect the dry run, and use only the safe additive migration. Before publishing code that enforces admission, install accounting triggers and its one-time baseline:

```powershell
node serverless/tools/manage.mjs --action publish-schema --app-id YOUR_APP_ID
node serverless/tools/manage.mjs --action migrate-check --app-id YOUR_APP_ID
node serverless/tools/manage.mjs --action migrate-safe --app-id YOUR_APP_ID
node serverless/tools/install-storage-accounting.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --after 0
```

Continue with the returned `after` cursor until `complete: true`. Each invocation installs at most six fixed triggers and makes zero provider requests. The final baseline activates accounting in one SQL statement after every trigger is installed. Re-running a completed setup verifies the trigger count and never resets live counters. The accounting installer stays in `serverless/tools/`, outside the deployed module manifest. Do not remove triggers or roll back to checkpoint readers that lack the already-persisted reference formats.

Then install the four source-protection triggers and lookup index:

```powershell
node serverless/tools/install-storage-accounting.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --source-index true
```

For an existing 81-trigger deployment, this command upgrades accounting to 84 triggers only while the new pin table is empty, then installs source protection. It never resets the initialized counter. Backfill runs through bounded maintenance after publication; indexed cleanup fails closed until a scope is complete and all four source triggers remain present.

Then publish the validated backend and frontend. Complete an initial bounded cleanup and verify source evidence, current checkpoint and request usage remain unchanged. Never treat reclaimed logical bytes as proof of a larger platform quota.

## Storage efficiency review — 11 October 2026

The measured owner database contained 4,087 event rows and about 469.5 MB of application payload after exact-duplicate maintenance. The event log accounted for 468.4 MB; all analytics snapshots together occupied about 1.1 MB. These are decimal MB and logical payload estimates, not database file size.

| Event column | Measured size | Function and retention |
| --- | ---: | --- |
| `raw_body` | 149.5 MB | Original provider response. Runtime readers use the validated records and checkpoint instead. New private, website and invited-account saves discard this duplicate body. |
| `state_json` | 115.7 MB | Current checkpoint, referenced component roots, refresh session/results and request state. Most historical operational copies can eventually be retired after dependencies are folded. |
| `job_json` | 100.1 MB | Resumable jobs, latest job summaries and checkpoint job sources. Intermediate copies are a retention opportunity, with additional source fences required first. |
| `records_json` | 102.9 MB | Portfolio/settings, validated source observations, rental and price history. Keep these until a versioned normalized store preserves identity, conflicts, provenance and idempotency. |

The owner authorized deletion of unnecessary data. The bounded administrative provider-body purge removes only `raw_body`; it leaves event rows, keys, sequence numbers, records, checkpoints, financial analytics, credentials and request counters intact. A raw provider response can be lost, but the source items actually used by pricing remain in `records_json.source_json`. This is a deliberate retention change from the earlier evidence-preserving cleanup policy. Future appends charge only the bytes they retain, while original response presence continues to prevent provider results from being misclassified as recovery-control operations.

The live revision 82 cleanup removed all 1,872 legacy bodies, reclaiming **149,515,698 bytes**. Payload usage fell from **469,524,672 to 320,008,974 bytes** (87.5% to 59.6% of the safety budget), and update admission became available. Aggregate retained-column checks and the original checkpoint hash matched the pre-cleanup baseline; analytics, credentials, account bindings and saved progress were unchanged. Accounting matched all 84 triggers, invited-account isolation remained intact, and the saved dashboard loaded 194 rows (161 portfolio gifts and 33 candidates). No provider requests were made. The backend suite passed 898 tests with two intentional skips.

Publish the updated repositories first, then inspect the legacy response inventory:

```powershell
node serverless/tools/purge-provider-bodies.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID
```

The default is a read-only check. Once retention deletion is authorized, use bounded passes:

```powershell
node serverless/tools/purge-provider-bodies.mjs --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --mode apply --batches 64 --calls 12
```

Each pass holds the existing global maintenance lease, selects at most 25 rows and 512 KiB of raw payload, and advances one oversized legacy body alone. Each RPC stops starting passes after ten seconds. Private/public migration guards are checked inside the deletion statement. Accounting triggers subtract the actual bytes; the monitor preserves its cleanup cursor and recalculates pause hysteresis. Output contains only aggregate counts and bytes. No provider calls are made, and an uncertain or throttled write is not retried automatically; inspect a fresh check before starting another invocation.

The next useful changes, in order:

1. **Retire old operational snapshots.** Preserve the current head and required source components, the latest checkpoint per resumable job, gift-refresh session results, import receipts, identity fences and discovery delta roots. Synchronize owned-run archives through a frozen boundary first. Add an exact prior-job source fence to append before removing `job_json` sources; current append assumes those job columns are immutable. The source-pin index is conservative and includes references from obsolete snapshots, so it is not itself a minimal live root set. Keep event keys and sequence numbers even when obsolete state is reduced.
2. **Use indexed, normalized observations.** Separate gift/collection/model/backdrop metadata from rental events; identify a rental once and store compact validated facts, source variant identity and provenance. Preserve action, currency, extension and conflict semantics. Record unchanged asking prices as observation spans while retaining changes and failure barriers. This reduces storage and avoids rebuilding every dashboard from the whole JSON log.
3. **Define record retention around features.** Pricing needs the configured bounded comparison window. Recorded rental counts currently use all saved history, and performance tracking uses price/status transitions, so deleting old history needs compact per-gift rental aggregates and distinct start identities first. Invited analytics now retains the latest capture per wallet/reporting span and snapshots still needed to confirm refreshes, removing its ten-snapshot insertion ceiling. Applying an equivalent policy to private-owner captures remains a future option. Nonces, credential generations, revocation tombstones and request usage remain required and are small.
4. **Compress cold data if retained.** The deployed V8 runtime probe found no native `CompressionStream`, `DecompressionStream` or Node `Buffer`/zlib. A bundled JavaScript codec or offline archive is possible, with versioning, expansion bounds and checksums. Active checkpoint/source fences and filtered record reads use SQL JSON paths and textual kind/settings lookups, so whole-column compression requires new readers and guards. Synthetic examples compressed listing/rental JSON by 87–94% with gzip, but those are directional examples rather than measured production savings. Base64 adds roughly one third to compressed binary size.

Deleting old market history or stripping unknown source fields immediately would change sample validation, conflict handling, rental counts or price-performance evidence. The unused response bodies provide the largest immediate reduction without changing those user-facing calculations.
