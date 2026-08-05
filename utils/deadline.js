// Team formation locks when the unit's deadline passes.
//
// The lock is DERIVED, never stored. The teacher already controls the deadline
// from the dashboard banner, so bringing it forward locks immediately and
// pushing it out reopens — one source of truth, nothing to drift, and no
// background job needed to flip a flag.
//
// A unit with no deadline never locks.
function isLocked(unit, now = Date.now()) {
  const raw = unit && unit.deadline;
  if (!raw || !String(raw).trim()) return false;
  const at = Date.parse(raw);
  if (isNaN(at)) return false;          // unparseable date: fail open, never trap students
  return at <= now;
}

module.exports = { isLocked };
