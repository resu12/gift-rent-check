// Safe source-control example. scripts/configure-serverless.py copies this to
// the ignored tgcloud/lib/public-release-config.js only when it does not exist.
// Review deployment capacity, provider use and policy pages before enabling.
export const publicReleaseConfig = Object.freeze({
  enabled: false,
  preservePrivateOwner: true,
  invitedUserIds: [],
  openRegistration: false,
  maxAccounts: 5,
  origin: '',
  globalMarketDailyAttempts: 500,
  globalTonDailyAttempts: 1000,
  perUserMarketDailyAttempts: 500,
  perUserTonDailyAttempts: 1000,
  maxWalletGifts: 250,
  maxDiscoveryCandidates: 1000,
  privacyPolicyUrl: '',
  termsUrl: '',
  storageEncryptionConfirmed: false,
  providerUseApproved: false,
  experimentalPersonalAnalytics: false,
  // Shared website guard remains 100/day, separate from Marketapp API keys.
  websiteDailyAttempts: 20,
  // Fill with measured/verified evidence before opening registration.
  releaseReadiness: null,
});
