// Where a student stands in team formation, from the coordinator's point of view.
//
// Every enrolled student is always on a team (a team-of-one at minimum), so
// "in a team" identifies nobody. These three categories are what actually
// distinguish students, and they drive the class list, the export and every
// teacher attention signal — one definition, used server-side by all of them.
//
//   GROUPED   in a group of 2+. An accepted team-up request IS the record, so
//             a formed group is a recorded group; no further step exists.
//   DECLARED  alone, and has explicitly asked to be placed anywhere. Needs
//             allocation, not chasing.
//   SILENT    alone, nothing recorded. These are the ones to chase.
//
// Team status (OPEN / FINALISED) is deliberately not part of this: it says
// whether the coordinator has locked the group, not whether the student has
// done their part.
const PLACEMENTS = ['GROUPED', 'DECLARED', 'SILENT'];

const PLACEMENT_LABELS = {
  GROUPED:  'Grouped',
  DECLARED: 'Declared no preference',
  SILENT:   'No activity recorded'
};

function placementOf({ acceptedCount, noPreferenceAt }) {
  if (acceptedCount >= 2) return 'GROUPED';
  return noPreferenceAt && String(noPreferenceAt).trim() ? 'DECLARED' : 'SILENT';
}

module.exports = { PLACEMENTS, PLACEMENT_LABELS, placementOf };
