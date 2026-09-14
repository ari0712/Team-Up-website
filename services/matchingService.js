// =============================================================================
// MatchingService — teacher-side grouping suggestions, available once the
// unit's deadline has locked team formation.
//
// PRIORITY, highest first (this ordering is the whole point):
//
//   1. TUTORIAL AVAILABILITY. When the unit sets must_share_tutorial this is a
//      HARD constraint — candidates are partitioned by slot and never mixed
//      across. When it is off it stays the heaviest weight, so a shared slot
//      still beats any combination of the criteria below it.
//   2. ROLE DIVERSIFICATION. A candidate whose preferred_role already appears in
//      the team is penalised heavily, so teams fill with distinct roles before
//      any role repeats.
//   3. PROJECT INTERESTS. A small bonus per shared interest — the tie-breaker,
//      never the driver.
//
// The weights are separated by an order of magnitude at each level, so no
// accumulation of lower-priority points can outrank a higher-priority one.
//
// Greedy and deterministic: candidates are pre-sorted by student_id, so the same
// input always produces the same grouping. It is a heuristic, not an optimal
// partition — good enough to hand a coordinator a starting point they then edit.
// =============================================================================

const crypto = require('crypto');
const ServiceError = require('./ServiceError');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const { validateTeam } = require('../utils/teamValidator');
const { isLocked } = require('../utils/deadline');

const W_TUTORIAL   = 1000;   // priority 1
const W_ROLE_CLASH = -100;   // priority 2 (penalty for repeating a role)
const W_INTEREST   = 1;      // priority 3

const csvSet = v => new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean));

// Same fallback the classmate search and validateTeam already use: a student's
// own saved slots, or the tutorial time imported for them by the teacher.
function slotsOf(s) {
  const own = csvSet(s.tutorial_slots);
  return own.size ? own : csvSet(s.tutorial_time);
}

const shareAny = (a, b) => [...a].some(x => b.has(x));

class MatchingService {
  constructor({ units, enrollment, teams, prefs, progress }) {
    this.units = units;
    this.enrollment = enrollment;
    this.teams = teams;
    this.prefs = prefs;
    this.progress = progress;
  }

  _unitOr404(unitId, teacherId) {
    const unit = this.units.findOwned(unitId, teacherId);
    if (!unit) throw new ServiceError('Unit not found', 404);
    return unit;
  }

  // A group of 2+ that the matcher must never split: OPEN, and breaking no
  // hard rule right now. This is an invariant, not a preference — finaliseTeams
  // refuses a payload that splits one, whoever built it.
  //
  // A group WITH a violation is not protected. Rule edits, slot deletes and
  // roster re-imports can all put a recorded group in breach after the fact;
  // keeping it together would only reproduce the violation. It is dissolved,
  // and the suggestion says so and why.
  _isProtected(team, unit) {
    const accepted = team.members.filter(m => m.status === 'ACCEPTED');
    if (team.status !== 'OPEN' || accepted.length < 2) return { protected: false };
    const v = validateTeam(team.members, unit, { includeAllAccepted: true, tutorialFallback: true });
    if (!v.violations.length) return { protected: true };
    return { protected: false, reason: `${v.violations[0].rule} — ${v.violations[0].why}` };
  }

  // Who still needs placing, and in what form. One query for every team and
  // member in the unit, not one per team.
  //
  //   settled    FINALISED teams. Untouched.
  //   seeds      protected groups under the target size. Kept whole; the
  //              matcher only ever ADDS to them.
  //   dissolved  OPEN groups of 2+ with a hard violation — split into free
  //              candidates, reported with the reason.
  //   free       everyone else: solo students plus members of dissolved groups.
  //
  // A complete OPEN group (already at a target size, no violation) is also
  // settled: there is nothing to add and nothing to fix.
  pool(unitId, unit) {
    const byId = new Map();
    for (const s of this.enrollment.listWithProgress(unitId)) byId.set(s.student_id, s);
    const shape = (m, fromTeam) => {
      const full = byId.get(m.student_id) || {};
      return {
        student_id: m.student_id,
        name: full.name || m.name || m.student_id,
        preferred_role: (full.preferred_role || '').trim(),
        interests: csvSet(full.project_interests),
        slots: slotsOf(full),
        is_new_to_qut: (full.is_new_to_qut == 1) ? 1 : 0,
        from_team: fromTeam,
      };
    };

    const settled = [], seeds = [], dissolved = [], free = [];
    for (const team of this.teams.listWithMembersDetailed(unitId)) {
      const accepted = team.members.filter(m => m.status === 'ACCEPTED');
      if (!accepted.length) continue;
      const validation = validateTeam(team.members, unit, { includeAllAccepted: true, tutorialFallback: true });

      if (team.status === 'FINALISED' ||
          (validation.sizeState === 'COMPLETE' && !validation.violations.length)) {
        settled.push({ team, members: accepted });
        continue;
      }

      const guard = this._isProtected(team, unit);
      if (guard.protected) {
        seeds.push({ team, members: accepted.map(m => shape(m, team.team_name)) });
        continue;
      }
      if (accepted.length >= 2) dissolved.push({ team, reason: guard.reason });
      for (const m of accepted) free.push(shape(m, team.team_name));
    }

    // Deterministic: seeds largest first then by creation order; free by id.
    seeds.sort((a, b) => (b.members.length - a.members.length) ||
                         ((a.team.team_number || 0) - (b.team.team_number || 0)));
    free.sort((a, b) => a.student_id.localeCompare(b.student_id));
    return { settled, seeds, dissolved, free };
  }

  // How well `c` fits the team built so far. Higher is better; null means the
  // candidate is not allowed in at all.
  _score(team, c, unit) {
    if (unit.max_new_to_qut != null) {
      const newCount = team.filter(m => m.is_new_to_qut).length + (c.is_new_to_qut ? 1 : 0);
      if (newCount > unit.max_new_to_qut) return null;      // a unit rule, not a preference
    }

    const sharesTutorial = team.every(m => shareAny(m.slots, c.slots));
    if (unit.must_share_tutorial && team.length && !sharesTutorial) return null;

    let score = 0;
    if (sharesTutorial && team.length) score += W_TUTORIAL;
    if (c.preferred_role && team.some(m => m.preferred_role === c.preferred_role))
      score += W_ROLE_CLASH;
    for (const m of team) {
      for (const i of c.interests) if (m.interests.has(i)) score += W_INTEREST;
    }
    return score;
  }

  suggest(unitId, teacherId) {
    const unit = this._unitOr404(unitId, teacherId);
    if (!isLocked(unit))
      throw new ServiceError('Suggestions unlock once the deadline has passed', 409);

    const { settled, seeds, dissolved, free } = this.pool(unitId, unit);
    const sizes = (parseTeamSizesCsv(unit.valid_team_sizes) || [4]).slice().sort((a, b) => a - b);
    const target = sizes[sizes.length - 1];      // aim for the largest legal team
    const minSize = sizes[0];

    const remaining = [...free];
    // Grow `team` greedily from `remaining` until it reaches `target` or nobody
    // may legally join.
    const grow = team => {
      while (team.length < target && remaining.length) {
        let bestIdx = -1, bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const s = this._score(team, remaining[i], unit);
          if (s === null) continue;
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
        if (bestIdx === -1) break;
        team.push(remaining.splice(bestIdx, 1)[0]);
      }
      return team;
    };

    // Seeds first: a recorded pair is topped up, never rebuilt. A seed that
    // cannot be filled is still emitted as a team — the students' mutual
    // preference stands whether or not the matcher found company for it.
    const built = seeds.map(x => ({ members: grow([...x.members]), seed: x.team }));

    // Then everyone still free, grown from the next student in stable order.
    while (remaining.length) built.push({ members: grow([remaining.shift()]), seed: null });

    // A trailing group of free students too small to be legal is offered as
    // unassigned rather than presented as a team the teacher cannot approve.
    // Seeds are exempt: they are never dissolved into the unassigned pool.
    const teams = [];
    let unassigned = [];
    for (const t of built) {
      if (t.seed || t.members.length >= minSize) teams.push(t);
      else unassigned = unassigned.concat(t.members);
    }

    return {
      locked: true,
      // Why anyone was left over. Without this a teacher whose constraints
      // cannot be satisfied just sees an empty result and assumes it is broken.
      unassigned_reason: this._whyUnassigned(unassigned, free, unit, minSize),
      valid_team_sizes: unit.valid_team_sizes,
      must_share_tutorial: !!unit.must_share_tutorial,
      max_new_to_qut: unit.max_new_to_qut,
      teams: teams.map((t, i) => ({
        ...this._describe(t.members, unit, i),
        // The page draws these as one locked block and finaliseTeams refuses to
        // split them — so the two can never disagree about what is protected.
        seed_team_id:      t.seed?.team_id   || null,
        seed_team_name:    t.seed?.team_name || null,
        locked_member_ids: t.seed ? seeds.find(x => x.team === t.seed).members.map(m => m.student_id) : [],
      })),
      unassigned: unassigned.map(m => this._member(m)),
      settled: settled.map(g => ({
        team_id: g.team.team_id, team_name: g.team.team_name, status: g.team.status,
        members: g.members.map(m => ({ student_id: m.student_id, name: m.name })),
      })),
      // Groups that were split, and the rule that made them unrecordable. Named
      // so the coordinator knows it was deliberate and can chase the fix.
      dissolved: dissolved.map(d => ({
        team_id: d.team.team_id, team_name: d.team.team_name, reason: d.reason,
      })),
    };
  }

  // ── Student-side Auto-Match ─────────────────────────────────────────────────
  // Ranks the teams THIS student could merge with, using the very same _score and
  // weights as the teacher matcher, so the two can never recommend contradictory
  // things.
  //
  // Candidates are TEAMS, not individuals. Every student is eager-assigned a
  // team-of-one and teaming up joins two whole teams, so teaming up with someone
  // in a team of three brings all three. Ranking individuals would happily
  // suggest a team-up that overflows the unit's size rule.
  //
  // This recommends only — it never sends a request. The student picks.
  suggestForStudent(unitId, studentId) {
    const unit = this.units.findById(unitId);          // NOT findOwned: the caller is a student
    if (!unit) throw new ServiceError('Unit not found', 404);

    const mine = this.teams.findStudentTeam(unitId, studentId);
    if (!mine) throw new ServiceError('You are not on a team in this unit', 400);

    const byId = new Map();
    for (const s of this.enrollment.listWithProgress(unitId)) byId.set(s.student_id, s);
    const shape = (m, fallback = {}) => {
      const full = byId.get(m.student_id) || fallback;
      return {
        student_id: m.student_id,
        name: full.name || m.name || m.student_id,
        preferred_role: (full.preferred_role || m.preferred_role || '').trim(),
        interests: csvSet(full.project_interests ?? m.project_interests),
        slots: slotsOf(Object.keys(full).length ? full : m),
        is_new_to_qut: ((full.is_new_to_qut ?? m.is_new_to_qut) == 1) ? 1 : 0,
      };
    };

    const myMembers = this.teams.getMembersDetailed(unitId, mine.team_id)
      .filter(m => m.status === 'ACCEPTED').map(m => shape(m));

    // Only teams that are not finalised, other than my own — what sendRequest
    // accepts, so nothing we suggest is refused the moment the student clicks it.
    const groups = new Map();
    for (const c of this.enrollment.listClassmates(unitId, studentId)) {
      if (!c.team_id || c.team_id === mine.team_id) continue;
      if (c.team_status === 'FINALISED') continue;
      if (!groups.has(c.team_id)) groups.set(c.team_id, []);
      groups.get(c.team_id).push(shape(c, c));
    }

    const sizes = (parseTeamSizesCsv(unit.valid_team_sizes) || [4]).slice().sort((a, b) => a - b);
    const maxSize = sizes[sizes.length - 1];

    const options = [];
    for (const [teamId, members] of groups) {
      if (!members.length) continue;
      if (myMembers.length + members.length > maxSize) continue;   // would overflow the unit rule

      // Fold their members onto my team one at a time through the shared scorer.
      // A null at any step means a hard rule (tutorial / new-to-QUT) forbids it.
      let running = [...myMembers], total = 0, allowed = true;
      for (const m of members) {
        const s = this._score(running, m, unit);
        if (s === null) { allowed = false; break; }
        total += s;
        running.push(m);
      }
      if (!allowed) continue;

      const merged = running.map(m => ({
        student_id: m.student_id, status: 'ACCEPTED',
        tutorial_slots: [...m.slots].join(','),
        is_new_to_qut: m.is_new_to_qut,
      }));
      const validation = validateTeam(merged, unit, { tutorialFallback: true });
      const team = this.teams.findById(teamId);

      options.push({
        team_id: teamId,
        team_name: team?.team_name || 'Team',
        members: members.map(m => ({
          student_id: m.student_id, name: m.name, preferred_role: m.preferred_role,
        })),
        combinedSize: merged.length,
        sizeValid: validation.sizeValid,
        score: total,
        reasons: this._matchReasons(myMembers, members, validation, merged.length, sizes),
      });
    }

    // A team-up that completes a legal team wins over a merely higher-scoring one:
    // reaching a valid size is the point of the exercise. Intermediate merges are
    // still offered below, or a solo student in a 4/5 unit could only ever match a
    // team of exactly 3 or 4 — useless while everyone is still solo.
    options.sort((a, b) =>
      (b.sizeValid - a.sizeValid) || (b.score - a.score) || a.team_id.localeCompare(b.team_id));

    return {
      my_team_size: myMembers.length,
      valid_team_sizes: unit.valid_team_sizes,
      must_share_tutorial: !!unit.must_share_tutorial,
      suggestions: options.slice(0, 5),
      // An empty panel that explains itself beats one that looks broken.
      why_empty: options.length ? null
        : this._whyNoMatch(groups.size, myMembers, unit, maxSize),
    };
  }

  // Plain English for the same signals that produced the score, derived from them
  // rather than restated, so the explanation cannot drift from the ranking.
  _matchReasons(myMembers, theirMembers, validation, combinedSize, sizes) {
    const out = [];
    out.push(validation.sharedTutorials.length
      ? `Shares ${validation.sharedTutorials.join(', ')}`
      : 'No shared tutorial slot');

    const myRoles = new Set(myMembers.map(m => m.preferred_role).filter(Boolean));
    const clash = theirMembers.filter(m => m.preferred_role && myRoles.has(m.preferred_role));
    const fresh = theirMembers.filter(m => m.preferred_role && !myRoles.has(m.preferred_role));
    out.push(clash.length
      ? `Repeats your role: ${[...new Set(clash.map(m => m.preferred_role))].join(', ')}`
      : fresh.length ? `Adds ${[...new Set(fresh.map(m => m.preferred_role))].join(', ')}`
                     : 'No role set');

    let shared = 0;
    for (const mine of myMembers)
      for (const them of theirMembers)
        for (const i of them.interests) if (mine.interests.has(i)) shared++;
    out.push(shared ? `${shared} shared interest${shared === 1 ? '' : 's'}` : 'No shared interests');

    out.push(validation.sizeValid
      ? `Makes a complete team of ${combinedSize}`
      : `Team of ${combinedSize} — still needs ${Math.min(...sizes.filter(s => s > combinedSize)) - combinedSize || 0} more`);
    return out;
  }

  _whyNoMatch(groupCount, myMembers, unit, maxSize) {
    if (groupCount === 0)
      return 'Nobody else in this unit is currently open to merging — everyone is either on your ' +
             'team already or has been finalised.';
    if (unit.must_share_tutorial)
      return 'This unit requires every team to share a tutorial slot, and no open team shares one ' +
             'with yours. Check your tutorial times on the Preferences page.';
    if (myMembers.length >= maxSize)
      return `Your team is already at the largest size this unit allows (${maxSize}).`;
    return `Every open team would push you past the largest allowed size (${maxSize}), or breaks the ` +
           `limit of ${unit.max_new_to_qut} new-to-QUT students per team.`;
  }

  // Diagnose a leftover so the teacher knows which rule to relax rather than
  // being told only that nothing could be built.
  _whyUnassigned(unassigned, pool, unit, minSize) {
    if (!unassigned.length) return null;
    if (pool.length < minSize)
      return `Only ${pool.length} student${pool.length === 1 ? '' : 's'} need regrouping, but the ` +
             `smallest team this unit allows is ${minSize}. Add ${minSize - pool.length} more, or ` +
             `allow a smaller size in the unit's rules.`;

    if (unit.must_share_tutorial) {
      // Is there any slot at all shared by enough of them?
      const bySlot = new Map();
      for (const s of pool) for (const slot of s.slots)
        bySlot.set(slot, (bySlot.get(slot) || 0) + 1);
      const best = [...bySlot.entries()].sort((a, b) => b[1] - a[1])[0];
      const noSlots = pool.filter(s => !s.slots.size).map(s => s.name);
      if (noSlots.length)
        return `${noSlots.join(', ')} ${noSlots.length === 1 ? 'has' : 'have'} no tutorial availability ` +
               `saved, and this unit requires a shared tutorial. Ask them to set it, or turn off ` +
               `"must share tutorial" in the unit's rules.`;
      return `This unit requires a shared tutorial slot, and no ${minSize} of these students share one — ` +
             (best ? `the most popular slot (${best[0]}) is only available to ${best[1]} of them. ` : '') +
             `Place them by hand below, or turn off "must share tutorial" in the unit's rules.`;
    }
    return `Not enough students remained to fill a team of ${minSize}. Place them by hand below.`;
  }

  _member(m) {
    return {
      student_id: m.student_id, name: m.name,
      preferred_role: m.preferred_role,
      tutorial_slots: [...m.slots].join(','),
      project_interests: [...m.interests].join(','),
      is_new_to_qut: m.is_new_to_qut,
      from_team: m.from_team,
    };
  }

  // Report the same validation shape the rest of the teacher UI uses, plus a
  // plain-language note per criterion so the teacher can see WHY these students.
  _describe(members, unit, index) {
    const shaped = members.map(m => ({
      student_id: m.student_id, status: 'ACCEPTED',
      tutorial_slots: [...m.slots].join(','),
      is_new_to_qut: m.is_new_to_qut,
    }));
    const validation = validateTeam(shaped, unit, { tutorialFallback: true, includeAllAccepted: true });

    const roles = members.map(m => m.preferred_role).filter(Boolean);
    const dupRoles = roles.filter((r, i) => roles.indexOf(r) !== i);
    const shared = members.reduce(
      (acc, m) => acc === null ? new Set(m.interests) : new Set([...acc].filter(x => m.interests.has(x))),
      null) || new Set();

    return {
      index,
      members: members.map(m => this._member(m)),
      validation,
      reasons: [
        validation.sharedTutorials.length
          ? `Shares ${validation.sharedTutorials.join(', ')}`
          : 'No shared tutorial slot',
        dupRoles.length ? `Repeated role: ${[...new Set(dupRoles)].join(', ')}`
                        : `${new Set(roles).size} distinct roles`,
        shared.size ? `Common interest: ${[...shared].join(', ')}` : 'No common interest',
      ],
    };
  }

}

module.exports = MatchingService;
