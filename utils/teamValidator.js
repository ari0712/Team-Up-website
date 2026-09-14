// Shared team-rule validation, used by the student "my-team" view, the teacher
// "all-teams" view, submitTeam, the matcher and the notification producers.
//
// Two kinds of outcome, and they are deliberately not the same thing:
//
//   VIOLATIONS  — hard fails. The unit's rules that must actually hold: a
//                 shared tutorial slot (when the unit requires one), the
//                 new-to-QUT cap, and the largest allowed size. A team with any
//                 of these cannot be submitted or applied, and the UI shows the
//                 rule and why this team breaks it.
//
//   sizeState   — advisory. `valid_team_sizes` is the TARGET for the final
//                 allocation, not a gate. A group of 2 or 3 is a valid,
//                 incomplete record: it can be submitted and the coordinator
//                 finalises after the deadline. UNDER_TARGET is never a
//                 violation. OVER_MAX is — a team of 8 is a real error.
//
// The two call sites that predate this split differ in two small ways, kept as
// options:
//   - tutorialFallback   : the student view falls back to a member's imported
//                          `tutorial_time` when they have no saved `tutorial_slots`.
//   - includeAllAccepted : the teacher view also reports whether every member
//                          has accepted, and reports `tutorialShared` as a strict
//                          boolean (the student view preserves a null when the
//                          team has no accepted members yet).
const { parseTeamSizesCsv } = require('./teamSizes');

const nameOf = m => (m.name && String(m.name).trim()) || m.student_id;

function validateTeam(members, unit, { tutorialFallback = false, includeAllAccepted = false } = {}) {
  const acceptedMembers = members.filter(m => m.status === 'ACCEPTED');
  const targetSizes = (parseTeamSizesCsv(unit.valid_team_sizes) || [4]).slice().sort((a, b) => a - b);
  const maxSize = targetSizes[targetSizes.length - 1];
  const size = members.length;

  const slotSets = acceptedMembers.map(m => new Set(
    (m.tutorial_slots || (tutorialFallback ? m.tutorial_time : '') || '')
      .split(',').map(s => s.trim()).filter(Boolean)
  ));

  let computedShared = null;
  if (acceptedMembers.length > 0) {
    computedShared = [...slotSets[0]].filter(slot => slotSets.every(s => s.has(slot)));
  }
  const sharedTutorials = computedShared || [];

  const newToQutCount = members.filter(m => m.is_new_to_qut == 1).length;
  const maxNewToQut = unit.max_new_to_qut || 2;

  // ── Size: advisory unless over the maximum ──
  let sizeState, needed = 0;
  if (targetSizes.includes(size)) {
    sizeState = 'COMPLETE';
  } else if (size > maxSize) {
    sizeState = 'OVER_MAX';
  } else {
    sizeState = 'UNDER_TARGET';
    needed = targetSizes.find(n => n > size) - size;
  }

  // ── Hard rules ──
  // Each carries the RULE (what the unit requires) and WHY (what this team does
  // that breaks it), so a page never has to invent either.
  const violations = [];

  // A shared slot is only a rule when the unit says so. A unit that turned
  // must_share_tutorial off gets a neutral row, not a red one.
  const tutorialRequired = unit.must_share_tutorial === undefined || unit.must_share_tutorial == 1;
  if (tutorialRequired && acceptedMembers.length > 0 && sharedTutorials.length === 0) {
    const unset = acceptedMembers.filter((m, i) => slotSets[i].size === 0).map(nameOf);
    violations.push({
      code: 'NO_SHARED_TUTORIAL',
      rule: 'All members must share at least one tutorial slot',
      why: unset.length
        ? `${unset.join(', ')} ${unset.length === 1 ? 'has' : 'have'} no tutorial availability saved`
        : 'No single slot is held by every member'
    });
  }

  if (newToQutCount > maxNewToQut) {
    violations.push({
      code: 'NEW_TO_QUT_CAP',
      rule: `Maximum ${maxNewToQut} new-to-QUT student${maxNewToQut === 1 ? '' : 's'} per team`,
      why: `${newToQutCount} of the ${size} member${size === 1 ? '' : 's'} ${newToQutCount === 1 ? 'is' : 'are'} new to QUT`
    });
  }

  if (sizeState === 'OVER_MAX') {
    violations.push({
      code: 'OVER_MAX_SIZE',
      rule: `Largest allowed team size is ${maxSize}`,
      why: `This team has ${size} members`
    });
  }

  const solo = size < 2;

  const validation = {
    // Kept with their original meaning for every existing caller.
    sizeValid:      targetSizes.includes(size),
    tutorialShared: includeAllAccepted
      ? sharedTutorials.length > 0
      : (computedShared && computedShared.length > 0),
    newToQutOk:     newToQutCount <= maxNewToQut,
    sharedTutorials,
    newToQutCount,
    maxNewToQut,
    // The violation / advisory split.
    size,
    targetSizes,
    sizeState,
    needed,
    tutorialRequired,
    violations,
    solo,
    // A group is submittable when it breaks no hard rule and is actually a
    // group. A solo student has nothing mutual to record — they declare
    // "place me anywhere" instead (StudentPortalService.declareNoPreference).
    canSubmit: violations.length === 0 && !solo
  };

  if (includeAllAccepted) {
    validation.allAccepted = members.every(m => m.status === 'ACCEPTED');
  }

  return validation;
}

// "4–5" for a range, "4" for a single size. Shared by the pages so the target is
// always worded the same way.
function targetSizeLabel(unit) {
  const sizes = (parseTeamSizesCsv(unit?.valid_team_sizes) || [4]).slice().sort((a, b) => a - b);
  return sizes.length > 1 ? `${sizes[0]}–${sizes[sizes.length - 1]}` : String(sizes[0]);
}

module.exports = { validateTeam, targetSizeLabel };
