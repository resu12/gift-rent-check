# Portable TON price decoder audit notes

`tgcloud/lib/ton-price-decoder.js` implements a synchronous, read-only decoder:

```js
decodePriceContract(account, nftAddress, walletAddress, observedAt)
```

Awaiting the return value is also supported. Addresses pass through the existing
`canonicalAddress` helper. Observation time must be an ISO timestamp with a time
zone. No account, NFT, metadata, getter, transaction or marketplace requests are
made by this module.

## Runtime dependencies and source provenance

The only runtime import is the project's `cloud-pricing-core.js`. There are no
new npm packages, bundles, transitive runtime dependencies or lockfile changes.
The module uses standard ECMAScript typed arrays, `DataView`, `BigInt`, arrays,
sets, strings and dates. It does not depend on Node, global `Buffer`, `atob`,
WebCrypto, dynamic imports, `require`, a native addon or a VM execution service.

The ordinary BOC parser, bit reader, CRC32C and SHA-256 are original project code;
no third-party implementation is copied or vendored, so no additional dependency
license is introduced. The serialization follows the TON
[BOC schema](https://github.com/ton-blockchain/ton/blob/master/crypto/tl/boc.tlb)
and [ordinary cell representation](https://docs.ton.org/foundations/serialization/cells).
SHA-256 follows [NIST FIPS 180-4](https://doi.org/10.6028/NIST.FIPS.180-4).

The Python fixture generator uses the existing development dependency
`pytoniq-core==0.2.1` and the local Python decoder as an independent oracle. Its
implementation is not included in the deployed JavaScript. The serverless tests
use Node's built-in crypto implementation only as an independent test oracle.

## Accepted serialization and fail-closed limits

Both public pinned code BOCs have 61 ordinary level-zero cells and occupy less
than 3.8 KiB. Data has a 256-bit ordinary root, exactly four references, and four
ordinary leaf cells. Only the two exact code hashes in the frozen registry are
accepted. Code and data root SHA-256 hashes are independently recomputed before
any ownership or price claim is made.

The focused parser accepts complete, standard `b5ee9c72` BOCs, with or without
an index and CRC32C. It verifies each index offset, any included CRC, cell sizes,
top-up bits, topological references, reachability, single-root structure and
absence of trailing bytes. BOCs may be hex or standard/URL-safe base64.

Nonzero cell levels, exotic cells, cached cell hashes, cache flags, absent cells
and legacy BOC formats are deliberately unsupported. They fail verification;
they are not heuristically treated as ordinary cells. Limits are 256 KiB, 4,096
cells, and depth below 1,024. These are conservative extensions to the Python
decoder's checks. Timestamp fields beyond JavaScript's exact integer range also
fail instead of silently rounding. Coins always remain decimal strings, including
the full 120-bit `VarUInteger16` range.

## Interpretation and caller obligations

The module preserves Python `marketapp-rental-registry-v2` identity and storage
interpretation. Owner, NFT and operator must match; addresses must be ordinary
internal mainnet addresses without anycast; roles must be 0 or 1. Every storage
leaf must be consumed completely. Unknown role/status combinations retain
`rental_state: "unknown"` even when ownership evidence verifies.

`configured_price_per_day_raw` comes from the settings cell. `price_per_day_raw`
comes from the ongoing rental state and is a separate field. The idle Skull
fixture proves the distinction: configured price 80,000,000, ongoing price 0.

The caller must require a recognized rental state, prove that this contract is
the NFT's holder in the intended collection, and reread the NFT after the account
snapshot to check owner and logical time. Verification does not establish live
Marketapp listing visibility, availability, or sale/discount/payment semantics.

## Reproduction

From the repository root:

```powershell
.venv/Scripts/python.exe serverless/tests/generate-ton-price-fixtures.py
node --test serverless/tests/ton-price-decoder.test.mjs
```

The committed parity file is generated only from public files under
`tests/fixtures/ton`. It contains the four Skull, Book, `7f44-idle` and
`7f44-rented` examples, plus independently rehashed adversarial storage cells.
It contains no API keys, private metadata or wallet-wide history.

Tests cover Python parity, both code pins, exact large coin values, owner/NFT/
operator mismatches, external/anycast/variable/workchain address rejection,
invalid roles, unknown status handling, expiration, all four truncated or
extended leaves, invalid BOC structure, CRC, index validation, hash spoofing,
and SHA-256 block-boundary vectors. All cases also execute in a V8 context with
Node and browser convenience APIs absent.
