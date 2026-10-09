import {invokeOwnedPrice} from '../lib/runtime.js';
export default async function(input, ctx) {return invokeOwnedPrice('getStatus', input, ctx);}
