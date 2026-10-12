import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPublicRepository} from '../../tgcloud/lib/public-repository.js';

// Derive column names, types, primary keys/defaults and indexes from the actual
// SDK schema. Tests fail when an unsupported declaration would hide drift.
export function createPublicDatabase(t) {
  const database=new DatabaseSync(':memory:');if(t)t.after(()=>database.close());
  const source=readFileSync(new URL('../../tgcloud/schema.js',import.meta.url),'utf8');
  const tables=[...source.matchAll(/export const \w+ = table\('([^']+)', \{\r?\n([\s\S]*?)\n\}(?:,|\);)/g)];
  database.exec('CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,document TEXT NOT NULL)');
  for(let i=0;i<tables.length;i++) {
    const match=tables[i],fields=[...match[2].matchAll(/(\w+):\s*(text|integer)\('([^']+)'\)((?:\.[a-zA-Z]+\([^)]*\))*)/g)];
    if(!fields.length)throw Error('Test schema declaration not understood');
    const columns=new Map(fields.map(field=>[field[1],field[3]]));
    database.exec(`CREATE TABLE ${match[1]}(${fields.map(field=>`${field[3]} ${field[2]==='integer'?'INTEGER':'TEXT'}${field[4].includes('.primaryKey()')?' PRIMARY KEY':''}${field[4].includes('.notNull()')?' NOT NULL':''}${/\.default\(([^)]+)\)/.test(field[4])?' DEFAULT '+/\.default\(([^)]+)\)/.exec(field[4])[1]:''}`).join(',')})`);
    const declaration=source.slice(match.index,tables[i+1]?.index??source.length);
    for(const index of declaration.matchAll(/index\('([^']+)'\)\.on\(([^)]+)\)/g)) {
      const fields=index[2].split(',').map(value=>columns.get(value.trim().slice(2)));if(fields.some(value=>!value))throw Error('Test schema index not understood');
      database.exec(`CREATE INDEX ${index[1]} ON ${match[1]}(${fields.join(',')})`);
    }
  }
  const queries=[];
  const db={async get(sql,params={}) {queries.push({method:'get',sql,params});return database.prepare(sql).get(params)??null;},
    async all(sql,params={}) {queries.push({method:'all',sql,params});return database.prepare(sql).all(params);},
    async run(sql,params={}) {queries.push({method:'run',sql,params});return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  return {database,db,queries,repository:(id,options)=>createPublicRepository(db,id,options)};
}
