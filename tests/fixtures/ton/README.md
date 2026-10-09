# Observed Marketapp contract fixtures

These are public chain observations captured on 2026-10-08 for the two examples
supplied by the user: Electric Skull #6175 and Timeless Book #53508. They contain
no API credentials and no wallet-wide holdings or transfer history.

`holder-states.json` and `sample-nfts.json` retain the original TON Center v3
responses and observation times. The four `*-identity.json` / `*-state.json`
files retain independent, read-only getter responses collected during research.
Production discovery uses only v3 GET requests and local BOC decoding.

The pinned `observed-code.boc.base64` cell root hash is:

`f3b93b1d262f709aff1ec25ae39141a7ecdd8c8a29b87a2b6bb1cdab4aec714a`

Original variant identity: `marketapp-observed-f3b93b1d-v1`. This observed variant differs
from the revisions in the official registry inspected during research:
<https://github.com/ton-blockchain/abis/blob/master/data/marketapp/info.toml>.
Registry names and explorer interface labels are not used to identify it.

## Layout evidence

Inspection of this exact code's getter disassembly showed:

- Root: four references, then a 256-bit public key.
- Ref 0 / getter 124409: owner, NFT, operator (MsgAddress each), uint64 creation
  timestamp, uint2 role (0 original, 1 derived).
- Ref 1 / getter 86957: uint3 status, uint32 rental duration, uint64 rental-until,
  Coins price, renter and counterpart addresses (both may be null).
- Ref 2 / getter 103798: uint1 auto-relist, uint32 minimum and maximum duration,
  Coins configured price, three uint32 discount settings, Coins sale price.
- Ref 3 / getter 67344: two fee tuples, each MsgAddress + two uint32 values.

The original contract held the Electric Skull with role/status 0/0 and no renter.
The derived contract held the Timeless Book with role/status 1/1, a renter and a
counterpart contract. The getter fixtures independently verify every decoded
identity and state field. No broad interpretation of other status values or
discount/payment semantics is made. Neither these observations nor the decoder
constitutes a full contract security audit.

## Second observed rental variant

The decoder registry version is now `marketapp-rental-registry-v2`. It accepts
exactly the original hash above and the separately pinned second hash:

`7f44beadf4911724268d7008c490be627f203047fea4d3276b51bdfd55bf23fc`

Its variant identity is `marketapp-observed-7f44bead-v1`. Both variants use storage
layout `marketapp-four-refs-two-fees-v1`; the precise variant remains part of
every successful decode's evidence. A discovery run created with the old decoder
version must start fresh rather than resume with different verification rules.

`7f44-idle.json` (Swiss Watch #9790) and `7f44-rented.json` (Heart Locket #1767)
contain only selected public NFT and contract fields captured on 2026-10-08,
including the observation timestamps and matching before/after NFT records.
The shared code BOC is `observed-7f44-code.boc.base64`. Balance, unrelated batch
members, off-chain metadata, credentials, and private exports are excluded.

`observed-7f44-layout.tasm` pins the storage loader and getters extracted from
independent offline disassembly with official [`@ton/tasm` 0.6.2](https://github.com/ton-blockchain/tasm).
The loader (22), getters (67344, 78748, 86957, 103798, 124409), internal receiver
(0), and helpers 42–47 and 49–51 are identical to the original pinned variant.
`observed-7f44-code-diff.txt` retains the complete disassembly difference:
fee/referral helper 48 and external receiver -1 differ. In particular, the
second variant's signed external messages have a different timestamp window
and contract-address binding. No transaction support or behavioral equivalence
beyond the inspected storage/ownership interpretation is implied.

To reproduce the comparison with the official tool in a separate tools folder:

```powershell
npm install --ignore-scripts --no-audit --no-fund @ton/tasm@0.6.2
npx tdisasm observed-code.boc.base64 -f base64 -o original.tasm
npx tdisasm observed-7f44-code.boc.base64 -f base64 -o second.tasm
```

Both code/data root hashes, strict cell layout, owner, NFT, operator and current
NFT holder/recheck are required. Similar layout, interface labels, and other
Marketapp revisions do not expand the allowlist.
