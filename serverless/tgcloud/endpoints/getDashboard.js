import {invokeCloud} from '../lib/runtime.js';
import {DASHBOARD_WIRE_FORMAT,encodeDashboardWire} from '../lib/bounded-response.js';
export default async function(input, ctx) {
  const compact=input&&typeof input==='object'&&!Array.isArray(input)&&input.response_format===DASHBOARD_WIRE_FORMAT;
  let selection=input;
  if(compact){selection={...input};delete selection.response_format;}
  const result=await invokeCloud('getDashboard',selection,ctx);
  if(!compact||result?.error)return result;
  // Older clients keep the original JSON contract. Unexpected legacy shapes
  // can still use it rather than turning optional compaction into a failure.
  try{return encodeDashboardWire(result);}catch{return result;}
}
