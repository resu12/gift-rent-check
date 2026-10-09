// A single conditional SQLite statement publishes the complete evidence and
// checkpoint document. No cross-call transaction semantics are assumed.
export function createRepository(db) {
  return {
    async read() {
      await db.run('INSERT OR IGNORE INTO collector_state (id, revision, document) VALUES (1, 0, :document)', {':document': JSON.stringify({version: 1, current_run: null, provider_next_allowed_at: 0, runs: []})});
      const row = await db.get('SELECT revision, document FROM collector_state WHERE id = 1');
      if (!row) throw new Error('Private collector storage unavailable');
      return {revision: row.revision, document: JSON.parse(row.document)};
    },
    async compareAndSet(revision, document) {
      const result = await db.run('UPDATE collector_state SET revision = revision + 1, document = :document WHERE id = 1 AND revision = :revision', {':revision': revision, ':document': JSON.stringify(document)});
      return result.rowsAffected === 1;
    },
  };
}
