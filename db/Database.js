const initSqlJs = require('sql.js');
const fs = require('fs');
const SchemaMigrator = require('./SchemaMigrator');

// Thin OO wrapper around a sql.js in-memory database that persists to a single
// file. One instance is created in the composition root (server.js) and injected
// into every repository/service, so there is a single source of truth for the
// connection.
//
// Query helpers are bound in the constructor, which means callers may safely
// destructure them — `const { all, get, run, tx } = db` — and still keep `this`.
class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.raw = null;

    this.all  = this.all.bind(this);
    this.get  = this.get.bind(this);
    this.run  = this.run.bind(this);
    this.tx   = this.tx.bind(this);
    this.save = this.save.bind(this);
  }

  // Loads the file if present (else creates a fresh db), runs schema + migrations,
  // and flushes once. Returns `this` for fluent wiring.
  async connect() {
    const SQL = await initSqlJs();

    if (fs.existsSync(this.filePath)) {
      this.raw = new SQL.Database(fs.readFileSync(this.filePath));
      console.log('Loaded existing teamup.db');
    } else {
      this.raw = new SQL.Database();
      console.log('Created new teamup.db');
    }

    new SchemaMigrator(this.raw).migrate();
    this.save();
    return this;
  }

  // Array of row objects.
  all(sql, params = []) {
    const stmt = this.raw.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // First row or null.
  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  // INSERT/UPDATE/DELETE, then flush to disk.
  run(sql, params = []) {
    this.raw.run(sql, params);
    this.save();
  }

  // Wraps a unit of work in BEGIN/COMMIT with a single flush at the end. Inside
  // `fn`, use the raw handle passed in (`db.run`/`db.prepare`) — not the saving
  // `run` helper — so disk is written once per transaction.
  tx(fn) {
    this.raw.run('BEGIN TRANSACTION');
    try {
      const result = fn(this.raw);
      this.raw.run('COMMIT');
      this.save();
      return result;
    } catch (e) {
      this.raw.run('ROLLBACK');
      throw e;
    }
  }

  save() {
    if (!this.raw) return;
    fs.writeFileSync(this.filePath, Buffer.from(this.raw.export()));
  }
}

module.exports = Database;
