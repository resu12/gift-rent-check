import {invokePublicAccount} from '../lib/runtime.js';
export default async function(input,ctx) {return invokePublicAccount('getPublicAccount',input,ctx);}
