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
  model?: string | null;
  backdrop?: string | null;
  traits_source?: string | null;
  traits_observed_at?: string | null;
  trait_uncertainties?: string[];
  pricing?: GiftPricing | null;
  rental_history?: GiftRentalHistory;
  rental_until: string | number | null;
  rental_until_unix_seconds?: number | string | null;
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
  marketapp_login_test?: boolean;
  marketapp_analytics_refresh?: boolean;
  owned_price_refresh?: boolean;
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
  };
}

export type DataRecord = Record<string, unknown>;

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
  daily: { date: string; rent_volume: string; new_rentals: number; extensions: number; rentals: number }[];
  fingerprint: string;
}

export interface Dashboard {
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
  personal_analytics?: PersonalRentalAnalytics | null;
  personal_analytics_snapshots?: PersonalRentalAnalytics[];
}

export interface Job {
  id: number;
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

export interface MarketappSettingsStatus {
  configured: boolean;
  source: 'environment' | 'secure_store' | 'session' | 'none';
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
}
export interface MarketappAnalyticsRefreshAdapter {
  getStatus?(signal?: AbortSignal): Promise<MarketappAnalyticsRefreshStatus>;
  start(periodDays: MarketappAnalyticsPeriod, signal?: AbortSignal): Promise<MarketappAnalyticsRefreshChallenge>;
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
  readonly marketappSettings?: MarketappSettingsAdapter;
  readonly marketappLoginTest?: MarketappLoginTestAdapter;
  readonly marketappAnalyticsRefresh?: MarketappAnalyticsRefreshAdapter;
  readonly personalAnalytics?: {
    importSnapshot(raw: string, csrf: string): Promise<PersonalRentalAnalytics>;
  };
  readonly ownedPriceTransport?: import('./ownedPriceRefresh.ts').OwnedPriceTransport;
  interrupt?(): void;
  subscribe?(listener: (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => void): () => void;
  exportCsv?(dashboard: Dashboard, selection: PricingSelection): void;
  getDashboard(selection: PricingSelection, signal?: AbortSignal): Promise<Dashboard>;
  getJobs(signal?: AbortSignal): Promise<Job[]>;
  startJob(kind: JobKind, csrf: string, selection?: PricingSelection, options?: JobStartOptions): Promise<Job>;
  resumeJob(id: number, csrf: string): Promise<Job>;
  stopJob(id: number, csrf: string): Promise<Job>;
  exportUrl(selection: PricingSelection): string;
}
