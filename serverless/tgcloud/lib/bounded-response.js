// Telegram's SDK exposes an async byte stream. Never use .text(): its allocation
// happens before an application can enforce a response limit.
export class BoundedResponseError extends Error {
  constructor(code, response = null, body = '', truncated = false) {
    super(code); this.code = code; this.response = response; this.body = body; this.truncated = truncated;
  }
}

export function utf8Size(text) {
  let size = 0;
  for (const char of text) {const cp = char.codePointAt(0); size += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;}
  return size;
}

function decode(bytes, partial = false) {
  const output = []; let block = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let value = first, count = 0, minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {value = first & 31; count = 1; minimum = 128;}
    else if (first >= 0xe0 && first <= 0xef) {value = first & 15; count = 2; minimum = 2048;}
    else if (first >= 0xf0 && first <= 0xf4) {value = first & 7; count = 3; minimum = 65536;}
    else if (first > 127) throw new BoundedResponseError('invalid_response');
    if (i + count > bytes.length) {if (partial) break; throw new BoundedResponseError('invalid_response');}
    for (let j = 0; j < count; j++) {const next = bytes[i++]; if ((next & 192) !== 128) throw new BoundedResponseError('invalid_response'); value = value << 6 | next & 63;}
    if (value < minimum || value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) throw new BoundedResponseError('invalid_response');
    block += String.fromCodePoint(value);
    if (block.length >= 4096) {output.push(block); block = '';}
  }
  if (block) output.push(block);
  return output.join('');
}

function quietCancel(body, iterator) {
  // SDK cancellation is best effort. Never await an iterator.return() behind a
  // stalled next(): a provider that ignores abort must not hold our deadline.
  try {
    const result = iterator?.return ? iterator.return() : body?.cancel?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {}
}

export async function fetchBoundedResponse(request, url, options, {maxBytes, timeoutMs, clock = () => Date.now(), deadlineAt = Date.now() + timeoutMs}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new BoundedResponseError('invalid_response');
  if (!Number.isSafeInteger(deadlineAt) || typeof clock !== 'function') throw new BoundedResponseError('invalid_response');
  // Telegram currently has no timers or AbortController and ignores timeout.
  // Check trusted time at every await boundary there; late evidence cannot
  // advance a cursor. Timer-capable hosts also release a stalled await promptly.
  // A pending Telegram SDK header/body await itself cannot be cancelled.
  const hasTimers = typeof setTimeout === 'function' && typeof clearTimeout === 'function';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let response = null, iterator = null, timer = null, stopped = false, total = 0;
  const chunks = [];
  const body = partial => {
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    try {return decode(bytes, partial);} catch {return '';}
  };
  const fail = (code, truncated = false) => {throw new BoundedResponseError(code, response, body(true), truncated);};
  const withinDeadline = async () => {
    const at = await clock();
    if (!Number.isSafeInteger(at)) fail('invalid_response');
    if (stopped || at >= deadlineAt) fail('request_timeout', total > 0);
    return at;
  };
  const timeout = hasTimers ? new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true; try {controller?.abort();} catch {}
      quietCancel(response?.body, iterator);
      reject(new BoundedResponseError('request_timeout', response, body(true), total > 0));
    }, timeoutMs);
  }) : null;
  const work = (async () => {
    try {
      const at = await withinDeadline();
      response = await request(url, {...options, timeout: Math.min(timeoutMs, deadlineAt - at), ...(controller ? {signal: controller.signal} : {})});
      if (stopped) {quietCancel(response?.body, null); fail('request_timeout', total > 0);}
      await withinDeadline();
      const length = response?.headers?.get?.('Content-Length');
      if (length !== null && length !== undefined && !/^\d+$/.test(length)) fail('invalid_response');
      if (length !== null && length !== undefined && Number(length) > maxBytes) fail('response_too_large', true);
      if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail('invalid_response');
      iterator = response.body[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (stopped) fail('request_timeout', total > 0);
        await withinDeadline();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) fail('invalid_response');
        const chunk = next.value;
        if (chunk.length > maxBytes - total) {
          // Copy only a bounded prefix; do not retain the oversized host chunk.
          chunks.push(chunk.slice(0, maxBytes - total)); total = maxBytes;
          fail('response_too_large', true);
        }
        // Copy SDK chunks because hosts may reuse their buffers across reads.
        chunks.push(chunk.slice()); total += chunk.length;
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
      return {response, body: decode(bytes), truncated: false};
    } catch (error) {
      if (error instanceof BoundedResponseError) {error.response ??= response; throw error;}
      if (error?.code === 'PUBLIC_PROVIDER_WAIT') throw error;
      fail(stopped ? 'request_timeout' : 'network_error', total > 0);
    }
  })();
  try {return await (timeout ? Promise.race([work, timeout]) : work);}
  finally {if (timer !== null) clearTimeout(timer); stopped = true; quietCancel(response?.body, iterator);}
}

function prefix(text, length) {
  if (length > 0 && length < text.length && /[\uD800-\uDBFF]/.test(text[length - 1]) && /[\uDC00-\uDFFF]/.test(text[length])) length--;
  return text.slice(0, length);
}

export function boundedRawEvidence(raw, maxBytes) {
  const encoded = JSON.stringify(raw);
  if (utf8Size(encoded) <= maxBytes) return encoded;
  const metadata = {...raw, body: '', truncated: true};
  if (utf8Size(JSON.stringify(metadata)) > maxBytes) {
    // A very large opaque cursor or address list must not bypass the same bound.
    const minimal = {status: raw.status, endpoint: raw.endpoint, provider: raw.provider, failure: raw.failure,
      observed_at: raw.observed_at, body: null, truncated: true, evidence_metadata_omitted: true};
    const compact = JSON.stringify(minimal);
    if (utf8Size(compact) <= maxBytes) return compact;
    if (maxBytes >= 18) return JSON.stringify({truncated: true});
    return maxBytes >= 2 ? '{}' : '0';
  }
  const text = typeof raw.body === 'string' ? raw.body : '';
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Size(JSON.stringify({...metadata, body: prefix(text, middle)})) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify({...metadata, body: prefix(text, low)});
}

// Optional transport encoding only: persisted dashboards retain their ordinary
// JSON representation. Tags distinguish arrays, objects and dictionary values.
export const DASHBOARD_WIRE_FORMAT = 'gift-dashboard-v1';
export const DASHBOARD_WIRE_LIMITS = Object.freeze({wire_bytes:8388608,decoded_bytes:25165824,nodes:500000,depth:64,
  shapes:4096,shape_keys:65536,object_keys:512,key_length:1024,strings:16384,string_length:2097152,array_items:100000});
const omitted=value=>['undefined','function','symbol'].includes(typeof value);
const own=(object,key,value)=>Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});
const fail=()=>{throw new Error('Dashboard exceeds compact transport limits');};

// Exact JSON-string UTF-8 cost, including escapes and lone surrogates. Avoid a
// second large serialized copy just to measure string and expansion budgets.
function stringBytes(text) {
  let bytes=2;
  for(let i=0;i<text.length;i++) {
    const c=text.charCodeAt(i);
    if(c===34||c===92)bytes+=2;
    else if(c<32)bytes+=[8,9,10,12,13].includes(c)?2:6;
    else if(c<128)bytes++;
    else if(c<2048)bytes+=2;
    else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
    else bytes+=c>=0xd800&&c<=0xdfff?6:3;
  }
  return bytes;
}

export function encodeDashboardWire(value) {
  const limits=DASHBOARD_WIRE_LIMITS,shapes=[],shapeIds=new Map(),counts=new Map(),ancestors=new Set();
  let nodes=0,decodedBytes=0,keyCount=0;
  const add=bytes=>{decodedBytes+=bytes;if(decodedBytes>limits.decoded_bytes)fail();};
  function normalize(item,depth) {
    if(++nodes>limits.nodes||depth>limits.depth)fail();
    if(item===null||omitted(item)){add(4);return null;}
    if(typeof item==='boolean'){add(item?4:5);return item;}
    if(typeof item==='number'){const result=Number.isFinite(item)?item===0?0:item:null;add(result===null?4:String(result).length);return result;}
    if(typeof item==='string') {
      if(item.length>limits.string_length)fail();const bytes=stringBytes(item);add(bytes);
      const saved=counts.get(item);if(saved)saved.count++;else counts.set(item,{count:1,bytes});return item;
    }
    if(typeof item!=='object'||ancestors.has(item))fail();
    ancestors.add(item);let result;
    if(Array.isArray(item)) {
      if(item.length>limits.array_items)fail();add(2+Math.max(0,item.length-1));result=[];
      for(let i=0;i<item.length;i++)result.push(normalize(item[i],depth+1));
    } else {
      if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)fail();
      const keys=Object.keys(item).filter(key=>!omitted(item[key]));if(keys.length>limits.object_keys)fail();
      for(const key of keys)if(key.length>limits.key_length)fail();
      const signature=JSON.stringify(keys);
      if(!shapeIds.has(signature)) {
        keyCount+=keys.length;if(shapes.length>=limits.shapes||keyCount>limits.shape_keys)fail();
        shapeIds.set(signature,shapes.length);shapes.push(keys);
      }
      add(2+Math.max(0,keys.length-1));result={};
      for(const key of keys){add(stringBytes(key)+1);own(result,key,normalize(item[key],depth+1));}
    }
    ancestors.delete(item);return result;
  }
  if(omitted(value))fail();
  const normalized=normalize(value,0),strings=[],stringIds=new Map();
  for(const [text,{count,bytes}] of counts) {
    // A conservative allowance for tag/index syntax ensures interned strings
    // save space even with five-digit dictionary references.
    if(strings.length<limits.strings&&count>1&&bytes*(count-1)>count*10+2) {
      stringIds.set(text,strings.length);strings.push(text);
    }
  }
  function encode(item) {
    if(typeof item==='string')return stringIds.has(item)?[2,stringIds.get(item)]:item;
    if(item===null||typeof item!=='object')return item;
    if(Array.isArray(item)){const row=[0];for(const child of item)row.push(encode(child));return row;}
    const keys=Object.keys(item),row=[1,shapeIds.get(JSON.stringify(keys))];for(const key of keys)row.push(encode(item[key]));return row;
  }
  const wire={encoding:DASHBOARD_WIRE_FORMAT,shapes,strings,data:encode(normalized)};
  // The transport already serializes this document. This final measurement
  // bounds format overhead for tiny, heterogeneous objects as well.
  let bytes=0;for(const character of JSON.stringify(wire)){const code=character.codePointAt(0);bytes+=code<128?1:code<2048?2:code<65536?3:4;if(bytes>limits.wire_bytes)fail();}
  return wire;
}

const READ_OPERATIONS=new Set(['getDashboard','getDashboardRevision','getJobs']);
const BUSY_CODES=new Set(['SQLITE_BUSY','SQLITE_BUSY_RECOVERY','SQLITE_BUSY_SNAPSHOT','SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','SQLITE_LOCKED_VTAB']);
const LIMIT_CODES=new Set(['SQLITE_TOOBIG','SQLITE_NOMEM','SQLITE_IOERR_NOMEM','RESOURCE_EXHAUSTED']);
const TIMEOUT_CODES=new Set(['DEADLINE_EXCEEDED','ETIMEDOUT','QUERY_TIMEOUT']);
const BUSY_MESSAGES=new Set(['database is locked','database table is locked','database is busy']);
const LIMIT_MESSAGES=new Set(['string or blob too big','out of memory']);
const TIMEOUT_MESSAGES=new Set(['deadline exceeded','context deadline exceeded','database query timed out','query timed out','query timeout']);

// The SDK documents endpoint envelopes, but no stable database-error shape.
// Recognize only explicit standard codes or complete, known error phrases.
// In particular, SQLITE_INTERRUPT is not proof of a deadline. Unknown errors
// remain diagnostic READ_FAILED; no SQL, private values, causes or stack leave
// the runtime. Hard host termination cannot be classified by this catch path.
function readFailureCode(error) {
  try {
    for(const code of [error?.code,error?.type]) {
      if(typeof code!=='string')continue;
      if(BUSY_CODES.has(code))return 'READ_BUSY';
      if(LIMIT_CODES.has(code))return 'READ_LIMIT';
      if(TIMEOUT_CODES.has(code))return 'READ_TIMEOUT';
    }
    const message=error?.message;
    if(typeof message==='string'&&message.length<=120) {
      const normalized=message.trim().toLowerCase();
      if(BUSY_MESSAGES.has(normalized))return 'READ_BUSY';
      if(LIMIT_MESSAGES.has(normalized))return 'READ_LIMIT';
      if(TIMEOUT_MESSAGES.has(normalized))return 'READ_TIMEOUT';
    }
  } catch {} // Even unusual error objects must not break the safe envelope.
  return 'READ_FAILED';
}

// Call after the runtime's existing auth, account and storage error handling.
// Never apply read retry semantics to an operation that may change app data.
export function cloudReadErrorResponse(operation,error) {
  return READ_OPERATIONS.has(operation)?{error:{code:readFailureCode(error)}}:null;
}
