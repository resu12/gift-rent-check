import {invokePublicWallet} from '../lib/runtime.js';
export default async function(input,ctx) {return invokePublicWallet('finishWalletVerification',input,ctx);}
