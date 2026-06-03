// =============================================================================
// proposalService — unified merge-proposal model.
//
// Replaces the old "student-to-student invite" flow. Every student is a team
// (size-1 by default, eager-created on unit join). Every join action is a
// vote-gated merge proposal between two teams.
//
// API SHAPES (consumed by the frontend):
//
//   POST   /api/student/units/:unitId/proposals     body: { targetTeamId }
//          → 200 { proposalId, state }
//          → 400/403/404/409 on validation
//
//   GET    /api/student/units/:unitId/proposals
//          → 200 [{
//              proposal_id, state, expires_at, created_at, resolved_at,
//              initiator_id,
//              source_team_id, source_team_name,
//              target_team_id, target_team_name,
//              my_vote, my_seen_at,
//              tally: { yes, no, pending }
//            }]
//
//   GET    /api/student/units/:unitId/proposals/:id
//          → 200 { proposal, votes: [{ student_id, name, vote, voted_at, seen_at }] }
//
//   PATCH  /api/student/units/:unitId/proposals/:id/vote   body: { vote: 'yes'|'no' }
//          → 200 { proposalId, state, resolved }
//
//   PATCH  /api/student/units/:unitId/proposals/:id/seen
//          → 200 { ok: true }
//
// =============================================================================

const crypto = require('crypto');
const { get, all, run, tx } = require('../db');
const { parseTeamSizesCsv } = require('../utils/teamSizes');

// Tunable — the proposal lifetime before timeout auto-approval kicks in.
const PROPOSAL_TIMEOUT_MS = 48 * 60 * 60 * 1000;

class ServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function nowIso() { return new Date().toISOString(); }

function getProposal(proposalId) {
  return get(`SELECT * FROM proposals WHERE proposal_id = ?`, [proposalId]);
}

function getVotes(proposalId) {
  return all(`SELECT * FROM proposal_votes WHERE proposal_id = ?`, [proposalId]);
}

function getAcceptedMemberIds(teamId) {
  return all(
    `SELECT student_id FROM unit_team_members WHERE team_id = ? AND status = 'ACCEPTED'`,
    [teamId]
  ).map(r => r.student_id);
}

function getMaxTeamSize(unitId) {
  const unit = get(`SELECT valid_team_sizes FROM units WHERE unit_id = ?`, [unitId]);
  if (!unit) throw new ServiceError('Unit not found', 404);
  const sizes = parseTeamSizesCsv(unit.valid_team_sizes) || [4];
  return Math.max(...sizes);
}

// ── createProposal ───────────────────────────────────────────────────────────
function createProposal({ unitId, sourceTeamId, targetTeamId, initiatorId }) {
  if (!targetTeamId)
    throw new ServiceError('targetTeamId is required', 400);
  if (sourceTeamId === targetTeamId)
    throw new ServiceError('Source and target must be different teams', 400);

  const source = get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
    [sourceTeamId, unitId]);
  const target = get(`SELECT * FROM unit_teams WHERE team_id = ? AND unit_id = ?`,
    [targetTeamId, unitId]);
  if (!source) throw new ServiceError('Source team not found in this unit', 404);
  if (!target) throw new ServiceError('Target team not found in this unit', 404);
  if (source.status !== 'FORMING' || target.status !== 'FORMING')
    throw new ServiceError('Both teams must be in FORMING state', 400);

  const initiatorOk = get(
    `SELECT 1 AS ok FROM unit_team_members
      WHERE team_id = ? AND student_id = ? AND status = 'ACCEPTED'`,
    [sourceTeamId, initiatorId]
  );
  if (!initiatorOk)
    throw new ServiceError('You are not an accepted member of the source team', 403);

  const sourceMembers = getAcceptedMemberIds(sourceTeamId);
  const targetMembers = getAcceptedMemberIds(targetTeamId);
  const max = getMaxTeamSize(unitId);
  if (sourceMembers.length + targetMembers.length > max)
    throw new ServiceError(`Combined team size would exceed the max of ${max}`, 400);

  const duplicate = get(
    `SELECT 1 AS ok FROM proposals
      WHERE state = 'open'
        AND ((source_team_id = ? AND target_team_id = ?)
          OR (source_team_id = ? AND target_team_id = ?))`,
    [sourceTeamId, targetTeamId, targetTeamId, sourceTeamId]
  );
  if (duplicate)
    throw new ServiceError('An open proposal between these teams already exists', 409);

  const proposalId = crypto.randomUUID();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + PROPOSAL_TIMEOUT_MS).toISOString();

  tx(db => {
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
  return resolveProposal(proposalId, initiatorId);
}

// ── castVote ─────────────────────────────────────────────────────────────────
function castVote({ proposalId, studentId, vote }) {
  if (!['yes', 'no'].includes(vote))
    throw new ServiceError('vote must be "yes" or "no"', 400);

  const proposal = getProposal(proposalId);
  if (!proposal) throw new ServiceError('Proposal not found', 404);
  if (proposal.state !== 'open')
    return { proposalId, state: proposal.state, resolved: true };

  const voteRow = get(
    `SELECT 1 AS ok FROM proposal_votes WHERE proposal_id = ? AND student_id = ?`,
    [proposalId, studentId]
  );
  if (!voteRow)
    throw new ServiceError("You are not in this proposal's approver set", 403);

  const now = nowIso();
  run(
    `UPDATE proposal_votes SET vote = ?, voted_at = ?, seen_at = ?
      WHERE proposal_id = ? AND student_id = ?`,
    [vote, now, now, proposalId, studentId]
  );
  return resolveProposal(proposalId, studentId);
}

// ── markSeen ─────────────────────────────────────────────────────────────────
function markSeen({ proposalId, studentId }) {
  run(
    `UPDATE proposal_votes SET seen_at = ?
      WHERE proposal_id = ? AND student_id = ? AND seen_at IS NULL`,
    [nowIso(), proposalId, studentId]
  );
}

// ── resolveProposal — single source of truth ─────────────────────────────────
// Branches (in order):
//   1. Already terminal       → no-op.
//   2. Any vote='no'          → reject.
//   3. Approve conditions met AND a team is no longer FORMING → invalidate.
//   4. allYes OR (expired AND !hasNo) → approve + execute merge.
//   5. else → leave open.
function resolveProposal(proposalId, actingVoter = null) {
  const proposal = getProposal(proposalId);
  if (!proposal) throw new ServiceError('Proposal not found', 404);
  if (proposal.state !== 'open')
    return { proposalId, state: proposal.state, resolved: true };

  const votes = getVotes(proposalId);
  const hasNo = votes.some(v => v.vote === 'no');
  const allYes = votes.length > 0 && votes.every(v => v.vote === 'yes');
  const expired = Date.parse(proposal.expires_at) <= Date.now();
  const now = nowIso();

  // 2. Explicit no → reject.
  if (hasNo) {
    tx(db => {
      db.run(
        `UPDATE proposals SET state = 'rejected', resolved_at = ? WHERE proposal_id = ?`,
        [now, proposalId]
      );
      resetSeenAtExceptActor(db, proposalId, actingVoter);
    });
    return { proposalId, state: 'rejected', resolved: true };
  }

  const shouldApprove = allYes || (expired && !hasNo);
  if (!shouldApprove)
    return { proposalId, state: 'open', resolved: false };

  // 3. Approving, but a team has left FORMING (e.g., submitted) → invalidate.
  const source = get(`SELECT status FROM unit_teams WHERE team_id = ?`,
    [proposal.source_team_id]);
  const target = get(`SELECT status FROM unit_teams WHERE team_id = ?`,
    [proposal.target_team_id]);
  if (!source || !target ||
      source.status !== 'FORMING' || target.status !== 'FORMING') {
    tx(db => {
      db.run(
        `UPDATE proposals SET state = 'invalidated', resolved_at = ? WHERE proposal_id = ?`,
        [now, proposalId]
      );
      resetSeenAtExceptActor(db, proposalId, actingVoter);
    });
    return { proposalId, state: 'invalidated', resolved: true };
  }

  // 4. Approve + merge + auto-cancel conflicts — all in one transaction.
  tx(db => {
    executeMerge(db, proposal, proposalId, now, actingVoter);
  });

  return { proposalId, state: 'approved', resolved: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE IDENTITY RULE
// On approval, the team with the LOWER team_number survives; the other team's
// row is deleted and its members are UPDATEd to the surviving team_id.
// (team_number is unique per unit, so ties don't occur.)
// ─────────────────────────────────────────────────────────────────────────────
function executeMerge(db, proposal, proposalId, now, actingVoter) {
  const src = get(`SELECT team_number FROM unit_teams WHERE team_id = ?`,
    [proposal.source_team_id]);
  const tgt = get(`SELECT team_number FROM unit_teams WHERE team_id = ?`,
    [proposal.target_team_id]);
  const srcNum = src?.team_number ?? Infinity;
  const tgtNum = tgt?.team_number ?? Infinity;

  // Lower team_number wins.
  const winner = (srcNum <= tgtNum) ? proposal.source_team_id : proposal.target_team_id;
  const loser  = (winner === proposal.source_team_id)
    ? proposal.target_team_id
    : proposal.source_team_id;

  db.run(`UPDATE unit_team_members SET team_id = ? WHERE team_id = ?`, [winner, loser]);
  db.run(`DELETE FROM unit_teams WHERE team_id = ?`, [loser]);
  db.run(
    `UPDATE proposals SET state = 'approved', resolved_at = ? WHERE proposal_id = ?`,
    [now, proposalId]
  );

  // Auto-cancel every other open proposal touching either team — same tx.
  const conflictIds = all(
    `SELECT proposal_id FROM proposals
      WHERE state = 'open' AND proposal_id <> ?
        AND (source_team_id IN (?, ?) OR target_team_id IN (?, ?))`,
    [proposalId, winner, loser, winner, loser]
  ).map(r => r.proposal_id);

  for (const cid of conflictIds) {
    db.run(
      `UPDATE proposals SET state = 'auto_cancelled', resolved_at = ? WHERE proposal_id = ?`,
      [now, cid]
    );
    db.run(`UPDATE proposal_votes SET seen_at = NULL WHERE proposal_id = ?`, [cid]);
  }

  resetSeenAtExceptActor(db, proposalId, actingVoter);
}

function resetSeenAtExceptActor(db, proposalId, actingVoter) {
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
function sweepExpired() {
  const expired = all(
    `SELECT proposal_id FROM proposals WHERE state = 'open' AND expires_at <= ?`,
    [nowIso()]
  );
  let count = 0;
  for (const row of expired) {
    try {
      resolveProposal(row.proposal_id);
      count++;
    } catch (e) {
      console.error(`Proposal sweep failed for ${row.proposal_id}:`, e.message);
    }
  }
  return count;
}

// ── invalidateProposalsForStudent ────────────────────────────────────────────
// Called when a student leaves their team or is kicked. Flips every open
// proposal they're in to 'invalidated'. The acting student keeps their seen_at;
// everyone else gets a fresh badge.
function invalidateProposalsForStudent(studentId) {
  const affected = all(
    `SELECT DISTINCT p.proposal_id FROM proposals p
       INNER JOIN proposal_votes pv ON pv.proposal_id = p.proposal_id
      WHERE p.state = 'open' AND pv.student_id = ?`,
    [studentId]
  ).map(r => r.proposal_id);
  if (!affected.length) return;

  const now = nowIso();
  tx(db => {
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

// ── listProposalsForStudent ──────────────────────────────────────────────────
// Returns: every OPEN proposal the student is in, plus terminal proposals
// with my_seen_at IS NULL (so the user can ack a recent outcome).
function listProposalsForStudent(unitId, studentId) {
  const rows = all(
    `SELECT p.proposal_id, p.state, p.expires_at, p.created_at, p.resolved_at,
            p.initiator_id,
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
  return rows.map(r => ({
    proposal_id: r.proposal_id,
    state: r.state,
    expires_at: r.expires_at,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    initiator_id: r.initiator_id,
    source_team_id: r.source_team_id,
    source_team_name: r.source_team_name,
    target_team_id: r.target_team_id,
    target_team_name: r.target_team_name,
    my_vote: r.my_vote,
    my_seen_at: r.my_seen_at,
    tally: { yes: r.yes_count, no: r.no_count, pending: r.pending_count }
  }));
}

// ── getProposalDetail ────────────────────────────────────────────────────────
function getProposalDetail(unitId, proposalId, studentId) {
  const proposal = get(
    `SELECT p.*, ts.team_name AS source_team_name, tt.team_name AS target_team_name
       FROM proposals p
       LEFT JOIN unit_teams ts ON ts.team_id = p.source_team_id
       LEFT JOIN unit_teams tt ON tt.team_id = p.target_team_id
      WHERE p.proposal_id = ? AND p.unit_id = ?`,
    [proposalId, unitId]
  );
  if (!proposal) throw new ServiceError('Proposal not found', 404);

  const myVote = get(
    `SELECT 1 AS ok FROM proposal_votes WHERE proposal_id = ? AND student_id = ?`,
    [proposalId, studentId]
  );
  if (!myVote) throw new ServiceError('You are not in this proposal', 403);

  const votes = all(
    `SELECT pv.student_id, pv.vote, pv.voted_at, pv.seen_at, us.name
       FROM proposal_votes pv
       LEFT JOIN unit_students us
         ON us.unit_id = ? AND us.student_id = pv.student_id
      WHERE pv.proposal_id = ?
      ORDER BY (pv.voted_at IS NULL), pv.voted_at`,
    [unitId, proposalId]
  );
  return { proposal, votes };
}

module.exports = {
  PROPOSAL_TIMEOUT_MS,
  ServiceError,
  createProposal,
  castVote,
  markSeen,
  resolveProposal,
  sweepExpired,
  invalidateProposalsForStudent,
  listProposalsForStudent,
  getProposalDetail,
};
