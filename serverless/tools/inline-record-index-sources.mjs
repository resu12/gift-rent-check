import {posix} from 'node:path';
import {NORMALIZED_RECORD_KINDS,inlineRecordEventSelect,inlineRecordIndexDefinitions} from '../tgcloud/lib/cloud-repository.js';

// The installer needs only these pure definitions. Generate them from the
// runtime functions themselves so administrative SQL cannot drift from readers.
export function inlineRecordAdminRepositorySource() {
  return `export const NORMALIZED_RECORD_KINDS=Object.freeze(${JSON.stringify(NORMALIZED_RECORD_KINDS)});\nexport ${inlineRecordEventSelect.toString()}\nexport ${inlineRecordIndexDefinitions.toString()}\n`;
}

// Administrative runFunction uploads are repeated for each bounded pass. Send
// only the endpoint's transitive static imports, keeping unrelated application
// modules and credentials outside this temporary bundle. Nothing is published.
export function inlineRecordAdminSources(canonical,overrides,endpoint) {
  const available=Object.fromEntries(Object.entries(canonical??{}).filter(([name])=>name.startsWith('lib/')));
  for(const [name,source] of Object.entries(overrides)) {
    if(!/^lib\/[A-Za-z0-9_-]+$/.test(name)||typeof source!=='string')throw new Error('Invalid administration library');
    available[name]=source;
  }
  if(typeof endpoint!=='string')throw new Error('Invalid administration endpoint');
  available['endpoints/installInlineRecordIndex']=endpoint;
  const sources={};
  function include(name) {
    if(Object.hasOwn(sources,name))return;
    const source=available[name];if(typeof source!=='string')throw new Error('Missing administration dependency');
    sources[name]=source;if(Object.keys(sources).length>99)throw new Error('Administration modules exceed the supported layout');
    const imports=[...source.matchAll(/(?:^|[;\r\n])\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/(?:^|[;\r\n])\s*export\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s+from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for(const [,specifier] of imports) {
      if(specifier==='sdk')continue;
      if(!specifier.startsWith('.'))throw new Error('Unsupported administration dependency');
      const dependency=posix.normalize(posix.join(posix.dirname(name),specifier)).replace(/\.js$/,'');
      if(!/^lib\/[A-Za-z0-9_-]+$/.test(dependency))throw new Error('Unsupported administration dependency');
      include(dependency);
    }
  }
  include('endpoints/installInlineRecordIndex');
  include('lib/private-config');
  return sources;
}
