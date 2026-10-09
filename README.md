# Gift Rent Check

A Python 3.12+ application for discovering wallet gifts on TON, collecting Marketapp rental data into SQLite, and comparing daily listing prices or recorded rental rates. The private dashboard recommends an observed average for the collection, exact model, or exact model with a Black backdrop, with selectable timeframes, sample sizes, and evidence. Collection and discovery are bounded and resumable, with offline inspection exports. It never changes prices, submits transactions, uses paid ownership discovery, or installs a scheduler.

The project includes a local React dashboard and a private Telegram Mini App backed by Telegram Serverless. Both show saved evidence and exact three-decimal prices. The Telegram app can refresh known gifts' configured TON contract prices on startup; Marketapp comparison collection remains manual and bounded. Its optional mainnet TON Connect control connects or disconnects a wallet without changing the saved portfolio or granting backend access; see [wallet setup](docs/telegram-serverless.md#connect-and-disconnect-a-wallet).

**Version 0.2.0** improves dashboard readability and separates recommendation sample size from comparison match. See the [release notes](CHANGELOG.md) for changes and compatibility details.

Start with the Windows setup below, then follow the [local dashboard guide](docs/dashboard.md) or [Telegram deployment guide](docs/telegram-serverless.md). [Repository and GitHub setup](docs/github.md) explains what is excluded from version control and how to verify a fresh clone. Python 3.12, Node.js 24, and pnpm 11.25.0 are the tested development toolchain. No credentials or private portfolio dataset are included.

The API contract is pinned in `docs/openapi.json`; `docs/openapi.sha256` records its SHA-256 checksum. Only these authenticated GET routes are allowed:

| Route | Purpose |
| --- | --- |
| `/v1/rent/gifts/` | Paginated rental listings |
| `/v1/rent/gifts/history/` | Paginated history, using `gifts` in the schema's category route |
| `/v1/collections/gifts/` | Full, unpaginated collection catalog |
| `/v1/collections/{collection_address}/attributes/` | Attributes for a selected collection |

The client sends the raw API token as `Authorization`, without a `Bearer` prefix. `/my-rented/` is not used as ownership evidence.

## Setup on Windows

Install Python 3.12 or later. In PowerShell, from this project directory:

```powershell
py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -c requirements-dev.lock -e '.[dev,dashboard]'
Copy-Item .env.example .env
Copy-Item examples\portfolio.csv portfolio.csv
```

`requirements-dev.lock` records the dependency versions used for verification. For CLI-only use, install `'.[dev]'` instead of `'.[dev,dashboard]'`. The verification suite runs on Python 3.12 even if another `python` command is already installed.

Before the first dashboard launch from a clone, install Node.js 24 and pnpm 11.25.0, then build its generated assets:

```powershell
powershell -File scripts\build-dashboard.ps1
```

This installs locked frontend dependencies, runs the frontend checks, and copies the production bundle into the Python package. Generated assets are ignored by Git. Build them again after changing the frontend and before creating a Python wheel. CLI collection and reports do not require Node or a frontend build.

Edit `.env` locally to add `MARKETAPP_API_TOKEN`. Existing environment variables take precedence over `.env`. Do not paste a token into a command, issue, or shared report. Fill in `portfolio.csv` with your actual NFT addresses and, when known, collection addresses:

```csv
nft_address,collection_address,label
YOUR_NFT_ADDRESS,YOUR_COLLECTION_ADDRESS,Optional label
```

`nft_address` is required; `collection_address` and `label` are optional. Valid TON addresses are compared by their canonical chain identity, so friendly and raw forms of the same address match. Original address strings remain in source evidence. Legacy opaque CSV identifiers retain exact-match behavior. CSV imports declare portfolio membership; they do not prove ownership. Reimports are idempotent, and omitted rows do not remove existing members. An omitted optional column preserves its stored value; a present blank cell clears it. Imports with only NFT addresses are supported through a bounded unfiltered scan. CSV imports remain optional when using wallet discovery.

## Use

For the private browser dashboard, install the optional dependencies with `pip install -c requirements-dev.lock -e '.[dev,dashboard]'`, then run `marketapp-rent dashboard`. It opens saved data at <http://127.0.0.1:8765>. Add `--allow-price-refresh` for the same automatic TON-only rent price check as Telegram; this leaves Marketapp collection disabled. Manual collection requires `--allow-network`, which also enables the startup price check. See [dashboard setup, evidence rules, and refresh workflow](docs/dashboard.md). Dashboard jobs continue through batches within firm defaults of 100 Marketapp requests and five minutes per start/resume, plus 500 requests per rolling 24 hours across this queue. Retries count; the daily cap survives restarts. Rental-price jobs stop at the selected timeframe's lower boundary. Use **Stop** to save progress and **Resume** to continue; errors and app restarts still require attention. CLI invocations retain separate bounded budgets. Telegram hosting uses the [private pricing dashboard](docs/telegram-serverless.md), with a separate cloud request ledger. Use one active Marketapp collector.

The dashboard starts on **Pricing** with **Actual rentals**, **Last 30 days**, and **Biggest increase first** selected. Switch between **Listing prices** and **Actual rentals**; choose 24 hours, 7/30/60/90 days, or inclusive custom UTC dates covering at most 90 days. Longer windows are always an explicit choice. Collection, model, and model + exact Black averages and exports follow that selection. Recommendations require at least three distinct peer gifts. Listing windows use observation time; rental windows use event time and normalize recorded full prices by duration. Changing the view reads saved data only. New history collection stays within the last 90 days; older custom ranges inspect existing local history. Use `collect-prices` or `collect-rental-prices` (and their `--resume RUN_ID` options) to populate the corresponding source. [Pricing methodology and collection instructions](docs/pricing.md) explain the observed history interpretation, exclusions, and sample coverage.

Virtual-environment activation is optional; the examples invoke its executable directly.

```powershell
& .\.venv\Scripts\marketapp-rent.exe import-portfolio portfolio.csv
& .\.venv\Scripts\marketapp-rent.exe collect
& .\.venv\Scripts\marketapp-rent.exe status
& .\.venv\Scripts\marketapp-rent.exe report --out exports
```

`status`, `report`, and `import-portfolio` work without a token or network access. The default database is `data/marketapp.sqlite3`. Put global options before the subcommand:

```powershell
& .\.venv\Scripts\marketapp-rent.exe --env-file .env --db data\marketapp.sqlite3 status
& .\.venv\Scripts\marketapp-rent.exe collect --collection-address YOUR_COLLECTION_ADDRESS --page-size 10 --max-pages 2
& .\.venv\Scripts\marketapp-rent.exe collect --resume RUN_ID
& .\.venv\Scripts\marketapp-rent.exe report --out exports --owner-address YOUR_WALLET_ADDRESS
& .\.venv\Scripts\marketapp-rent.exe collect --help
```

Use the run ID shown by collection/status in place of `RUN_ID`. `collect` starts at the head of a fresh traversal. `collect --resume` continues the saved streams at their committed cursors. A run's collection scopes, page size, filters, and sort orders stay fixed; explicitly supplying incompatible options on resume is an error. Request, page, and time budgets apply anew to each invocation. If a cursor expires or is rejected, start a fresh run.

| Collection option | Environment variable | Default |
| --- | --- | --- |
| `--page-size` | `MARKETAPP_PAGE_SIZE` | `10` (1–100) |
| `--max-pages` | `MARKETAPP_MAX_PAGES` | `2` per stream per invocation |
| `--max-collections` | `MARKETAPP_MAX_COLLECTIONS` | `3` scopes |
| `--max-attempts` | `MARKETAPP_MAX_ATTEMPTS` | `25` HTTP attempts per invocation |
| `--run-seconds` | `MARKETAPP_RUN_SECONDS` | `300` seconds per invocation |
| `--requests-per-second` | `MARKETAPP_REQUESTS_PER_SECOND` | `1` |
| `--timeout` | `MARKETAPP_TIMEOUT` | `30` seconds |
| `--retry-attempts` | `MARKETAPP_RETRY_ATTEMPTS` | `4` attempts per request, including the first |
| `--sort-by` | `MARKETAPP_SORT_BY` | `recently_touch` for listings |
| `--order-by` | `MARKETAPP_ORDER_BY` | `new_to_old` for history |

`--collection-address` is repeatable. `--model`, `--symbol`, and `--backdrop` filter listings only. History is collected for the collection scope and matched to the portfolio locally. Run `collect --help` for the documented sort choices. `MARKETAPP_DB_PATH` sets the database path, and optional `MARKETAPP_OWNER_ADDRESS` supplies a wallet to compare with observed listing owners.

By default, collection scopes come from the portfolio in stable address order. An unfiltered scope is added after known collections when any imported NFT has no collection address; it also counts toward the scope limit. Every skipped scope is reported, with the unfiltered scope labeled `<unfiltered>`. Resume does not add skipped scopes: start a new run with explicit `--collection-address` options, or a larger scope limit, to cover them. A run that skipped scopes remains partial. Collection-catalog metadata is fetched in full because the API documents no pagination for that route.

Requests run sequentially. Network failures, HTTP 429, and transient 5xx responses retry with exponential backoff and jitter; `Retry-After` is honored. Each retry consumes the HTTP-attempt budget. If a required delay exceeds the remaining time budget, collection stops with resumable state. The retry deadline persists in SQLite so a resume or a fresh run using the same database also respects it. Authentication failures stop collection promptly.

## Wallet discovery

Set `MARKETAPP_OWNER_ADDRESS` locally or pass a mainnet wallet with `--wallet`. A fresh discovery run requires `MARKETAPP_API_TOKEN` to refresh the free collection catalog. `TONCENTER_API_KEY` is optional and is sent only to TON Center as `X-API-Key`. Credentials are never stored with run settings. Command-line options override environment settings; existing environment values override `.env`.

```powershell
& .\.venv\Scripts\marketapp-rent.exe discover-wallet --wallet YOUR_WALLET_ADDRESS
& .\.venv\Scripts\marketapp-rent.exe discover-wallet --resume DISCOVERY_RUN_ID
& .\.venv\Scripts\marketapp-rent.exe status
& .\.venv\Scripts\marketapp-rent.exe collect
& .\.venv\Scripts\marketapp-rent.exe report --out exports
```

Discovery enrolls verified gifts automatically. `collect` remains a separate command. A resume uses its saved wallet even if `MARKETAPP_OWNER_ADDRESS` has changed; explicitly supplying a different `--wallet` is rejected. It reuses the committed catalog and therefore does not require the Marketapp token once the catalog is saved. A failed catalog refresh does not use an older catalog.

| Discovery option | Environment variable | Default |
| --- | --- | --- |
| `--page-size` | `TON_DISCOVERY_PAGE_SIZE` | `100` (1–1000) |
| `--batch-size` | `TON_DISCOVERY_BATCH_SIZE` | `100` addresses (1–100) |
| `--max-pages` | `TON_DISCOVERY_MAX_PAGES` | `10` per enumeration stream per invocation |
| `--max-attempts` | `TON_DISCOVERY_MAX_ATTEMPTS` | `100` total HTTP attempts per invocation |
| `--run-seconds` | `TON_DISCOVERY_RUN_SECONDS` | `300` seconds per invocation |
| `--requests-per-second` | `TON_DISCOVERY_REQUESTS_PER_SECOND` | `1` |
| `--timeout` | `TON_DISCOVERY_TIMEOUT` | `30` seconds |
| `--retry-attempts` | `TON_DISCOVERY_RETRY_ATTEMPTS` | `4` attempts per request, including the first |

These settings are independent of the Marketapp collection budgets. Requests are sequential and retries consume the shared discovery attempt budget. HTTP 429, transient 5xx, and network failures use bounded exponential backoff with jitter. `Retry-After` deadlines persist by provider: TON throttling does not delay Marketapp requests. Page size, wallet, catalog, traversal boundaries, and decoder version stay fixed for a resumed traversal. Invocation budgets may change. Start a fresh run for a new catalog or decoder.

The TON client permits only GET requests to mainnet TON Center `/api/v3/nft/items`, `/api/v3/nft/transfers`, and `/api/v3/accountStates`. It reads account code and data and decodes them locally with `pytoniq-core`; it neither runs remote getters nor submits transactions. The Marketapp route allowlist remains the four routes above.

Discovery combines directly held NFTs, successful inbound/outbound wallet transfers, and gifts previously verified for this wallet. Transfer history supplies candidates, never proof of current ownership. Holdings use `include_on_sale=false` and offset pagination. Transfers scan newest first without a date limit, keeping a fixed highest logical-time boundary and advancing through equal logical times without deliberately skipping ties. Short pages continue until an empty page; repeated pages without progress stop with an error. Candidate verification is interleaved with enumeration, and earlier verified gifts receive priority on new runs.

Only collections in the run's fixed Marketapp catalog are eligible, matched by canonical address. Names, images, descriptions, and metadata URLs do not establish identity. Unrelated collections are recorded as excluded; missing or conflicting collection evidence remains unresolved. Previously enrolled gifts are retained when later verification fails or ownership changes. Imported labels and conflicting evidence are preserved, and CSV declarations remain distinguishable from TON verification.

Direct ownership requires the observed NFT owner to match the wallet. Rental ownership additionally requires an active holding contract, an exact supported code hash, validated code/data root hashes and storage layout, and matching decoded owner, NFT, and Marketapp operator. The NFT holder and logical time are rechecked after reading contract state; a change permits one retry, then remains unresolved. Other marketplaces' custody arrangements and unsupported contract hashes do not qualify automatically.

The decoder registry supports these exact observed Marketapp rental code hashes:

```text
f3b93b1d262f709aff1ec25ae39141a7ecdd8c8a29b87a2b6bb1cdab4aec714a
7f44beadf4911724268d7008c490be627f203047fea4d3276b51bdfd55bf23fc
```

Pinned fixtures and layout evidence cover Electric Skull #6175 and Timeless Book #53508 for the first variant, plus idle and rented examples of the second variant. The registry version is `marketapp-rental-registry-v2`; each observation records its variant and storage layout. Saved getter evidence supports the identity/state layout. These are observed variants, distinct from revisions in the [official TON ABI registry](https://github.com/ton-blockchain/abis/blob/master/data/marketapp/info.toml). Explorer labels alone are never trusted for decoding. Start a fresh discovery after a decoder upgrade: old traversals retain their original decoder version and incompatible resumes are rejected. Installing the decoder does not retroactively enroll reviewed gifts.

Ownership reports preserve raw role/status values alongside `held_directly`, `idle_rental_contract`, `rented`, `expired_pending_return`, or `unknown`. An idle contract does not prove a visible Marketapp listing; expiry does not prove that the NFT returned. Observation times are per response, not a simultaneous snapshot. [TON Center holdings pagination](https://docs.ton.org/api/v3/nfts/get-nft-items) can change during a scan; indexer lag/backfill and moving accounts also prevent a guarantee of complete ownership coverage. A completed indexed traversal may still have unresolved candidates.

Database schema v1 upgrades atomically to v2 on opening, retaining existing Marketapp observations and fingerprints. Discovery runs, raw responses, checkpoints, candidates, fixed catalogs, and ownership observations are stored separately from collection runs. Each valid enumeration page and checkpoint commits together; verification evidence, queue completion, and enrollment also commit together. Invalid responses retain evidence without advancing a checkpoint. `status` lists separate discovery run IDs, pending verification, unresolved reasons, and resumable work. A database from a newer application version is rejected rather than modified.

## Interpreting the data

SQLite retains run/stream status, checkpoints, raw responses, normalized records, timestamped observations, and portfolio evidence. Each valid page and its next cursor commit together. Invalid responses are retained separately and do not advance the checkpoint. Cursors are opaque: only a null cursor ends a traversal, including when a preceding page is empty. Cursor cycles are errors.

Reports export twelve CSVs: `portfolio_coverage`, `listing_observations`, `history_records`, `history_occurrences`, `collections`, `attributes`, `run_status`, `stream_status`, `issues`, `discovery_runs`, `discovery_candidates`, and `ownership_observations`. Exports include available provenance, timestamps, units, and uncertainty. Portfolio coverage separates membership sources, latest TON ownership evidence, and Marketapp listing visibility. `--owner-address` selects the wallet whose ownership evidence is shown there; the complete ownership export retains all wallets. They use UTF-8 with a BOM for Windows spreadsheet compatibility, and prefix potentially executable text cells with an apostrophe. Unknown values remain empty rather than becoming zero. Consult run status alongside any data export: `complete` means the traversal reached its end, not that every market state was observed at one instant.

- Portfolio membership survives missing listings. An unobserved gift has unknown current visibility and retains its last observation. A partial scan cannot establish that a gift is absent from the marketplace.
- An optional wallet comparison distinguishes matching and conflicting observed listing owners. It does not establish ownership at the time of a history event.
- Collection associations come from a collection-filtered request, an imported mapping, observed history, or TON discovery, with their source recorded. Gift names are never used to infer collection identity.
- Listing prices convert from nanoGRAM using `Decimal`. Monetary decimals are stored as text rather than SQLite floating-point values. History keeps its original currency, `price`, and `price_nano`; inconsistent GRAM pairs are flagged, and other currencies remain separate.
- History is labeled **portfolio gift history**, not income received by the current user. Timestamp/duration units, `src`/`dst` roles, discount calculations, collection rental-floor units, and gross-versus-net payment meanings are not established by this schema. A separately versioned [public UI interpretation](docs/rental-history-evidence.md) supports history-derived daily comparison rates without rewriting raw evidence. Net revenue and historical ownership remain unproven.
- Identical history representations share a canonical fingerprint; page occurrences and changed variants remain available. Neither fingerprints nor transaction hashes establish a unique transaction count. Repeated hashes across gifts and missing hashes are retained.
- Listings, collection metadata, and attributes retain snapshots across runs. Raw records preserve missing fields, explicit nulls, and supplied values, even when a flat CSV cell cannot represent all three states.

Database files, portfolio CSVs, `.env` files, logs, and exports are ignored by Git. Treat raw responses and exports as private data when sharing files.

## Verification and exit statuses

The [Telegram Serverless pricing dashboard](docs/telegram-serverless.md) reuses the pricing UI and exact comparisons, supports bounded listing/history refresh and Stop/Resume, and stores evidence in Telegram. Prepare and approve a scoped local portfolio/history export before importing it. Cloud TON ownership refresh remains deferred. See its guide for private access, request limits, import, deployment, and mocked/live verification.

```powershell
& .\.venv\Scripts\python.exe -m pytest
```

Tests use mocked HTTP responses, saved public sample fixtures, fake clocks, and temporary databases; no live token is required. They cover API restrictions and request parameters, exact monetary normalization, discovery and collection pagination/resume behavior, address aliases, contract verification, storage migration/atomicity/deduplication, provenance, failures/retries, and offline CLI reporting. The public sample tests do not depend on the gifts retaining their live rental states.

For a bounded live smoke test, configure your token and portfolio locally, import the CSV, then run:

```powershell
& .\.venv\Scripts\marketapp-rent.exe collect --max-pages 1 --max-collections 1 --max-attempts 6 --run-seconds 60
$LASTEXITCODE
& .\.venv\Scripts\marketapp-rent.exe status
& .\.venv\Scripts\marketapp-rent.exe report --out exports\smoke
```

For a bounded discovery smoke test using your wallet, configure the Marketapp token locally, then run:

```powershell
& .\.venv\Scripts\marketapp-rent.exe discover-wallet --wallet YOUR_WALLET_ADDRESS --max-pages 1 --max-attempts 10 --run-seconds 60
$LASTEXITCODE
& .\.venv\Scripts\marketapp-rent.exe status
& .\.venv\Scripts\marketapp-rent.exe report --out exports\discovery-smoke
```

This smoke test is intentionally partial. Continue its saved work with `discover-wallet --resume DISCOVERY_RUN_ID`; start a fresh run to refresh ownership and the collection catalog. If a saved boundary or decoder is incompatible, status/error output directs you to start fresh. No schedule or live smoke test is activated automatically.

| Exit code | Meaning |
| --- | --- |
| `0` | Completed traversal (possibly with unresolved discovery candidates), or successful offline command |
| `1` | Runtime or authentication error |
| `2` | Invalid configuration, usage, or portfolio import |
| `3` | Bounded or interrupted work remains; collection also uses it for partial stream failures |

Exit `3` is expected when a bounded run leaves additional pages or scopes. Inspect status to distinguish budget stops from errors. Future Windows Task Scheduler integration should capture this exit code and the run ID and treat a limit-stopped run as partial coverage. No schedule is installed by this project.
