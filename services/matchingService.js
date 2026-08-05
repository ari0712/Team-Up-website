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

  // Students who still need a team: everyone whose current team is not APPROVED
  // and does not pass the unit's own size rule. Viability comes from
  // validateTeam, NOT team status — submitTeam performs no validation, so a
  // SUBMITTED team can be the wrong size and still need regrouping.
  pool(unitId, unit) {
    const stuck = [];
    const settled = [];
    for (const team of this.teams.listAllWithCounts(unitId)) {
      const members = this.teams.getMembersDetailed(unitId, team.team_id);
      const accepted = members.filter(m => m.status === 'ACCEPTED');
      const viable = team.status === 'APPROVED' ||
                     validateTeam(members, unit, { includeAllAccepted: true }).sizeValid;
      (viable ? settled : stuck).push({ team, members: accepted });
    }

    const byId = new Map();
    for (const s of this.enrollment.listWithProgress(unitId)) byId.set(s.student_id, s);

    const candidates = [];
    for (const g of stuck) {
      for (const m of g.members) {
        const full = byId.get(m.student_id) || {};
        candidates.push({
          student_id: m.student_id,
          name: full.name || m.name || m.student_id,
          preferred_role: (full.preferred_role || '').trim(),
          interests: csvSet(full.project_interests),
          slots: slotsOf(full),
          is_new_to_qut: (full.is_new_to_qut == 1) ? 1 : 0,
          from_team: g.team.team_name,
        });
      }
    }
    candidates.sort((a, b) => a.student_id.localeCompare(b.student_id));
    return { candidates, settled, dissolving: stuck.map(g => g.team) };
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

    const { candidates, settled, dissolving } = this.pool(unitId, unit);
    const sizes = (parseTeamSizesCsv(unit.valid_team_sizes) || [4]).slice().sort((a, b) => a - b);
    const target = sizes[sizes.length - 1];      // aim for the largest legal team
    const minSize = sizes[0];

    const remaining = [...candidates];
    const built = [];

    while (remaining.length) {
      // Seed with the next student in stable order, then grow greedily.
      const team = [remaining.shift()];
      while (team.length < target && remaining.length) {
        let bestIdx = -1, bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const s = this._score(team, remaining[i], unit);
          if (s === null) continue;
          if (s > bestScore) { bestScore = s; bestIdx = i; }
        }
        if (bestIdx === -1) break;              // nobody may legally join
        team.push(remaining.splice(bestIdx, 1)[0]);
      }
      built.push(team);
    }

    // A trailing group too small to be legal is offered as unassigned rather
    // than presented as a team the teacher cannot approve.
    const teams = [];
    let unassigned = [];
    for (const t of built) {
      if (t.length >= minSize) teams.push(t);
      else unassigned = unassigned.concat(t);
    }

    return {
      locked: true,
      // Why anyone was left over. Without this a teacher whose constraints
      // cannot be satisfied just sees an empty result and assumes it is broken.
      unassigned_reason: this._whyUnassigned(unassigned, candidates, unit, minSize),
      valid_team_sizes: unit.valid_team_sizes,
      must_share_tutorial: !!unit.must_share_tutorial,
      max_new_to_qut: unit.max_new_to_qut,
      teams: teams.map((members, i) => this._describe(members, unit, i)),
      unassigned: unassigned.map(m => this._member(m)),
      settled: settled.map(g => ({
        team_id: g.team.team_id, team_name: g.team.team_name, status: g.team.status,
        members: g.members.map(m => ({ student_id: m.student_id, name: m.name })),
      })),
      dissolving: dissolving.map(t => ({ team_id: t.team_id, team_name: t.team_name })),
    };
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

  // ── Apply ───────────────────────────────────────────────────────────────────
  // The teacher is the authority here: a grouping that breaks the unit's size
  // rule is accepted (coordinators genuinely need a team of 3 when the numbers
  // do not divide) — the UI flags it before this is called. What is NOT
  // negotiable is integrity: every student must be enrolled and appear once.
  // Applied teams are always approved. This only runs once the unit is locked,
  // and a locked unit blocks submitTeam — so a team left FORMING here would be
  // unreachable for everyone: students cannot submit it and the teacher's review
  // screen only offered actions on SUBMITTED teams. There is no unapproved path.
  applyTeams(unitId, teacherId, groups) {
    const unit = this._unitOr404(unitId, teacherId);
    if (!isLocked(unit))
      throw new ServiceError('Teams can only be organised after the deadline has passed', 403);
    if (!Array.isArray(groups) || !groups.length)
      throw new ServiceError('Provide at least one team', 400);

    const enrolled = new Set(this.enrollment.listWithProgress(unitId).map(s => s.student_id));
    const seen = new Set();
    const clean = [];
    for (const g of groups) {
      if (!Array.isArray(g) || !g.length) continue;
      const ids = [];
      for (const sid of g) {
        if (!enrolled.has(sid)) throw new ServiceError(`${sid} is not enrolled in this unit`, 400);
        if (seen.has(sid)) throw new ServiceError(`${sid} appears in more than one team`, 400);
        seen.add(sid);
        ids.push(sid);
      }
      clean.push(ids);
    }
    if (!clean.length) throw new ServiceError('Provide at least one team', 400);

    // Only teams the payload actually touches are dissolved; approved teams and
    // anyone left out are untouched.
    const affected = new Set();
    for (const sid of seen) {
      const m = this.teams.findStudentTeam(unitId, sid);
      if (m) affected.add(m.team_id);
    }

    const now = new Date().toISOString();
    const created = [];

    // Empty the teams being reshuffled first, so a student is never briefly a
    // member of two teams.
    for (const teamId of affected) {
      const t = this.teams.findById(teamId);
      if (!t || t.status === 'APPROVED') continue;
      for (const m of this.teams.getMembers(teamId)) this.teams.removeMember(teamId, m.student_id);
    }

    for (const ids of clean) {
      const number = this.teams.nextTeamNumber(unitId);
      const teamId = crypto.randomUUID();
      this.teams.create(teamId, unitId, `Team ${number}`, number, ids[0]);
      for (const sid of ids) {
        this.teams.addMember(teamId, sid, this.prefs.getPreferredRole(unitId, sid));
        // Every progress mark* is a bare UPDATE that silently does nothing when
        // the row is missing. joinUnit normally creates it, but relying on that
        // would mean a teacher could "approve" someone and have it not stick.
        this.progress.ensure(unitId, sid);
        this.progress.markInTeam(unitId, sid);
        this.progress.markSubmitted(unitId, sid);
        this.progress.markTeacherApproved(unitId, sid);
      }
      this.teams.markSubmitted(teamId, now);        // records submitted_at
      this.teams.setStatus(teamId, 'APPROVED');
      created.push({ team_id: teamId, team_name: `Team ${number}`, members: ids });
    }

    // Teams left with nobody after the reshuffle are removed, not left as ghosts.
    for (const teamId of affected) this.teams.deleteIfEmpty(teamId);

    return { ok: true, approved: true, teams: created };
  }
}

module.exports = MatchingService;
