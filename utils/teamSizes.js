// Parses a comma-separated list of positive integers (used by `units.valid_team_sizes`).
// Returns the array of numbers, or null if the input is invalid / empty.
function parseTeamSizesCsv(csv) {
  if (typeof csv !== 'string') return null;
  const parts = csv.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nums = parts.map(s => parseInt(s, 10));
  if (nums.some(n => isNaN(n) || n <= 0)) return null;
  return nums;
}

module.exports = { parseTeamSizesCsv };
