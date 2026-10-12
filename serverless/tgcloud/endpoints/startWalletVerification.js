import {invokePublicWallet} from '../lib/runtime.js';
export default async function(input,ctx) {return invokePublicWallet('startWalletVerification',input,ctx);}
