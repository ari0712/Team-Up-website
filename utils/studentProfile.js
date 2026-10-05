const { ABOUT_FIELDS } = require('./aboutFields');

// The one shape a student profile is returned in, whoever is asking.
//
// Two callers with different access rules read it: a student looking at
// themselves or a classmate (StudentPortalService.getStudentProfile), and a
// teacher looking at someone in a unit they own (UnitService.getStudentProfile).
// Keeping the shape here means the teacher page and the student page can never
// drift into rendering different fields from the same data.
//
// `includeEmail` is the caller's decision, not this function's: a classmate
// never gets an address, but a teacher already has every address in the class
// list and the export, so withholding it here would be theatre.
function buildStudentProfile({ studentId, name, prefs = {}, account, isSelf = false, includeEmail = false }) {
  return {
    studentId,
    isSelf,
    name: name || studentId,
    ...(includeEmail ? { email: account?.email || '' } : {}),

    avatarPath: account?.avatarPath || '',
    preferredRole: prefs.preferred_role || '',
    tutorialSlots: prefs.tutorial_slots || '',
    projectInterests: prefs.project_interests || '',
    skills: prefs.skills || '',
    about: ABOUT_FIELDS.map(f => ({ ...f, value: prefs[f.key] || '' })),
  };
}

module.exports = { buildStudentProfile };
