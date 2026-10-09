import {invokeCloud} from '../lib/runtime.js';
export default async function(input, ctx) {return invokeCloud('stepJob', input, ctx);}
