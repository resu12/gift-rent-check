# Backup, recovery verification and capacity drills

These owner tools do not deploy code, send provider requests or restore a live database. They require Node.js 24 with `node:sqlite` authorization support (validated on 24.19). The encrypted backup is independent of the application's existing credential-encryption key.

## Create an encrypted backup

Keep the backup encryption key separately from archives, in an access-controlled location outside Git. The application credential-encryption key and deployment configuration also need a separate secure backup; the database alone cannot decrypt credentials. Do not paste either key into a command, chat or release notes.

From the repository root:

```powershell
node serverless/tools/backup.mjs --action keygen --key-file .tmp/backups/operator.grc-backup.key
node serverless/tools/backup.mjs --action export --app-id YOUR_APP_ID --owner-id YOUR_OWNER_ID --key-file .tmp/backups/operator.grc-backup.key --archive .tmp/backups/before-upgrade.grc-backup.enc
node serverless/tools/backup.mjs --action verify --app-id YOUR_APP_ID --key-file .tmp/backups/operator.grc-backup.key --archive .tmp/backups/before-upgrade.grc-backup.enc
```

The first command creates a random 256-bit key without displaying it. On Windows, file mode `0600` is not a replacement for an appropriate NTFS ACL: move the key and archive to separately protected storage. Existing files are never overwritten. The archive and adjacent `.manifest.json` are ignored by Git. Copy both to your backup destination, and move the key to separate secure storage. Verify the copied archive using the original key before removing a local copy.

Export authenticates the explicit app ID against the CLI credentials and checks the owner ID against the deployed private configuration. It reads **every non-SQLite-internal table** from the app database, including encrypted credentials, nonce counters, account generations, deleted-account tombstones, request ledgers, analytics, compact evidence, checkpoints, archives and storage counters. It also preserves the actual table/index/trigger/view definitions. Data, schema and capture time are read in **one SQL statement**, avoiding a torn backup assembled from multiple live pages. Schema changes during descriptor discovery fail verification. The CLI never prints database contents or keys, and transient export code is not deployed.

The archive uses gzip inside AES-256-GCM with a fresh random nonce. An authenticated manifest records the app, deployment revision where available, per-table row counts and SHA-256 digests, and a digest of the complete snapshot. The adjacent manifest also records the encrypted archive's digest and byte count.

The export is bounded to 32 MiB of serialized snapshot data and at most 1,000 result chunks. A preliminary per-table size check avoids attempting already oversized exports; the final statement independently enforces the complete snapshot's limits. Schema objects and ordered row chunks are returned by one SQLite statement, avoiding both huge JSON function argument lists and an artificially oversized single response row. Silent truncation is detected from the statement's total row count. Telegram may impose a smaller response or execution limit. If any limit is exceeded, export **fails**, and does not fall back to a non-atomic paginated copy. Larger deployments need a verified native provider snapshot/export facility before public release. A successful small backup does not establish that facility or prove the hosting quota.

The October 12, 2026 development deployment could not be backed up with this bounded atomic exporter: read-only probes measured approximately 60 MB across 75,000 rows, and the host rejected full capture with a query row/result limit. No archive or successful recovery receipt was produced for that deployment. This is an outstanding hosting/recovery prerequisite, not a verified backup. A paginated export from a separately frozen maintenance snapshot could be designed later; this tool does not claim consistency across independent live reads.

## What recovery verification proves

Before saving, and whenever `--action verify` is used, the tool decrypts/authenticates the archive and creates an isolated **in-memory** SQLite database. It loads the data before reinstalling triggers, verifies SQLite integrity and foreign keys, then compares every table's rows and all schema objects with the original. SQL authorization blocks attachment to files and unsafe schema side effects. The tool never accepts a destination database path and cannot restore over a live app.

The safe JSON receipt reports `verified_at`, table/row counts and `live_restore_performed: false`. It also explicitly reports `credential_decryption_verified: false` and `nonce_rollback_safe_for_live_writes: false`. Keep this receipt with operational evidence. Verification proves database reconstruction and content integrity, not application-secret availability or an end-to-end hosted disaster recovery exercise.

## Recovering a deployment safely

There is deliberately no automated in-place live restore command. A database rollback can rewind encryption nonce counters, account-deletion generations, login proofs, replay ledgers and provider allowance timestamps. Reusing the same encryption key after such a rollback can reuse nonces even if the backup itself is internally consistent.

Before enabling writes on a recovered deployment:

1. Isolate the recovered app, disable collection/open registration, stop incoming writers and revoke access to the failed deployment.
2. Preserve post-backup deletion/revocation tombstones and request/cooldown history from an independent current source. Do not resurrect deleted users or regain provider allowance through rollback. If those high-water marks cannot be proven, require renewed account consent/verification, invalidate outstanding login/wallet challenges and respect at least the complete provider cooldown window.
3. Create a **new application encryption-key domain**. In the isolated environment, either re-encrypt retained credentials with the new key and collision-free fresh nonces, or clear all restored credentials and remembered login sessions and require users to reconnect. Keep the old key only for reading the archived ciphertext. Merely increasing the saved generation by one is not sufficient to prove nonce safety.
4. Validate wallet/account isolation, deletion fences, credential decryption or reconnection, current provider limits, database accounting and a representative read/write workflow in the recovered deployment. Verify backups from that deployment too.
5. Enable traffic only after the above controls and host recovery procedure are independently confirmed. Never use the verification receipt alone as authorization for a production rollback.

## Representative local capacity drill

```powershell
node serverless/tools/public-capacity-drill.mjs --accounts 16 --gifts 200 --observations 3
```

This uses the production account repository, compact-record triggers and storage admission with the current SDK-derived schema in local SQLite. Parallel promises interleave concurrent account writes. It checks account admission caps, cross-account isolation, compare-and-swap races, exact usage accounting, normalized-evidence deduplication, deletion/recreation generation fences, per-account quotas, and competing global reservations. Synthetic gift data is generated locally; no account credentials, provider APIs or hosted database are accessed.

The report includes a completion timestamp, workload, total/per-account logical bytes, source bytes before deduplication, local allocated SQLite pages and local read/write timings. It is useful for catching regressions and selecting an initial pilot cap. It explicitly reports `hosted_load_verified: false` and `hosting_quota_verified: false`. Local timings and allocated pages are **not** hosted latency or Telegram capacity measurements. A live invitation pilot with measured hosted latency/error rates and written hosting quota/recovery evidence remains required before enabling public registration.
