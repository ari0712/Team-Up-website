// Shared team-rule validation, previously duplicated between the student
// "my-team" view and the teacher "all-teams" view.
//
// The two call sites differ in two small ways, captured by options:
//   - tutorialFallback   : the student view falls back to a member's imported
//                          `tutorial_time` when they have no saved `tutorial_slots`.
//   - includeAllAccepted : the teacher view also reports whether every member
//                          has accepted, and reports `tutorialShared` as a strict
//                          boolean (the student view preserves a null when the
//                          team has no accepted members yet).
function validateTeam(members, unit, { tutorialFallback = false, includeAllAccepted = false } = {}) {
  const acceptedMembers = members.filter(m => m.status === 'ACCEPTED');
  const validSizes = (unit.valid_team_sizes || '4').split(',').map(s => parseInt(s.trim()));

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

  const validation = {
    sizeValid:      validSizes.includes(members.length),
    tutorialShared: includeAllAccepted
      ? sharedTutorials.length > 0
      : (computedShared && computedShared.length > 0),
    newToQutOk:     newToQutCount <= maxNewToQut,
    sharedTutorials,
    newToQutCount,
    maxNewToQut
  };

  if (includeAllAccepted) {
    validation.allAccepted = members.every(m => m.status === 'ACCEPTED');
  }

  return validation;
}

module.exports = { validateTeam };
