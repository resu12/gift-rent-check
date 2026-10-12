import {invokeStorage} from '../lib/runtime.js';
export default async function(input,ctx) {return invokeStorage('status',input,ctx);}
