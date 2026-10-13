import type { ActivityComparisonEvidence } from './activityFreshness.ts';

export type JobKind = 'refresh' | 'discover' | 'collect' | 'prices' | 'rental_prices';
export type JobState = 'queued' | 'running' | 'partial' | 'complete' | 'failed';

export type PricingBasis = 'collection' | 'model' | 'model_black';
export type PricingSource = 'listings' | 'rentals';
// `all` remains readable on legacy saved jobs; it is not a selectable window.
export type PricingTimeframe = '24h' | '7d' | '30d' | '60d' | '90d' | 'all' | 'custom';
export interface PricingSelection {
  source: PricingSource;
  timeframe: PricingTimeframe;
  backdrop?: 'Black';
  dateFrom?: string;
  dateTo?: string;
}

export interface PriceCohort {
  mean: string | null;
  median: string | null;
  minimum: string | null;
  maximum: string | null;
  sample_count: number;
  distinct_nft_count?: number;
  observed_from: string | null;
  observed_to: string | null;
  coverage: 'observed_sample';
}

export interface GiftPricing {
  source?: PricingSource;
  backdrop?: 'Black' | null;
  unit?: string;
  sample_unit?: string;
  daily_comparable?: boolean;
  timeframe?: PricingTimeframe;
  date_from?: string | null;
  date_to?: string | null;
  collection: PriceCohort;
  model: PriceCohort;
  model_black: PriceCohort;
  recommended_price_per_day: string | null;
  basis: PricingBasis | null;
  /** Legacy API field. UI describes sample size and comparison match separately. */
  confidence: 'none' | 'low' | 'medium';
  reason: string;
  warnings: string[];
}

export interface GiftRentalHistory {
  recorded_count: number | null;
  coverage: 'partial' | 'no_history' | 'not_applicable';
  note: string;
  observed_at: string | null;
  first_rental_at?: string | null;
  last_rental_at?: string | null;
  excluded_counts: Record<string, number>;
}

export interface GiftRentalStatistics {
  version: 1;
  semantics_version: 'saved-gift-rental-statistics-v1';
  coverage: 'partial' | 'no_history' | 'not_applicable';
  observed_at: string | null;
  first_rental_at: string | null;
  last_rental_at: string | null;
  observed_rentals: number | null;
  recorded_rentals: number | null;
  verified_rentals_without_history: number | null;
  /** Eligible GRAM payments before fees; not attributed wallet income. */
  recorded_volume: string | null;
  average_daily_rate: string | null;
  rental_days: string | null;
  excluded_counts: Record<string, number>;
}

export interface PriceTrackingPeriod {
  window_from: string;
  window_to: string;
  /** Distinct rental start times from eligible history and verified TON evidence. */
  observed_rentals?: number | null;
  /** These starts contribute to observed_rentals, never recorded payments or rates. */
  verified_rentals_without_history?: number | null;
  recorded_rentals: number | null;
  recorded_volume: string | null;
  average_daily_rate: string | null;
  rental_days: string | null;
  excluded_counts: Record<string, number>;
  coverage: 'observed_sample';
}

export interface PriceTrackingComparison {
  days: 7 | 14 | 30;
  /** Ready describes elapsed time. History coverage remains an observed sample. */
  status: 'pending' | 'partial' | 'ready';
  comparable_days: string;
  before: PriceTrackingPeriod;
  after: PriceTrackingPeriod;
}

export type PriceTrackingSource = 'TON contract' | 'Marketapp listing' | 'Marketapp account';

export interface ObservedPriceChange {
  id: string;
  /** Each change is calculated within this source, independently of other timelines. */
  source?: PriceTrackingSource;
  source_last_observed_at?: string | null;
  observed_at: string;
  previous_observed_at: string;
  from_price_per_day: string;
  to_price_per_day: string;
  delta_per_day: string;
  percent_change: string | null;
  comparisons: PriceTrackingComparison[];
}

export interface GiftPriceTrackingData {
  version: 1;
  semantics_version: 'observed-price-performance-v1';
  /** Preferred source for the baseline and latest check; individual changes may use another source. */
  source: PriceTrackingSource | null;
  unit: 'GRAM/day';
  observation_count: number;
  change_count: number;
  last_observed_at: string | null;
  baseline_price_per_day: string | null;
  baseline_observed_at: string | null;
  coverage: 'observed_sample' | 'no_observations';
  /** Newest first across independently observed sources; the projection includes up to five changes. */
  changes: ObservedPriceChange[];
  warnings: string[];
}

export interface Gift {
  id: string;
  nft_address: string;
  name: string | null;
  collection_name: string | null;
  collection_address: string | null;
  image_url: string | null;
  state: string;
  display_state: string;
  ui_state: string | null;
  category: 'portfolio' | 'unresolved';
  is_portfolio: boolean;
  automatic_membership: boolean;
  membership_sources: string[];
  verification_method: string | null;
  proof_badges: string[];
  price_per_day: string | null;
  price_unit: string | null;
  price_source: string | null;
  price_observed_at?: string | null;
  price_is_historical?: boolean;
  /** Last attempted targeted price check; it is not a successful price observation. */
  price_checked_at?: string | null;
  model?: string | null;
  backdrop?: string | null;
  traits_source?: string | null;
  traits_observed_at?: string | null;
  trait_uncertainties?: string[];
  pricing?: GiftPricing | null;
  rental_history?: GiftRentalHistory;
  rental_statistics?: GiftRentalStatistics;
  price_tracking?: GiftPriceTrackingData;
  rental_until: string | number | null;
  rental_until_unix_seconds?: number | string | null;
  current_rental_started_at?: string | null;
  current_rental_start_source?: 'verified_contract' | null;
  last_verified_rental_started_at?: string | null;
  last_verified_rental_start_source?: 'verified_contract' | null;
  /** Rounded Marketapp label; display evidence, never an exact expiry. */
  rental_remaining_display?: string | null;
  rental_remaining_observed_at?: string | null;
  status_is_historical?: boolean;
  status_checked_at?: string | null;
  status_observed_at?: string | null;
  collection_conflict?: boolean;
  review_stale?: boolean;
  review_source_filename?: string | null;
  reviewed_at?: string | null;
  review_as_of?: string | null;
  holding_contract?: string | null;
  reason?: string | null;
  code_hash?: string | null;
  decoder_version?: string | null;
  observed_at: string | null;
  market_observed_at: string | null;
  explorer_url: string | null;
  uncertainties: string[];
}

export interface DashboardSummary {
  portfolio_count: number;
  automatic_count: number;
  review_count: number;
  for_rent_count: number;
  idle_count: number;
  rented_count: number;
  direct_count: number;
  sale_count: number;
  unresolved_count: number;
  uncertain_count?: number;
}

export interface Capabilities {
  /** Public account incarnation, required for mutating refresh requests. */
  account_generation?: number;
  /** Public accounts are enabled only by this deployment's backend. */
  public_account?: boolean;
  marketapp_login_test?: boolean;
  marketapp_analytics_refresh?: boolean;
  /** Telegram-only, bounded automatic comparison checks using the account API key. */
  startup_comparison_refresh?: boolean;
  owned_price_refresh?: boolean;
  /** Telegram personal-gift refresh can use a retained wallet without a current wallet approval. */
  personal_gift_refresh?: boolean;
  /** Telegram-only, account-authorized one-gift TON price/status checks. */
  owned_price_refresh_single?: boolean;
  owned_status_refresh?: boolean;
  hosting?: 'local' | 'serverless';
  supported_jobs?: JobKind[];
  ownership_note?: string;
  network_enabled: boolean;
  marketapp_configured: boolean;
  ton_configured: boolean;
  wallet_configured: boolean;
  csrf_token: string;
  marketapp_limits?: {
    max_attempts: number;
    rolling_24h_attempts: number;
    run_seconds: number;
    requests_per_second: number;
    used_24h: number;
    remaining_24h: number;
    resets_at?: string | null;
    available_at?: string | null;
    provider_allowance_blocked?: boolean;
  };
}

export type DataRecord = Record<string, unknown>;

export interface SavedAnalyticsCoverage {
  observed_days: number; missing_days: number; partial_days: number;
  periods: { period_start: string; period_end: string; captured_at: string }[];
}

export interface MarketappTopItem {
  item_key: string;
  name: string;
  item_url: string;
  rentals: number;
  rented_days: string;
  volume: string;
  price_per_day: string | null;
  captured_at?: string;
  coverage?: SavedAnalyticsCoverage;
}
export interface MarketappTopItems {
  status: 'available' | 'missing';
  scope: 'marketapp_top_items' | 'saved_non_overlapping_reports';
  incomplete?: boolean;
  items: MarketappTopItem[];
}

export interface MarketappCollection {
  collection_key: string;
  name: string;
  rentals: number;
  volume: string;
  price_per_day: string | null;
  captured_at?: string;
  coverage?: SavedAnalyticsCoverage;
}
export interface MarketappCollections {
  status: 'available' | 'missing';
  scope: 'marketapp_by_collection' | 'saved_non_overlapping_reports';
  incomplete?: boolean;
  items: MarketappCollection[];
}

export interface PersonalRentalAnalytics {
  version: 1;
  source: 'marketapp_personal_rent_page';
  source_url: string;
  wallet: string;
  captured_at: string;
  period_start: string;
  period_end: string;
  timezone: 'UTC';
  currency: 'GRAM';
  volume_basis: 'gross_before_fees';
  summary: {
    rent_volume: string;
    rentals: number;
    new_rentals: number;
    extensions: number;
    items: number | null;
    price_per_day: string | null;
    average_duration: string | null;
    extension_percent: string | null;
    spent_on_rent: string | null;
    spending_rentals: number | null;
  };
  daily: { date: string; rent_volume: string; new_rentals: number; extensions: number; rentals: number; partial?: boolean }[];
  fingerprint: string;
  top_items?: MarketappTopItems;
  by_collection?: MarketappCollections;
}

/** Deduplicated saved daily evidence; this does not claim lifetime provider coverage. */
export interface PersonalRentalAnalyticsAllTime extends Omit<PersonalRentalAnalytics, 'source_url' | 'daily'> {
  report_kind: 'all_time';
  source_url: null;
  daily: (PersonalRentalAnalytics['daily'][number] & { captured_at: string; partial: boolean })[];
  coverage: { observed_days: number; missing_days: number; partial_days: number };
}
export type PersonalRentalAnalyticsReport = PersonalRentalAnalytics | PersonalRentalAnalyticsAllTime;

export interface Dashboard {
  /** Dated saved projection; a full read must follow before acknowledging updates. */
  startup_preview?: { generated_at: string };
  /** Revision of the committed snapshot and time-dependent calculation window. */
  update_token?: string;
  wallet: string | null;
  generated_at: string;
  summary: DashboardSummary;
  gifts: Gift[];
  activity: DataRecord[];
  coverage: DataRecord;
  runs: DataRecord[] | DataRecord;
  review: DataRecord[] | DataRecord;
  capabilities: Capabilities;
  pricing?: DataRecord;
  /** Saved per-source update coverage; independent of dashboard generation time. */
  data_freshness?: ActivityComparisonEvidence;
  personal_analytics?: PersonalRentalAnalytics | null;
  personal_analytics_snapshots?: PersonalRentalAnalytics[];
  personal_analytics_all_time?: PersonalRentalAnalyticsAllTime | null;
}

export interface Job {
  id: number;
  account_generation?: number;
  kind: JobKind;
  state: JobState;
  created_at: string;
  updated_at: string;
  reason: string | null;
  run_id: number | null;
  progress: DataRecord & { sync?: {
    phase: 'preparing' | 'listings' | 'rentals' | 'discovering' | 'verifying' | 'complete';
    completed: number;
    total: number | null;
    unit: 'collections' | 'gifts' | 'checks';
    current_collection: string | null;
    processed_items: number;
  }; history_refresh?: {
    incremental_streams: number;
    full_streams: number;
    overlap_seconds: number;
    full_scan_interval_seconds: number;
  }; listing_refresh?: {
    planned_streams: number;
    reused_streams: number;
    provider_streams: number;
  }; market_cache?: {
    reused_streams: number;
    total_streams: number;
    ttl_seconds: number;
    oldest_observed_at: string | null;
    oldest_age_seconds?: number | null;
  }; efficiency?: {
    page_size: number;
    recommended_page_size: number;
    scheduling: 'round_robin' | 'sequential';
    collections_started: number;
    collections_total: number | null;
  } };
  stop_requested: boolean;
  resume_supported?: boolean;
  resume_blocked_reason?: 'missing_bounded_timeframe' | null;
  collection_window?: {
    timeframe: PricingTimeframe;
    date_from?: string | null;
    date_to?: string | null;
    window_from?: string | null;
    window_to?: string | null;
    timezone?: string;
  } | null;
}

export interface JobStartOptions { forceRefresh?: boolean }

export interface ComparisonStartupResult {
  state: 'started' | 'fresh' | 'busy' | 'limited' | 'unavailable';
  job?: Job;
  retry_at?: string;
  reason?: 'active_job' | 'provider_wait' | 'cooldown' | 'daily_limit' | 'provider_limit'
    | 'key_missing' | 'portfolio_missing' | 'wallet_missing' | 'stopped' | 'failed';
}

export interface MarketappSettingsStatus {
  configured: boolean;
  source: 'environment' | 'secure_store' | 'session' | 'none' | 'serverless_private' | 'encrypted_backend';
  persistent_storage_available: boolean;
  network_enabled: boolean;
  can_manage: boolean;
  restart_required: boolean;
  reason?: 'external_configuration' | 'active_job' | 'secure_store_unavailable';
}

export interface MarketappSettingsAdapter {
  get(signal?: AbortSignal): Promise<MarketappSettingsStatus>;
  save(apiKey: string, persist: boolean, csrf: string): Promise<MarketappSettingsStatus>;
  remove(csrf: string): Promise<MarketappSettingsStatus>;
}

export interface MarketappLoginChallenge {
  attempt_id: string;
  challenge: string;
  manifest_url: string;
  expires_at: string;
  wallet: string;
  domain: 'marketapp.org';
}
export interface MarketappLoginAccount {
  address: string;
  chain: string;
  walletStateInit?: string;
  publicKey?: string;
}
export interface MarketappLoginProof {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
}
export type MarketappAnalyticsPeriod = 30 | 365;
export interface MarketappAnalyticsRefreshChallenge extends MarketappLoginChallenge {
  period_days: MarketappAnalyticsPeriod;
  session_envelope: string;
}
export interface MarketappWalletDevice {
  platform: string;
  appName: string;
  appVersion: string;
  maxProtocolVersion: number;
  features: unknown[];
}
export interface MarketappAnalyticsRefreshResult {
  attempt_id: string;
  authenticated: true;
  analytics_refreshed: true;
  snapshot: PersonalRentalAnalytics;
}
export interface MarketappAnalyticsRefreshStatus {
  attempt: {
    attempt_id: string;
    state: 'awaiting_approval' | 'updating' | 'saved' | 'failed' | 'expired' | 'cancelled';
    period_days: MarketappAnalyticsPeriod;
    updated_at: string;
    error_code?: string;
  } | null;
  session?: MarketappAnalyticsRememberedSession;
}
export interface MarketappAnalyticsRememberedSession {
  remembered: boolean;
  expires_at: string | null;
}
export interface MarketappAnalyticsStartupResult {
  state: 'saved' | 'fresh' | 'unavailable' | 'busy' | 'limited';
  period_days: MarketappAnalyticsPeriod;
  captured_at?: string;
  retry_at?: string;
  reason?: 'no_login' | 'wallet_missing' | 'refresh_failed' | 'active_refresh' | 'website_busy' | 'cooldown' | 'request_limit';
}
export interface MarketappAnalyticsRefreshAdapter {
  getStatus?(signal?: AbortSignal): Promise<MarketappAnalyticsRefreshStatus>;
  /** Silent, bounded refresh using an already remembered login; never opens a wallet. */
  refreshStartup?(periodDays: MarketappAnalyticsPeriod, signal?: AbortSignal): Promise<MarketappAnalyticsStartupResult>;
  start(periodDays: MarketappAnalyticsPeriod, signal?: AbortSignal, rememberLogin?: boolean): Promise<MarketappAnalyticsRefreshChallenge>;
  refreshSaved?(periodDays: MarketappAnalyticsPeriod, signal?: AbortSignal): Promise<MarketappAnalyticsRefreshResult>;
  disconnectSession?(signal?: AbortSignal): Promise<{ disconnected: true }>;
  finish(challenge: MarketappAnalyticsRefreshChallenge, account: MarketappLoginAccount & { walletStateInit: string; publicKey: string }, proof: MarketappLoginProof, device: MarketappWalletDevice, signal?: AbortSignal): Promise<MarketappAnalyticsRefreshResult>;
  cancel(attemptId: string, signal?: AbortSignal): Promise<void>;
}
export interface MarketappLoginTestResult {
  attempt_id: string;
  compatible: boolean;
  checks: { wallet_matches: boolean; mainnet: boolean; domain_matches: boolean; challenge_matches: boolean; timestamp_fresh: boolean; signature_present: boolean };
  signature_verified: false;
  authenticated: false;
  analytics_refreshed: false;
}
export interface MarketappLoginTestAdapter {
  start(signal?: AbortSignal): Promise<MarketappLoginChallenge>;
  finish(attemptId: string, account: MarketappLoginAccount, proof: MarketappLoginProof, signal?: AbortSignal): Promise<MarketappLoginTestResult>;
  cancel(attemptId: string, signal?: AbortSignal): Promise<void>;
}

export interface DashboardAdapter {
  readonly mode?: 'local' | 'serverless';
  /** Telegram-only storage monitoring and resumable lossless maintenance. */
  readonly storageMaintenance?: import('./storageMonitoring.ts').StorageMaintenanceAdapter;
  readonly publicAccount?: import('../serverless/publicAccount.ts').PublicAccountAdapter;
  readonly marketappSettings?: MarketappSettingsAdapter;
  readonly marketappLoginTest?: MarketappLoginTestAdapter;
  readonly marketappAnalyticsRefresh?: MarketappAnalyticsRefreshAdapter;
  /** One silent startup mutation; started jobs use the smaller automatic batch budget. */
  startupComparisonRefresh?(selection: PricingSelection, signal?: AbortSignal): Promise<ComparisonStartupResult>;
  readonly personalAnalytics?: {
    importSnapshot(raw: string, csrf: string): Promise<PersonalRentalAnalytics>;
  };
  readonly ownedPriceTransport?: import('./ownedPriceRefresh.ts').OwnedPriceTransport;
  interrupt?(): void;
  subscribe?(listener: (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => void): () => void;
  exportCsv?(dashboard: Dashboard, selection: PricingSelection): void;
  getDashboard(selection: PricingSelection, signal?: AbortSignal): Promise<Dashboard>;
  getStartupDashboard?(selection: PricingSelection, signal?: AbortSignal): Promise<Dashboard>;
  getUpdateToken?(signal?: AbortSignal): Promise<string>;
  getJobs(signal?: AbortSignal): Promise<Job[]>;
  startJob(kind: JobKind, csrf: string, selection?: PricingSelection, options?: JobStartOptions): Promise<Job>;
  resumeJob(id: number, csrf: string, accountGeneration?: number): Promise<Job>;
  stopJob(id: number, csrf: string, accountGeneration?: number): Promise<Job>;
  exportUrl(selection: PricingSelection): string;
}
