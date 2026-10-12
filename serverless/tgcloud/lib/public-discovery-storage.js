// Public discovery keeps immutable page evidence, but writes candidate changes
// only once. Reservation/control checkpoints refer to those same scoped deltas.
export const CANDIDATES = '__public_discovery_candidates';
export const CATALOG = '__public_discovery_catalog';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sequence = value => Number.isSafeInteger(value) && value > 0;
export function compactDiscoveryJob(job, at, previous = null, previousSequence = null) {
  if (!object(job) || job.kind !== 'discover') return job;
  if (!sequence(at) || !object(job.candidates) || !Array.isArray(job.catalog)
      || Object.hasOwn(job, CANDIDATES) || Object.hasOwn(job, CATALOG)) throw new Error('Invalid discovery checkpoint');
  const saved = {...job}; delete saved.candidates; delete saved.catalog;
  const prior = previous?.job, physical = previous?.physical;
  const sameRun = prior?.kind === 'discover' && prior.id === job.id;
  const changes = Object.create(null);
  for (const [nft, value] of Object.entries(job.candidates)) {
    if (!sameRun || JSON.stringify(prior.candidates?.[nft]) !== JSON.stringify(value)) changes[nft] = value;
  }
  if (sameRun) for (const nft of Object.keys(prior.candidates || {})) if (!Object.hasOwn(job.candidates, nft)) changes[nft] = null;
  const candidateSource = sameRun ? physical?.[CANDIDATES]?.sequence ?? previousSequence : null;
  saved[CANDIDATES] = !Object.keys(changes).length && sequence(candidateSource)
    ? {sequence: candidateSource} : {sequence: at, changes, base: !sameRun};
  const catalogSource = sameRun ? physical?.[CATALOG]?.sequence ?? previousSequence : null;
  saved[CATALOG] = sameRun && JSON.stringify(prior.catalog) === JSON.stringify(job.catalog) && sequence(catalogSource)
    ? {sequence: catalogSource} : {sequence: at, values: job.catalog};
  return saved;
}
export async function expandDiscoveryJob(row, sourceRows, sourceRow) {
  if (!row || typeof row.job_json !== 'string') return null;
  const saved = JSON.parse(row.job_json);
  if (saved?.kind !== 'discover' || !Object.hasOwn(saved, CANDIDATES)) return saved;
  const marker = saved[CANDIDATES], catalog = saved[CATALOG];
  if (!object(marker) || !sequence(marker.sequence) || marker.sequence > row.sequence || !object(catalog)
      || !sequence(catalog.sequence) || catalog.sequence > row.sequence) throw new Error('Invalid discovery checkpoint reference');
  const candidates = Object.create(null); let last = 0, base = false;
  for await (const occurrence of sourceRows(saved.id, marker.sequence)) {
    const job = JSON.parse(occurrence.job_json);
    if (job.id !== saved.id || job.kind !== 'discover') throw new Error('Invalid discovery candidate source');
    if (object(job.candidates)) {for (const key of Object.keys(candidates)) delete candidates[key];Object.assign(candidates, job.candidates);base = true;last = occurrence.sequence;continue;}
    const delta = job[CANDIDATES];
    if (!object(delta) || delta.sequence !== occurrence.sequence || !object(delta.changes)) throw new Error('Invalid discovery candidate delta');
    if (delta.base === true) {for (const key of Object.keys(candidates)) delete candidates[key];base = true;}
    if (!base) throw new Error('Missing discovery candidate base');
    for (const [nft, value] of Object.entries(delta.changes)) {
      if (value === null) delete candidates[nft];
      else if (!object(value) || value.nft_address !== nft) throw new Error('Invalid discovery candidate');
      else candidates[nft] = value;
    }
    if (Object.keys(candidates).length > 1000) throw new Error('Invalid discovery candidate count');
    last = occurrence.sequence;
  }
  if (!base || last !== marker.sequence) throw new Error('Missing discovery candidate reference');
  const catalogRow = catalog.sequence === row.sequence ? row : await sourceRow(saved.id, catalog.sequence);
  const catalogJob = catalogRow && JSON.parse(catalogRow.job_json);
  const values = catalogJob?.[CATALOG]?.values ?? catalogJob?.catalog;
  if (catalogJob?.id !== saved.id || !Array.isArray(values) || values.length > 1000) throw new Error('Missing discovery catalog reference');
  delete saved[CANDIDATES];delete saved[CATALOG];saved.candidates = {...candidates};saved.catalog = values;
  return saved;
}
