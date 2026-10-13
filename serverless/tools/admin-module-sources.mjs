import {posix} from 'node:path';

// A /run request is its own module space. Upload only the administrative
// endpoint's dependencies; copying an already full app exceeds the host limit.
// Keep owner authorization sourced from the deployed configuration.
export function adminModuleSources(canonical,overrides,endpointName,endpointSource) {
  if(!/^endpoints\/[A-Za-z0-9_-]+$/.test(endpointName)||typeof endpointSource!=='string')throw Error('Invalid administration endpoint');
  const moduleName=/^(?:lib|endpoints)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
  const available=Object.fromEntries(Object.entries(canonical??{}).filter(([name])=>moduleName.test(name)));
  for(const [name,source] of Object.entries(overrides??{})) {
    if(!/^lib\/[A-Za-z0-9_-]+$/.test(name)||['lib/private-config','lib/private-refresh-key','lib/public-release-config'].includes(name)||typeof source!=='string')throw Error('Invalid administration library');
    available[name]=source;
  }
  available[endpointName]=endpointSource;
  const sources={};
  function include(name) {
    if(Object.hasOwn(sources,name))return;
    const source=available[name];
    if(typeof source!=='string')throw Error('Missing administration dependency');
    // This is a conservative bound on code supplied by these tools, not a
    // claimed provider limit. Existing deployed dependencies may be larger.
    if((name===endpointName||Object.hasOwn(overrides??{},name))&&Buffer.byteLength(source,'utf8')>64*1024)
      throw Error('Administration code exceeds the 64 KiB tool limit');
    sources[name]=source;
    if(Object.keys(sources).length>100)throw Error('Administration modules exceed the supported layout');
    const imports=[...source.matchAll(/(?:^|[;\r\n])\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/(?:^|[;\r\n])\s*export\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for(const [,specifier] of imports) {
      if(specifier==='sdk')continue;
      if(!specifier.startsWith('.'))throw Error('Unsupported administration dependency');
      const dependency=posix.normalize(posix.join(posix.dirname(name),specifier)).replace(/\.js$/,'');
      if(!moduleName.test(dependency))throw Error('Unsupported administration dependency');
      include(dependency);
    }
  }
  include(endpointName);
  include('lib/private-config');
  return sources;
}
