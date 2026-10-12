export const DASHBOARD_WIRE_FORMAT = 'gift-dashboard-v1';
export const DASHBOARD_WIRE_LIMITS = Object.freeze({wire_bytes:8388608,decoded_bytes:25165824,nodes:500000,depth:64,
  shapes:4096,shape_keys:65536,object_keys:512,key_length:1024,strings:16384,string_length:2097152,array_items:100000});

function invalid(): never { throw new Error('Invalid compact dashboard response'); }
function jsonStringBytes(text: string): number {
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
const plain=(value:unknown): value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&[Object.prototype,null].includes(Object.getPrototypeOf(value) as object|null);

// Decode before the ordinary dashboard schema parser. This only reconstructs
// JSON data; schema validation and all authority checks remain unchanged.
export function decodeDashboardWire(value: unknown): unknown {
  const limits=DASHBOARD_WIRE_LIMITS;
  if(!plain(value)||Object.keys(value).length!==4||!Object.hasOwn(value,'encoding')||value.encoding!==DASHBOARD_WIRE_FORMAT
    ||!Object.hasOwn(value,'shapes')||!Object.hasOwn(value,'strings')||!Object.hasOwn(value,'data'))invalid();
  if(!Array.isArray(value.shapes)||value.shapes.length>limits.shapes||!Array.isArray(value.strings)||value.strings.length>limits.strings)invalid();
  let wireBytes=JSON.stringify({encoding:DASHBOARD_WIRE_FORMAT,shapes:[],strings:[],data:null}).length-8,decodedBytes=0,nodes=0,keyCount=0;
  const addWire=(bytes:number)=>{wireBytes+=bytes;if(wireBytes>limits.wire_bytes)invalid();};
  const addDecoded=(bytes:number)=>{decodedBytes+=bytes;if(decodedBytes>limits.decoded_bytes)invalid();};
  const shapes:string[][]=[],shapeBytes:number[]=[],strings:string[]=[],stringBytes:number[]=[];
  addWire(2+Math.max(0,value.shapes.length-1));
  for(const candidate of value.shapes) {
    if(!Array.isArray(candidate)||candidate.length>limits.object_keys)invalid();
    keyCount+=candidate.length;if(keyCount>limits.shape_keys)invalid();
    const keys:string[]=[],seen=new Set<string>();let bytes=2+Math.max(0,candidate.length-1);addWire(bytes);
    for(const key of candidate) {
      if(typeof key!=='string'||key.length>limits.key_length||seen.has(key))invalid();
      seen.add(key);keys.push(key);const size=jsonStringBytes(key);addWire(size);bytes+=size+1;
    }
    shapes.push(keys);shapeBytes.push(bytes);
  }
  addWire(2+Math.max(0,value.strings.length-1));
  for(const text of value.strings) {
    if(typeof text!=='string'||text.length>limits.string_length)invalid();
    const bytes=jsonStringBytes(text);addWire(bytes);strings.push(text);stringBytes.push(bytes);
  }
  const ancestors=new Set<unknown[]>();
  function decode(node:unknown,depth:number):unknown {
    if(++nodes>limits.nodes||depth>limits.depth)invalid();
    if(node===null||typeof node==='boolean'||typeof node==='number'||typeof node==='string') {
      if(typeof node==='number'&&!Number.isFinite(node)||typeof node==='string'&&node.length>limits.string_length)invalid();
      const bytes=node===null?4:typeof node==='string'?jsonStringBytes(node):typeof node==='boolean'?node?4:5:String(node).length;
      addWire(bytes);addDecoded(bytes);return node;
    }
    if(!Array.isArray(node)||!node.length||node.length>limits.array_items+2||ancestors.has(node))invalid();
    ancestors.add(node);addWire(2+Math.max(0,node.length-1));
    const tag=node[0];if(tag!==0&&tag!==1&&tag!==2)invalid();addWire(1);
    let result:unknown;
    if(tag===0) {
      const count=node.length-1;if(count>limits.array_items)invalid();addDecoded(2+Math.max(0,count-1));
      const rows:unknown[]=[];for(let i=1;i<node.length;i++)rows.push(decode(node[i],depth+1));result=rows;
    } else {
      const index=node[1];if(!Number.isSafeInteger(index)||index<0)invalid();addWire(String(index).length);
      if(tag===2) {
        if(node.length!==2||index>=strings.length)invalid();addDecoded(stringBytes[index]);result=strings[index];
      } else {
        if(index>=shapes.length||node.length!==shapes[index].length+2)invalid();addDecoded(shapeBytes[index]);
        const record:Record<string,unknown>={};
        // Defining own data properties safely preserves even __proto__ and
        // constructor keys without invoking inherited prototype setters.
        for(let i=0;i<shapes[index].length;i++)Object.defineProperty(record,shapes[index][i],{
          value:decode(node[i+2],depth+1),enumerable:true,writable:true,configurable:true});
        result=record;
      }
    }
    ancestors.delete(node);return result;
  }
  return decode(value.data,0);
}
