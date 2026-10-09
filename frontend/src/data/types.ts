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
}

export interface Job {
  id: number;
  kind: JobKind;
  state: JobState;
  created_at: string;
  updated_at: string;
  reason: string | null;
  run_id: number | null;
  progress: DataRecord & { history_refresh?: {
    incremental_streams: number;
    full_streams: number;
    overlap_seconds: number;
    full_scan_interval_seconds: number;
  } };
  stop_requested: boolean;
  collection_window?: {
    timeframe: PricingTimeframe;
    date_from?: string | null;
    date_to?: string | null;
    window_from?: string | null;
    window_to?: string | null;
    timezone?: string;
  } | null;
}

export interface DashboardAdapter {
  readonly mode?: 'local' | 'serverless';
  readonly ownedPriceTransport?: import('./ownedPriceRefresh.ts').OwnedPriceTransport;
  interrupt?(): void;
  subscribe?(listener: (event: { job?: Job; error?: string; savedDataChanged?: boolean }) => void): () => void;
  exportCsv?(dashboard: Dashboard, selection: PricingSelection): void;
  getDashboard(selection: PricingSelection, signal?: AbortSignal): Promise<Dashboard>;
  getJobs(signal?: AbortSignal): Promise<Job[]>;
  startJob(kind: JobKind, csrf: string, selection?: PricingSelection): Promise<Job>;
  resumeJob(id: number, csrf: string): Promise<Job>;
  stopJob(id: number, csrf: string): Promise<Job>;
  exportUrl(selection: PricingSelection): string;
}
