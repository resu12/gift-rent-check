import {publicProviderForRequest} from './public-provider-budget.js';

// The private owner retains the private event store and credentials. Only its
// provider GETs join the same CAS ledger used by invited public accounts.
export function createInviteProviderFetch({fetch, budget, repository, userId, credentialFingerprint = null, credentialCheck = null}) {
  let counter = 0;
  return async (url, options = {}) => {
    const provider = publicProviderForRequest(url, options);
    if(provider==='marketapp'&&credentialCheck)await credentialCheck();
    const {revision} = await repository.read();
    await budget.reserve(provider, userId, provider === 'marketapp' ? credentialFingerprint : null, `private:${revision}:${++counter}`);
    if(provider==='marketapp'&&credentialCheck)await credentialCheck();
    const response = await fetch(url, {...options, redirect: 'error'});
    await budget.throttle(provider, response);
    return response;
  };
}
