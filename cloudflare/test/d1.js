// A minimal D1 binding over node:sqlite, enough to run the handlers in tests.
import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args);
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
}

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
