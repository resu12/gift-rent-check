# Rental history interpretation evidence

Evidence version: `marketapp-rent-history-ui-v1`. Public UI checked on **8 October 2026 at 18:21:25 UTC** (20:21:25 Europe/Berlin). The fixture is [rental-history-evidence.json](../tests/fixtures/marketapp/rental-history-evidence.json).

The pinned [OpenAPI schema](openapi.json) describes `RentHistoryEvent.price` as human-readable GRAM and `price_nano` as nanoGRAM. It does not document the units of `ts` or `duration`, whether `price` covers the whole rental, or whether the amount is gross or net. The interpretation below comes from matching saved API events to Marketapp's public UI; it is **observed behavior, not an OpenAPI guarantee**.

## Public UI matches

The [Marketapp rental history](https://marketapp.org/rent/?tab=history&subtab=gifts) table labels the amount **Full Price** and the period **Rent Period**. Its rows show periods as `Days: N`. NFT detail pages expose the same events under **History → Rents**, with columns Price, Duration, Date, Landlord, and Tenant.

| Gift | API price | API duration | UI price | UI duration | API `ts` and matching UI `time[timestamp]` | Derived daily rate |
|---|---:|---:|---:|---|---:|---:|
| [Electric Skull #7334](https://marketapp.org/nft/EQBtr8w0Spmjbe3wIdZfzM1_km1qtyvGEWhdiq5HWoLq3ml-/?to=rent) | 0.5997 | 259200 | 0.5997 | Days: 3 | 1791440387 | 0.1999 GRAM/day |
| [Timeless Book #36637](https://marketapp.org/nft/EQACxvSEQaTeNVG2x3rsHO5SeNWfF8goqSYKdc8hEJ6Qnu09/?to=rent) | 0.0233373 | 604800 | 0.0233373 | Days: 7 | 1791471297 | 0.0033339 GRAM/day |

Both rows link to the exact transaction hash saved in the corresponding API event:

- Electric Skull: [`9e3a24…09c3`](https://tonviewer.com/transaction/9e3a24cae64bfd8fc82cdff9bf45438360c7fbfb8d50e4823a0b8a7201ff09c3).
- Timeless Book: [`8c3ed8…6ea8`](https://tonviewer.com/transaction/8c3ed888b398e769d1bf5b6cc52c39046c50575301de473df9dac743e2156ea8).

The displayed current price per day also matches each derived rate. That is supporting evidence, not proof that a current listing always represents the rate agreed at an earlier event. Prices and discount settings can change.

The exact raw API events, full NFT addresses, transaction links, UI values, and capture time are preserved in the fixture. No API token or personal wallet configuration is included.

## Supported calculation

For suitable GRAM history records, the observed interpretation is:

```text
event_time = UTC Unix time in seconds from ts
rental_days = duration / 86400
effective_daily_rate = price * 86400 / duration
```

Use exact decimal arithmetic. Require an explicitly supplied positive duration, a valid event timestamp, a nonnegative finite amount, and consistent `price` / `price_nano` values. A supplied zero amount is distinct from missing data. Do not turn absent or zero duration into a one-day rental. Do not infer units for other currencies or mix them into GRAM statistics.

Filter the selected timeframe by the event timestamp, rather than by the day it was downloaded. An event's full paid period can extend outside that timeframe. An arithmetic mean gives each eligible recorded rental event one vote; it differs from weighting by rental days or by unique NFT.

Call this a **history-derived effective daily rental rate** or **recorded rental price**, not the landlord's net income. Gas, fees, refunds, gross/net treatment, and rental completion remain unresolved. A rental history entry can describe an ongoing rental.

## Limits and conservative handling

- Both verified examples have `is_extend=false`. They do not establish whether extension `duration` is incremental or cumulative, or whether its price is incremental. Exclude extensions from daily-rate calculations until separate evidence establishes that relationship, and expose their excluded count. Preserve their original records.
- History does not include model/backdrop in its documented schema. Join traits only through validated evidence for the same canonical NFT address and collection; do not infer them from names. Describe later-observed traits as later metadata, rather than claiming they were recorded with the rental.
- The API does not supply a guaranteed unique event ID. Deduplicate identical representations, including canonical address aliases, across page/run occurrences. A transaction hash can link multiple gifts or changed representations and must not serve as a globally unique key. Ambiguous changed variants should not receive multiple votes in an average; conservatively exclude the ambiguous event group and retain its evidence.
- Counts and date ranges describe the saved sample. Bounded or incomplete collection does not establish complete rental history for the requested timeframe. Do not substitute listing prices when rental history lacks enough eligible observations.
- The original normalized records can retain the unresolved-unit flags from the pinned contract. This evidence supports a separately versioned analytical interpretation without rewriting historical raw data or claiming the specification changed.
