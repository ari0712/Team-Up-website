// The optional free-text "About Me" prompts on a student's profile.
//
// One definition drives everything: the schema migration that creates the
// columns, the repository that writes them, the service that validates them,
// and — because the profile endpoint returns this list with the values attached
// — the page that renders them. Adding or rewording a prompt is a change here
// and nowhere else.
//
// The columns live on `student_unit_prefs` (per unit, not per account) because
// four of the prompts ask about THIS capstone specifically.
const ABOUT_FIELDS = [
  { key: 'about_meeting_mode',       label: 'Ability to meet in-person or only through Zoom' },
  { key: 'about_it_skills',          label: 'My current skills in IT' },
  { key: 'about_experience',         label: 'My other relevant experience' },
  { key: 'about_other_interests',    label: 'My other interests' },
  { key: 'about_commitment',         label: 'My expectations about commitment to this IT Capstone' },
  { key: 'about_goals',              label: 'My goals and aspirations for this IT Capstone experience' },
  { key: 'about_proposal_interests', label: "My interests in this semester's IT Project Proposals" },
];

const ABOUT_COLUMNS = ABOUT_FIELDS.map(f => f.key);

// Generous enough for several paragraphs, small enough that seven of them can
// never bloat a row. Enforced on the server; the textareas also carry it.
const ABOUT_MAX_LENGTH = 2000;

module.exports = { ABOUT_FIELDS, ABOUT_COLUMNS, ABOUT_MAX_LENGTH };
