// Which notification events go out by email, grouped into the three switches a
// student can set per unit, and what each switch defaults to.
//
// Email is a delivery channel for the events NotificationService already
// produces — same rows, same dedupe keys, same severities. This module only
// answers two questions: "is this notification an email event, and if so in
// which category?" and "is that category on by default?"
//
//   requests       team-up requests: received, accepted, declined, no longer
//                  valid, withdrawn, about to expire.          default ON
//   team           the coordinator finalised / reopened your team. default ON —
//                  it is the coordinator acting on YOUR team, and reopened
//                  needs a response.
//   deadline       the unit deadline is a week / 3 days / a day away, or past.
//                  default OFF — informational; the dashboard carries it.
//
// Never emailed (categoryOf → null):
//   seed                    internal bookkeeping row
//   team_request:expired    the student already had the 24 h warning; expiry
//                           is the consequence of not acting — nothing left to do
//   every teacher-role row  the teacher path has its own prefs
const CATEGORIES = ['requests', 'team', 'deadline'];

const CATEGORY_DEFAULTS = { requests: 1, team: 1, deadline: 0 };

const CATEGORY_LABELS = {
  requests:      'Team-up requests (received, accepted, declined, expiring, withdrawn)',
  team:          'Your team finalised or reopened by your coordinator',
  deadline:      'Deadline reminders'
};

// The event is identified from `type` plus the suffix the producers already
// put in the dedupe key (see NotificationService.syncForUnit).
function categoryOf(n) {
  if (!n || n.recipient_role === 'TEACHER') return null;
  const key = String(n.dedupe_key || '');
  switch (n.type) {
    case 'team_request':
      if (key.endsWith(':expired')) return null;
      return 'requests';
    case 'team_status':   return 'team';
    case 'deadline':      return 'deadline';
    default:              return null;           // seed and anything unknown
  }
}

module.exports = { CATEGORIES, CATEGORY_DEFAULTS, CATEGORY_LABELS, categoryOf };
