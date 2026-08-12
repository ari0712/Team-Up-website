const BaseRepository = require('./BaseRepository');

// Severity ranking, lowest first. Exported because both this repository (for
// validation) and NotificationService (for the min_severity comparison) need
// the same ordering, and two copies could drift apart.
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];

// A recipient who has never opened the preferences panel has no row. Rather
// than requiring one up front, `get` synthesises this — so the defaults live
// in exactly one place and match the column defaults in SchemaMigrator.
const DEFAULTS = {
  email_enabled:  1,
  email_override: '',
  min_severity:   'INFO'
};

// Data access for `notification_prefs` (per-user email preferences, keyed by
// users.username — covers students and teachers alike).
class NotificationPrefsRepository extends BaseRepository {
  get(username) {
    const row = super.get(
      `SELECT username, email_enabled, email_override, min_severity, updated_at
         FROM notification_prefs WHERE username = ?`,
      [username]
    );
    return row || { username, ...DEFAULTS, updated_at: '' };
  }

  upsert(username, p) {
    // Normalised here rather than at the call site so a bad value can never
    // reach the severity comparison in dispatchEmails.
    const minSeverity = SEVERITIES.includes(p.minSeverity) ? p.minSeverity : 'INFO';
    this.run(
      `INSERT INTO notification_prefs
         (username, email_enabled, email_override, min_severity, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(username) DO UPDATE SET
         email_enabled=excluded.email_enabled,
         email_override=excluded.email_override,
         min_severity=excluded.min_severity,
         updated_at=excluded.updated_at`,
      [username, p.emailEnabled ? 1 : 0, (p.emailOverride || '').trim(),
       minSeverity, p.updatedAt]
    );
    return this.get(username);
  }
}

NotificationPrefsRepository.SEVERITIES = SEVERITIES;
NotificationPrefsRepository.DEFAULTS = DEFAULTS;
module.exports = NotificationPrefsRepository;
