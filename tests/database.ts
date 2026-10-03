import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

/** D1 adapter backed by the committed migrations, including atomic batches. */
export function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    sql.exec(readFileSync(`drizzle/${name}`, 'utf8'));
  }
  class Statement {
    values: (string | number | null)[] = [];
    constructor(readonly query: string) {}
    bind(...values: (string | number | null)[]) {
      if(values.length>100)throw new Error('D1 supports at most 100 bound parameters.');
      this.values = values;
      return this;
    }
    execute() {
      const statement = sql.prepare(this.query);
      const results = statement.columns().length
        ? statement.all(...this.values)
        : [];
      const change = statement.columns().length
        ? sql
            .prepare(
              'SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid',
            )
            .get()!
        : statement.run(...this.values);
      return {
        results,
        success: true,
        meta: {
          changes: Number(change.changes),
          last_row_id: Number(change.lastInsertRowid),
          duration: 0,
        },
      };
    }
    async first() {
      return this.execute().results[0] ?? null;
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
  }
  const db = {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sql };
}
