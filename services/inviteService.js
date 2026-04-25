const inviteRepo = require('../repositories/inviteRepository');
const studentRepo = require('../repositories/studentRepository');
const teamService = require('./teamService');
const { v4: uuidv4 } = require('../utils/uuid');

function getInvitesForStudent(username) { return inviteRepo.findByReceiverUsername(username); }
function getSentInvites(username) { return inviteRepo.findBySenderUsername(username); }

function sendInvite(senderUsername, receiverUsername) {
  if (senderUsername === receiverUsername) return 'You cannot invite yourself.';
  if (inviteRepo.existsPending(senderUsername, receiverUsername))
    return 'You already have a pending invite to this student.';

  const sender = studentRepo.findByUsername(senderUsername);
  if (sender && sender.teamId) {
    const members = studentRepo.findByTeamId(sender.teamId);
    if (members.length >= 5) return 'Your team is already full (5 members).';
  }

  const receiver = studentRepo.findByUsername(receiverUsername);
  if (!receiver) return 'Student not found.';

  const now = new Date();
  const sentAt = now.toISOString().slice(0, 16).replace('T', ' ');
  inviteRepo.save({
    inviteId: uuidv4(),
    senderUsername, receiverUsername,
    sentAt, status: 'PENDING', rejectionReason: null
  });
  return null;
}

// Returns current teamId of receiver if already in a team (for warning), else null
function checkAcceptInvite(inviteId) {
  const invite = getInviteById(inviteId);
  if (!invite) return { error: 'Invite not found' };
  const receiver = studentRepo.findByUsername(invite.receiverUsername);
  if (!receiver) return { error: 'Receiver not found' };
  return { existingTeamId: receiver.teamId || null };
}

function confirmAcceptInvite(inviteId) {
  const invite = getInviteById(inviteId);
  if (!invite) return;
  inviteRepo.updateStatus(inviteId, 'ACCEPTED', null);

  let sender   = studentRepo.findByUsername(invite.senderUsername);
  let receiver = studentRepo.findByUsername(invite.receiverUsername);
  if (!sender || !receiver) return;

  if (receiver.teamId) {
    teamService.leaveTeam(receiver);
    receiver = studentRepo.findByUsername(invite.receiverUsername);
  }

  if (!sender.teamId) {
    const team = teamService.addStudentToNewTeam(sender);
    teamService.addStudentToTeam(receiver, team.teamId);
  } else {
    teamService.addStudentToTeam(receiver, sender.teamId);
  }
}

function rejectInvite(inviteId, reason) {
  inviteRepo.updateStatus(inviteId, 'REJECTED', reason);
}

function getInviteById(inviteId) {
  const { get } = require('../db');
  const row = get('SELECT * FROM team_invites WHERE invite_id = ?', [inviteId]);
  if (!row) return null;
  return {
    inviteId: row.invite_id, senderUsername: row.sender_username,
    receiverUsername: row.receiver_username, sentAt: row.sent_at,
    status: row.status, rejectionReason: row.rejection_reason
  };
}

module.exports = { getInvitesForStudent, getSentInvites, sendInvite, checkAcceptInvite, confirmAcceptInvite, rejectInvite };
