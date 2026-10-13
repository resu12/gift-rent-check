# Price changes and rental performance

Desktop and Telegram derive tracking from their own saved price observations and Marketapp gift history. No additional provider requests, transactions or scheduler are required for tracking. Telegram personal gift refreshes add authenticated Marketapp account prices when available, with targeted TON checks as fallback; manual rental collection supplies rental samples. Desktop and Telegram retain separate datasets.

**Overview** shows up to five recent observed changes for portfolio gifts, with the price change and observed rental counts before and after. Telegram includes verified contract rental starts even when the corresponding Marketapp payment history has not arrived yet. Select a gift and expand **Price changes & performance** for the price change and compact before/after table. The default comparison is seven days, with 14 and 30 days available. Changing this selector reads the current saved projection only. **Comparison details** groups observation dates, methodology, excluded records, the latest five saved changes and first baseline; these remain available without filling the main comparison view.

## Price history

Authenticated **Marketapp account** daily prices take precedence when available for the saved wallet and gift. Otherwise, tracking uses verified configured TON prices, then saved Marketapp listings. Each source has a separate timeline; switching sources starts with that source's own baseline and never fabricates a cross-source price change. A personal-page observation does not prove on-chain ownership or submit a price change. The first valid observation establishes a baseline; repeated observations at the same price do not count as changes.

Telegram retains observed changes from all three timelines in its displayed history, including when a refresh introduces a new preferred source with only a baseline. It returns the latest five changes across sources, ordered by observation time; ties use account, contract, then listing order. Each change identifies its source and that source's latest check, and its performance comparisons stay within its own timeline. The count includes independent observations from every source; two sources may observe the same real-world edit separately. The baseline shown in details identifies the preferred source. Desktop keeps its existing source selection.

Ordinary refreshes, comparison-period changes and storage cleanup do not erase saved price observations. An explicit development reset or account deletion can remove them. After a reset, the first new checks establish fresh baselines; earlier changes cannot be reconstructed from current prices alone.

Change dates mean **first observed at the new price**, not the time a transaction or website change was executed. The last observation of the old price is also retained. Invalid, conflicting or unverified evidence interrupts usable continuity and remains disclosed. Amounts remain exact decimal text; asking prices display to three decimals and volume to one decimal.

## Performance comparisons

Before and after windows use the same elapsed duration. The before window ends at the last observation of the previous price; the after window begins at the first observation of the new price. The uncertain gap between those observations is excluded. Another observed change can shorten either window. A new change waits for its after period to elapse; a shortened period remains marked partial. A ready comparison means its time window has elapsed, not that collection coverage is complete.

Unverified evidence or a changed holder also limits comparisons. A closed segment stops at its last valid observation before the interruption; a resumed segment starts at its first valid baseline afterward. The unchecked intervals around that interruption are omitted.

The comparison counts eligible recorded base GRAM rentals beginning inside each end-exclusive window. Recorded volume sums their full recorded amounts, rental days sum their full durations, and the effective daily rate is total amount divided by total rental days. The same validation and deduplication rules used for pricing exclude extensions, non-GRAM amounts, inconsistent amount pairs, invalid timestamps or durations, and ambiguous variants. Page replays do not add weight; transaction hashes are linkage rather than unique event identifiers. See [rental history evidence](rental-history-evidence.md).

Telegram also counts strict, saved contract proofs of rental starts inside those same windows. Repeated checks of one start count once; a matching history record replaces the start-only evidence without adding another rental. Wallet and gift identity, verified ownership, observation time, and a consistent rental start/expiry must pass validation. An active rental badge or a website estimate alone does not add a rental. Starts in the uncertain price-change gap remain outside both comparisons.

**Observed rentals** combine eligible recorded rentals and verified starts whose payment history is still missing. **Payment history pending** identifies the latter. Recorded volume, rental days and effective daily rate continue to use eligible payment-history records only; a verified start never creates a payment amount from the asking price. Desktop and older projections without verified-start counts continue to show their recorded counts.

All performance values describe saved samples. A zero count means no eligible evidence was saved for the elapsed window, not proof that the gift was never rented. A window with no elapsed time has empty values. Collection limits, indexer gaps and historical availability still apply.

These observations do not establish income received by the wallet, fees, refunds, occupancy, completed rentals or net profit. They also do not establish that a price change caused a performance change. Personal Marketapp analytics remain separate saved snapshots in Overview. A currently displayed recommendation is not treated as the recommendation available at a historical price change.
