// =============================================================================
// TeamRequestService — team-up requests between two teams.
//
// Every student is a team (size-1 by default, eager-created on unit join). To
// team up, one side sends a REQUEST to the other; every accepted member of both
// teams must ACCEPT it. Unanimous acceptance is the moment students indicate
// mutual preference, and it IS the record: the two teams become one, and no
// human approves it afterwards.
//
// Rules are evaluated at that moment, twice: when the request is sent (so an
// infeasible team-up is refused up front, naming the rule and why) and again
// just before the teams are joined (preferences may have moved in between).
//
// Storage keeps the older names — tables `proposals` / `proposal_votes`, state
// values open|approved|rejected|expired|invalidated|auto_cancelled, vote values
// pending|yes|no. Renaming them would churn the schema for no user-visible
// gain. The mapping is: proposal = request, vote yes = accept, vote no =
// decline, approved = accepted by everyone, rejected = declined.
//
// API SHAPES (consumed by the frontend):
//
//   POST   /api/student/units/:unitId/team-requests     body: { targetTeamId }
//          → 200 { requestId, state }
//          → 400/403/404/409 on validation (400 code RULE names the broken rule)
//
//   GET    /api/student/units/:unitId/team-requests
//          → 200 [{
//              request_id, state, expires_at, created_at, resolved_at,
//              initiator_id,
//              source_team_id, source_team_name,
//              target_team_id, target_team_name,
//              my_response ('pending'|'accept'|'decline'), my_seen_at,
//              invalidated_reason,
//              tally: { accepted, declined, pending }
//            }]
//
//   GET    /api/student/units/:unitId/team-requests/:id
//          → 200 { request, responses: [{ student_id, name, response, responded_at, seen_at }] }
//
//   PATCH  /api/student/units/:unitId/team-requests/:id/respond   body: { response: 'accept'|'decline' }
//          → 200 { requestId, state, resolved }
//
//   PATCH  /api/student/units/:unitId/team-requests/:id/seen
//          → 200 { ok: true }
//
// =============================================================================

const crypto = require('crypto');
const { parseTeamSizesCsv } = require('../utils/teamSizes');
const { validateTeam } = require('../utils/teamValidator');
const ServiceError = require('./ServiceError');

// Tunable — how long a request stays open before it lapses. Reaching this
// deadline without unanimous acceptance expires the request; the teams never join.
const REQUEST_TIMEOUT_MS = 48 * 60 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

const RESPONSE_TO_VOTE = { accept: 'yes', decline: 'no' };
const VOTE_TO_RESPONSE = { yes: 'accept', no: 'decline', pending: 'pending' };

class TeamRequestService {
  // `teams` and `units` are what the rule check reads: the combined member
  // set of both teams, and the unit's rules.
  constructor({ db, teams, units }) {
    this.db = db;
    this.teams = teams;
    this.units = units;
  }

  // Resolve every open request touching a team — used when the coordinator
  // finalises or dissolves it. resolveRequest sees the change and invalidates.
  resolveOpenForTeam(teamId) {
    const inflight = this.db.all(
      `SELECT proposal_id FROM proposals
        WHERE state = 'open' AND (source_team_id = ? OR target_team_id = ?)`,
      [teamId, teamId]
    );
    for (const p of inflight) {
      try { this.resolveRequest(p.proposal_id); }
      catch (e) { console.error('Submit-time proposal resolve failed:', e.message); }
    }
  }

  getRequest(proposalId) {
    return this.db.get(`SELECT * FROM proposals WHERE proposal_id = ?`, [proposalId]);
  }

  getVotes(proposalId) {
    return this.db.all(`SELECT * FROM proposal_votes WHERE proposal_id = ?`, [proposalId]);
  }

  getAcceptedMemberIds(teamId) {
    return this.db.all(
      `SELECT student_id FROM unit_team_members WHERE team_id = ? AND status = 'ACCEPTED'`,
      [teamId]
    ).map(r => r.student_id);
  }

  getMaxTeamSize(unitId) {
    const unit = this.db.get(`SELECT valid_team_sizes FROM units WHERE unit_id = ?`, [unitId]);
    if (!unit) throw new ServiceError('Unit not found', 404);
    const sizes = parseTeamSizesCsv(unit.valid_team_sizes) || [4];
    return Math.max(...sizes);
  }

  // ── checkRequest ──────────────────────────────────────────────────────────
  // The preconditions for a merge, as data instead of as a throw.
  //
  // sendRequest calls this first and is the only thing that writes, so a UI
  // asking "could I ask to join that team?" before offering the button is
  // answered by these exact rules rather than by a second copy of them that
  // drifts the first time one of them changes.
  //
  // Read-only and cheap (four indexed lookups): safe to call once per card while
  // rendering a board.
  //
  // Returns { ok: true, sourceMembers, targetMembers, max }
  //      or { ok: false, code, reason, status } — `code` is for branching,
  //         `reason` is the message sendRequest throws verbatim.
  checkRequest({ unitId, sourceTeamId, targetTeamId, initiatorId }) {
    const no = (code, reason, status, extra) => ({ ok: false, code, reason, status, ...extra });

    if (!targetTeamId)
      return no('NO_TARGET', 'targetTeamId is required', 400);
    if (sourceTeamId === targetTeamId)
      return no('SELF', 'Source and target must be different teams', 400);

    const source = this.db.get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
      [sourceTeamId, unitId]);
    const target = this.db.get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
      [targetTeamId, unitId]);
    if (!source) return no('NO_SOURCE',      'Source team not found in this unit', 404);
    if (!target) return no('NO_TARGET_TEAM', 'Target team not found in this unit', 404);
    if (source.status === 'FINALISED' || target.status === 'FINALISED')
      return no('FINALISED', 'That team has been finalised by the coordinator', 400);

    const initiatorOk = this.db.get(
      `SELECT 1 AS ok FROM unit_team_members
        WHERE team_id = ? AND student_id = ? AND status = 'ACCEPTED'`,
      [sourceTeamId, initiatorId]
    );
    if (!initiatorOk)
      return no('NOT_MEMBER', 'You are not an accepted member of the source team', 403);

    const sourceMembers = this.getAcceptedMemberIds(sourceTeamId);
    const targetMembers = this.getAcceptedMemberIds(targetTeamId);
    const max = this.getMaxTeamSize(unitId);
    if (sourceMembers.length + targetMembers.length > max)
      return no('TOO_BIG', `Combined team size would exceed the max of ${max}`, 400, { max });

    // The unit's hard rules on the team the two would become. This is the
    // feedback loop: a student learns "no shared tutorial slot — Sam has no
    // availability saved" at the moment they act, not from a coordinator later.
    const violation = this._ruleViolation(unitId, sourceTeamId, targetTeamId);
    if (violation)
      return no('RULE', `${violation.rule} — ${violation.why}`, 400, { violation });

    const duplicate = this.db.get(
      `SELECT 1 AS ok FROM proposals
        WHERE state = 'open'
          AND ((source_team_id = ? AND target_team_id = ?)
            OR (source_team_id = ? AND target_team_id = ?))`,
      [sourceTeamId, targetTeamId, targetTeamId, sourceTeamId]
    );
    if (duplicate)
      return no('DUPLICATE', 'An open proposal between these teams already exists', 409);

    return { ok: true, sourceMembers, targetMembers, max };
  }

  // First hard-rule violation the combined team would have, or null. Members
  // are the ACCEPTED ones of both teams, with their current preferences.
  _ruleViolation(unitId, sourceTeamId, targetTeamId) {
    const unit = this.units.findById(unitId);
    if (!unit) return null;
    const combined = [
      ...this.teams.getMembersDetailed(unitId, sourceTeamId),
      ...this.teams.getMembersDetailed(unitId, targetTeamId)
    ].filter(m => m.status === 'ACCEPTED');
    const v = validateTeam(combined, unit, { tutorialFallback: true, includeAllAccepted: true });
    return v.violations[0] || null;
  }

  // ── sendRequest ─────────────────────────────────────────────────────────
  sendRequest({ unitId, sourceTeamId, targetTeamId, initiatorId }) {
    const check = this.checkRequest({ unitId, sourceTeamId, targetTeamId, initiatorId });
    if (!check.ok) throw new ServiceError(check.reason, check.status, check.code);
    const { sourceMembers, targetMembers } = check;

    const proposalId = crypto.randomUUID();
    const now = nowIso();
    // 48 h, or the unit's deadline if that comes first: a request sent 10 h
    // before the deadline is dead at the deadline, and the "expires in N hours"
    // warning must say so rather than promise two days.
    let expiresMs = Date.now() + REQUEST_TIMEOUT_MS;
    const unitRow = this.units.findById(unitId);
    const deadlineMs = unitRow && unitRow.deadline ? Date.parse(unitRow.deadline) : NaN;
    if (!isNaN(deadlineMs) && deadlineMs > Date.now() && deadlineMs < expiresMs) expiresMs = deadlineMs;
    const expiresAt = new Date(expiresMs).toISOString();

    this.db.tx(db => {
      db.run(
        `INSERT INTO proposals
           (proposal_id, unit_id, source_team_id, target_team_id, state,
            created_at, expires_at, initiator_id)
         VALUES (?,?,?,?,'open',?,?,?)`,
        [proposalId, unitId, sourceTeamId, targetTeamId, now, expiresAt, initiatorId]
      );
      const union = new Set([...sourceMembers, ...targetMembers]);
      for (const sid of union) {
        const isInitiator = sid === initiatorId;
        db.run(
          `INSERT INTO proposal_votes (proposal_id, student_id, vote, voted_at, seen_at)
           VALUES (?,?,?,?,?)`,
          [proposalId, sid,
           isInitiator ? 'yes' : 'pending',
           isInitiator ? now : null,
           isInitiator ? now : null]
        );
      }
    });

    // Defensive — a fresh proposal never resolves immediately, but stay consistent.
    return this.resolveRequest(proposalId, initiatorId);
  }

  // ── respondToRequest ───────────────────────────────────────────────────────────────
  respondToRequest({ proposalId, studentId, response }) {
    const vote = RESPONSE_TO_VOTE[response];
    if (!vote) throw new ServiceError('response must be "accept" or "decline"', 400);

    const proposal = this.getRequest(proposalId);
    if (!proposal) throw new ServiceError('Proposal not found', 404);
    if (proposal.state !== 'open')
      return { requestId: proposalId, state: proposal.state, resolved: true };

    const voteRow = this.db.get(
      `SELECT 1 AS ok FROM proposal_votes WHERE proposal_id = ? AND student_id = ?`,
      [proposalId, studentId]
    );
    if (!voteRow)
      throw new ServiceError('This request is not addressed to you', 403);

    const now = nowIso();
    this.db.run(
      `UPDATE proposal_votes SET vote = ?, voted_at = ?, seen_at = ?
        WHERE proposal_id = ? AND student_id = ?`,
      [vote, now, now, proposalId, studentId]
    );
    return this.resolveRequest(proposalId, studentId);
  }

  // ── markSeen ───────────────────────────────────────────────────────────────
  markRequestSeen({ proposalId, studentId }) {
    this.db.run(
      `UPDATE proposal_votes SET seen_at = ?
        WHERE proposal_id = ? AND student_id = ? AND seen_at IS NULL`,
      [nowIso(), proposalId, studentId]
    );
  }

  // ── resolveRequest — single source of truth ─────────────────────────────────
  // Only unanimous, explicit consent merges two teams. Running out the clock
  // lets the proposal lapse; silence is NOT consent.
  //
  // Branches (in order):
  //   1. Already terminal          → no-op.
  //   2. Any vote='no'             → reject.
  //   3. Not allYes AND expired    → expire (nothing is mutated).
  //   4. Not allYes AND not expired→ leave open.
  //   5. allYes AND a team is FINALISED or a rule now fails → invalidate.
  //   6. allYes                    → approve + execute merge.
  resolveRequest(proposalId, actingVoter = null) {
    const proposal = this.getRequest(proposalId);
    if (!proposal) throw new ServiceError('Proposal not found', 404);
    if (proposal.state !== 'open')
      return { requestId: proposalId, state: proposal.state, resolved: true };

    const votes = this.getVotes(proposalId);
    const hasNo = votes.some(v => v.vote === 'no');
    const allYes = votes.length > 0 && votes.every(v => v.vote === 'yes');
    const expired = Date.parse(proposal.expires_at) <= Date.now();
    const now = nowIso();

    // 2. Explicit no → reject.
    if (hasNo) {
      this.db.tx(db => {
        db.run(
          `UPDATE proposals SET state = 'rejected', resolved_at = ? WHERE proposal_id = ?`,
          [now, proposalId]
        );
        this.resetSeenAtExceptActor(db, proposalId, actingVoter);
      });
      return { requestId: proposalId, state: 'rejected', resolved: true };
    }

    // 3/4. Without unanimous consent the deadline lapses the proposal rather
    // than merging. allYes is checked first so a proposal that became unanimous
    // just before the sweep still merges instead of being killed by the clock.
    if (!allYes) {
      if (!expired)
        return { requestId: proposalId, state: 'open', resolved: false };

      // Expired → no team is mutated, so team status is irrelevant here.
      this.db.tx(db => {
        db.run(
          `UPDATE proposals SET state = 'expired', resolved_at = ? WHERE proposal_id = ?`,
          [now, proposalId]
        );
        this.resetSeenAtExceptActor(db, proposalId, actingVoter);
      });
      return { requestId: proposalId, state: 'expired', resolved: true };
    }

    // 5. Everyone accepted, but a team was finalised meanwhile, or the two
    //    would now break a rule (preferences moved since the request was
    //    sent) → invalidate, recording why so the notification can say.
    const source = this.db.get(`SELECT status FROM unit_teams WHERE team_id = ?`,
      [proposal.source_team_id]);
    const target = this.db.get(`SELECT status FROM unit_teams WHERE team_id = ?`,
      [proposal.target_team_id]);
    let invalidReason = null;
    if (!source || !target) invalidReason = 'One of the teams no longer exists';
    else if (source.status === 'FINALISED' || target.status === 'FINALISED')
      invalidReason = 'A team was finalised by the coordinator';
    else {
      const v = this._ruleViolation(proposal.unit_id, proposal.source_team_id, proposal.target_team_id);
      if (v) invalidReason = `${v.rule} — ${v.why}`;
    }
    if (invalidReason) {
      this.db.tx(db => {
        db.run(
          `UPDATE proposals SET state = 'invalidated', resolved_at = ?, invalidated_reason = ?
            WHERE proposal_id = ?`,
          [now, invalidReason, proposalId]
        );
        this.resetSeenAtExceptActor(db, proposalId, actingVoter);
      });
      return { requestId: proposalId, state: 'invalidated', resolved: true, reason: invalidReason };
    }

    // 6. Approve + merge + auto-cancel conflicts — all in one transaction.
    this.db.tx(db => {
      this.joinTeams(db, proposal, proposalId, now, actingVoter);
    });

    return { requestId: proposalId, state: 'approved', resolved: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MERGE IDENTITY RULE
  // On approval, the team with the LOWER team_number survives; the other team's
  // row is deleted and its members are UPDATEd to the surviving team_id.
  // (team_number is unique per unit, so ties don't occur.)
  // ───────────────────────────────────────────────────────────────────────────
  joinTeams(db, proposal, proposalId, now, actingVoter) {
    const src = this.db.get(`SELECT team_number FROM unit_teams WHERE team_id = ?`,
      [proposal.source_team_id]);
    const tgt = this.db.get(`SELECT team_number FROM unit_teams WHERE team_id = ?`,
      [proposal.target_team_id]);
    const srcNum = src?.team_number ?? Infinity;
    const tgtNum = tgt?.team_number ?? Infinity;

    // Lower team_number wins.
    const winner = (srcNum <= tgtNum) ? proposal.source_team_id : proposal.target_team_id;
    const loser  = (winner === proposal.source_team_id)
      ? proposal.target_team_id
      : proposal.source_team_id;

    // MUST be read before the UPDATE below moves everyone onto the winning
    // team — afterwards the two memberships are indistinguishable, and the
    // losing team row is gone entirely. This is the only moment at which
    // "who merged away" is still answerable.
    const winnerMembers = this.getAcceptedMemberIds(winner);
    const loserMembers  = this.getAcceptedMemberIds(loser);

    db.run(`UPDATE unit_team_members SET team_id = ? WHERE team_id = ?`, [winner, loser]);
    db.run(`DELETE FROM unit_teams WHERE team_id = ?`, [loser]);
    db.run(
      `UPDATE proposals SET state = 'approved', resolved_at = ? WHERE proposal_id = ?`,
      [now, proposalId]
    );

    // Everyone on both sides is now in a group of 2+. A "place me anywhere"
    // declaration made while alone no longer describes what they want, and a
    // stale declaration shown as current intent is worse than none. Raw handle:
    // this runs inside the merge transaction, so it commits or rolls back with it.
    const everyone = [...winnerMembers, ...loserMembers];
    if (everyone.length) {
      db.run(
        `UPDATE unit_students SET no_preference_at = ''
          WHERE unit_id = ? AND student_id IN (${everyone.map(() => '?').join(',')})`,
        [proposal.unit_id, ...everyone]
      );
    }

    // Auto-cancel every other open proposal touching either team — same tx.
    const conflicts = this.db.all(
      `SELECT proposal_id, source_team_id, target_team_id FROM proposals
        WHERE state = 'open' AND proposal_id <> ?
          AND (source_team_id IN (?, ?) OR target_team_id IN (?, ?))`,
      [proposalId, winner, loser, winner, loser]
    );

    for (const c of conflicts) {
      // Attribute the cancellation to the side of THIS proposal that took part
      // in the merge, so each viewer's row can say "you" or name the others.
      // A union rather than a lookup: if a proposal ever touched both teams it
      // should name everyone rather than silently name nobody.
      const movers = new Set();
      if (c.source_team_id === winner || c.target_team_id === winner)
        winnerMembers.forEach(id => movers.add(id));
      if (c.source_team_id === loser || c.target_team_id === loser)
        loserMembers.forEach(id => movers.add(id));

      // superseded_by names the request that won. The email dispatcher uses
      // it to tell a student who also got the winner's "accepted" email (skip
      // the cancellation) from one who only lost (send it).
      db.run(
        `UPDATE proposals SET state = 'auto_cancelled', resolved_at = ?,
                cancelled_by_student_ids = ?, superseded_by = ?
          WHERE proposal_id = ?`,
        [now, [...movers].join(','), proposalId, c.proposal_id]
      );
      db.run(`UPDATE proposal_votes SET seen_at = NULL WHERE proposal_id = ?`, [c.proposal_id]);
    }

    this.resetSeenAtExceptActor(db, proposalId, actingVoter);
  }

  resetSeenAtExceptActor(db, proposalId, actingVoter) {
    if (actingVoter) {
      db.run(
        `UPDATE proposal_votes SET seen_at = NULL
          WHERE proposal_id = ? AND student_id <> ?`,
        [proposalId, actingVoter]
      );
    } else {
      db.run(`UPDATE proposal_votes SET seen_at = NULL WHERE proposal_id = ?`, [proposalId]);
    }
  }

  // ── sweepExpired ─────────────────────────────────────────────────────────────
  sweepExpired() {
    const expired = this.db.all(
      `SELECT proposal_id FROM proposals WHERE state = 'open' AND expires_at <= ?`,
      [nowIso()]
    );
    let count = 0;
    for (const row of expired) {
      try {
        this.resolveRequest(row.proposal_id);
        count++;
      } catch (e) {
        console.error(`Proposal sweep failed for ${row.proposal_id}:`, e.message);
      }
    }
    return count;
  }

  // ── invalidateRequestsForStudent ──────────────────────────────────────────
  // Called when a student leaves their team or is kicked. Flips every open
  // proposal they're in to 'invalidated'. The acting student keeps their seen_at;
  // everyone else gets a fresh badge.
  invalidateRequestsForStudent(studentId) {
    const affected = this.db.all(
      `SELECT DISTINCT p.proposal_id FROM proposals p
         INNER JOIN proposal_votes pv ON pv.proposal_id = p.proposal_id
        WHERE p.state = 'open' AND pv.student_id = ?`,
      [studentId]
    ).map(r => r.proposal_id);
    if (!affected.length) return;

    const now = nowIso();
    this.db.tx(db => {
      for (const pid of affected) {
        db.run(
          `UPDATE proposals SET state = 'invalidated', resolved_at = ? WHERE proposal_id = ?`,
          [now, pid]
        );
        db.run(
          `UPDATE proposal_votes SET seen_at = NULL
            WHERE proposal_id = ? AND student_id <> ?`,
          [pid, studentId]
        );
      }
    });
  }

  // Resolve `cancelled_by_student_ids` into [{ student_id, name }] for a set of
  // proposal rows, with ONE lookup for all of them. Shared by the list and the
  // detail endpoint so a row and its popup can never name different people.
  attachCancelledBy(unitId, rows) {
    const ids = new Set();
    for (const r of rows) {
      (r.cancelled_by_student_ids || '').split(',').filter(Boolean).forEach(id => ids.add(id));
    }
    let names = new Map();
    if (ids.size) {
      const placeholders = [...ids].map(() => '?').join(',');
      names = new Map(
        this.db.all(
          `SELECT student_id, name FROM unit_students
            WHERE unit_id = ? AND student_id IN (${placeholders})`,
          [unitId, ...ids]
        ).map(r => [r.student_id, r.name])
      );
    }
    return rows.map(r => ({
      ...r,
      cancelled_by: (r.cancelled_by_student_ids || '').split(',').filter(Boolean)
        .map(id => ({ student_id: id, name: names.get(id) || id }))
    }));
  }

  // Called for units whose deadline has passed. Voting is already blocked by
  // then, but leaving proposals `open` would keep the dashboard showing a live
  // "auto-declines in Nh" countdown for something that can no longer resolve.
  // Everyone's seen_at is cleared so the outcome surfaces once.
  invalidateOpenForUnit(unitId) {
    const open = this.db.all(
      `SELECT proposal_id FROM proposals WHERE unit_id = ? AND state = 'open'`,
      [unitId]
    ).map(r => r.proposal_id);
    if (!open.length) return 0;

    const now = nowIso();
    this.db.tx(db => {
      for (const pid of open) {
        db.run(
          `UPDATE proposals SET state = 'invalidated', resolved_at = ? WHERE proposal_id = ?`,
          [now, pid]
        );
        db.run(`UPDATE proposal_votes SET seen_at = NULL WHERE proposal_id = ?`, [pid]);
      }
    });
    return open.length;
  }

  // ── listRequestsForStudent ─────────────────────────────────────────────────
  // Returns: every OPEN proposal the student is in, plus terminal proposals
  // with my_seen_at IS NULL (so the user can ack a recent outcome).
  listRequestsForStudent(unitId, studentId) {
    const rows = this.db.all(
      `SELECT p.proposal_id, p.state, p.expires_at, p.created_at, p.resolved_at,
              p.initiator_id, p.cancelled_by_student_ids, p.invalidated_reason,
              p.source_team_id, ts.team_name AS source_team_name,
              p.target_team_id, tt.team_name AS target_team_name,
              pv.vote AS my_vote, pv.seen_at AS my_seen_at,
              (SELECT COUNT(*) FROM proposal_votes
                WHERE proposal_id = p.proposal_id AND vote = 'yes')     AS yes_count,
              (SELECT COUNT(*) FROM proposal_votes
                WHERE proposal_id = p.proposal_id AND vote = 'no')      AS no_count,
              (SELECT COUNT(*) FROM proposal_votes
                WHERE proposal_id = p.proposal_id AND vote = 'pending') AS pending_count
         FROM proposals p
         INNER JOIN proposal_votes pv
           ON pv.proposal_id = p.proposal_id AND pv.student_id = ?
         LEFT JOIN unit_teams ts ON ts.team_id = p.source_team_id
         LEFT JOIN unit_teams tt ON tt.team_id = p.target_team_id
        WHERE p.unit_id = ?
          AND (p.state = 'open' OR pv.seen_at IS NULL)
        ORDER BY p.created_at DESC`,
      [studentId, unitId]
    );
    return this.attachCancelledBy(unitId, rows).map(r => ({
      request_id: r.proposal_id,
      proposal_id: r.proposal_id,   // legacy alias, one release
      state: r.state,
      invalidated_reason: r.invalidated_reason || null,
      expires_at: r.expires_at,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      initiator_id: r.initiator_id,
      source_team_id: r.source_team_id,
      source_team_name: r.source_team_name,
      target_team_id: r.target_team_id,
      target_team_name: r.target_team_name,
      my_response: VOTE_TO_RESPONSE[r.my_vote] || r.my_vote,
      my_seen_at: r.my_seen_at,
      cancelled_by: r.cancelled_by,
      tally: { accepted: r.yes_count, declined: r.no_count, pending: r.pending_count }
    }));
  }

  // ── getRequestDetail ───────────────────────────────────────────────────────
  getRequestDetail(unitId, proposalId, studentId) {
    const proposal = this.db.get(
      `SELECT p.*, ts.team_name AS source_team_name, tt.team_name AS target_team_name
         FROM proposals p
         LEFT JOIN unit_teams ts ON ts.team_id = p.source_team_id
         LEFT JOIN unit_teams tt ON tt.team_id = p.target_team_id
        WHERE p.proposal_id = ? AND p.unit_id = ?`,
      [proposalId, unitId]
    );
    if (!proposal) throw new ServiceError('Proposal not found', 404);

    const myVote = this.db.get(
      `SELECT 1 AS ok FROM proposal_votes WHERE proposal_id = ? AND student_id = ?`,
      [proposalId, studentId]
    );
    if (!myVote) throw new ServiceError('You are not in this proposal', 403);

    const votes = this.db.all(
      `SELECT pv.student_id, pv.vote, pv.voted_at, pv.seen_at, us.name
         FROM proposal_votes pv
         LEFT JOIN unit_students us
           ON us.unit_id = ? AND us.student_id = pv.student_id
        WHERE pv.proposal_id = ?
        ORDER BY (pv.voted_at IS NULL), pv.voted_at`,
      [unitId, proposalId]
    );
    // Same helper as the list, so the popup names exactly who the row names.
    const request = this.attachCancelledBy(unitId, [proposal])[0];
    return {
      request: { ...request, request_id: request.proposal_id },
      responses: votes.map(v => ({
        student_id: v.student_id, name: v.name, seen_at: v.seen_at,
        response: VOTE_TO_RESPONSE[v.vote] || v.vote, responded_at: v.voted_at
      }))
    };
  }
}

TeamRequestService.REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
module.exports = TeamRequestService;
