// Offline operator report. No credentials, account IDs, provider calls or writes.
import {publicRegistrationReadiness} from '../tgcloud/lib/storage-policy.js';
import {validatePublicReleaseConfig} from '../tgcloud/lib/public-runtime.js';
try {
  const {publicReleaseConfig:config}=await import('../tgcloud/lib/public-release-config.js');
  validatePublicReleaseConfig({...config,openRegistration:false});
  const readiness=publicRegistrationReadiness(config,{requireRecent:true});
  console.log(JSON.stringify({registration:config.openRegistration?'open':'invitation_only',maxAccounts:config.maxAccounts,
    marketappLogin:config.experimentalPersonalAnalytics,websiteDailyAttempts:config.websiteDailyAttempts??20,
    ...readiness,providerQuotaVerified:false},null,2));
  if(config.openRegistration&&!readiness.ready)process.exitCode=1;
} catch {console.error('Release configuration could not be verified. No private values were logged.');process.exitCode=1;}
