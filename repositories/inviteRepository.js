const { all, get, run } = require('../db');

function mapInvite(row) {
  if (!row) return null;
  return {
    inviteId: row.invite_id,
    senderUsername: row.sender_username,
    receiverUsername: row.receiver_username,
    sentAt: row.sent_at,
    status: row.status,
    rejectionReason: row.rejection_reason
  };
}

function save(invite) {
  run(`INSERT INTO team_invites (invite_id, sender_username, receiver_username, sent_at, status, rejection_reason)
       VALUES (?,?,?,?,?,?)`,
    [invite.inviteId, invite.senderUsername, invite.receiverUsername,
     invite.sentAt, invite.status, invite.rejectionReason || null]);
}

function updateStatus(inviteId, status, rejectionReason) {
  run('UPDATE team_invites SET status=?, rejection_reason=? WHERE invite_id=?',
    [status, rejectionReason || null, inviteId]);
}

function findByReceiverUsername(username) {
  return all('SELECT * FROM team_invites WHERE receiver_username = ? ORDER BY sent_at DESC', [username]).map(mapInvite);
}

function findBySenderUsername(username) {
  return all('SELECT * FROM team_invites WHERE sender_username = ? ORDER BY sent_at DESC', [username]).map(mapInvite);
}

function existsPending(senderUsername, receiverUsername) {
  const row = get(`SELECT COUNT(*) as cnt FROM team_invites
    WHERE sender_username=? AND receiver_username=? AND status='PENDING'`,
    [senderUsername, receiverUsername]);
  return !!(row && row.cnt > 0);
}

module.exports = { save, updateStatus, findByReceiverUsername, findBySenderUsername, existsPending };
