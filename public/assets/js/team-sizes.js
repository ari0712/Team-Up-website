// Team size is entered as a minimum and a maximum, but stored and sent as the
// comma-separated list of allowed sizes (`units.valid_team_sizes`, e.g. "4,5,6")
// that every validator and page already understands. These two helpers are the
// only place that conversion happens on the browser side; the server-side
// parser is utils/teamSizes.js.

// 4, 6 -> "4,5,6". Caller validates min >= 1 and max >= min first.
function sizesCsvFromRange(min, max) {
    const out = [];
    for (let n = min; n <= max; n++) out.push(n);
    return out.join(',');
}

// "4,5,6" -> { min: 4, max: 6 }. Anything unparseable reads as a single size of 4,
// matching the column default.
function rangeFromSizesCsv(csv) {
    const nums = String(csv || '').split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);
    if (!nums.length) return { min: 4, max: 4 };
    return { min: nums[0], max: nums[nums.length - 1] };
}

// "4–6" for a range, "4" for a single size.
function sizeRangeLabel(csv) {
    const { min, max } = rangeFromSizesCsv(csv);
    return min === max ? String(min) : `${min}–${max}`;
}
