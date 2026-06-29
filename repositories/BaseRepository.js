// Base class for all repositories. Holds the injected Database and exposes the
// three query primitives so subclasses can focus on entity-specific SQL.
// Adding a new entity is a matter of `class FooRepository extends BaseRepository`.
class BaseRepository {
  constructor(db) {
    this.db = db;
  }

  all(sql, params = []) {
    return this.db.all(sql, params);
  }

  get(sql, params = []) {
    return this.db.get(sql, params);
  }

  run(sql, params = []) {
    return this.db.run(sql, params);
  }
}

module.exports = BaseRepository;
