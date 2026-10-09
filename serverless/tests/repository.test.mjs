import test from 'node:test';
import assert from 'node:assert/strict';
import {createRepository} from '../tgcloud/lib/repository.js';

test('repository atomically compares revision and writes the entire JSON document with bound SQL', async () => {
  const calls = []; let row = null;
  const db = {
    async run(sql, params) {
      calls.push({sql, params});
      if (sql.startsWith('INSERT')) {row ??= {revision: 0, document: params[':document']}; return {rowsAffected: 1};}
      if (row.revision !== params[':revision']) return {rowsAffected: 0};
      row = {revision: row.revision + 1, document: params[':document']}; return {rowsAffected: 1};
    },
    async get() {return row;},
  };
  const repository = createRepository(db);
  assert.equal((await repository.read()).revision, 0);
  const document = {checkpoint: 'opaque cursor', raw: '{"items":[]}', listings: []};
  assert.equal(await repository.compareAndSet(0, document), true);
  assert.equal(await repository.compareAndSet(0, {wrong: true}), false);
  assert.deepEqual((await repository.read()).document, document);
  const updates = calls.filter(call => call.sql.startsWith('UPDATE'));
  assert.equal(updates.length, 2);
  assert.match(updates[0].sql, /WHERE id = 1 AND revision = :revision/);
  assert.equal(updates[0].sql.includes('opaque cursor'), false);
  assert.equal(updates[0].params[':document'], JSON.stringify(document));
});
