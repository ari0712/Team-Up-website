// A "Confirm" button beside every deadline picker.
//
// The browser's datetime-local popup has no OK button of its own — it only
// closes when the user clicks somewhere else, which reads as "did that take?".
// The button gives that click a home: it closes the picker, reads the value
// back in plain words ("Deadline set: Friday, 12 June 2026, 5:00 pm") and
// flags an empty pick instead of leaving the field blank without comment.
//
// It is feedback, not a gate: Create / Save still read the input directly, so
// a teacher who types a date and goes straight to Save is not blocked.

// Same wording the dashboard banner uses, so the two never disagree.
function formatDeadline(value) {
    const d = new Date(value);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-AU', { weekday: 'long', day: 'numeric', month: 'long',
                                       year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Wires input#inputId, button#buttonId and the note element#noteId together.
// Safe to call again on a re-opened dialog: handlers are replaced, not stacked.
function bindDeadlineConfirm(inputId, buttonId, noteId) {
    const input  = document.getElementById(inputId);
    const button = document.getElementById(buttonId);
    const note   = document.getElementById(noteId);

    const show = (kind, text) => {
        note.className = `t-deadline-note ${kind}`;
        note.textContent = text;
    };

    button.onclick = () => {
        if (!input.value) {
            show('error', 'Pick a date and time first.');
            input.focus();
            return;
        }
        input.blur();                       // closes the picker where it is still open
        show('ok', `Deadline set: ${formatDeadline(input.value)}`);
    };

    // Any later edit un-confirms, so the note never describes a stale value.
    input.oninput = () => show('pending', input.value ? 'Click Confirm to set this deadline.' : '');

    // A dialog that opens with a stored deadline shows it as already set.
    show(input.value ? 'ok' : 'pending', input.value ? `Deadline set: ${formatDeadline(input.value)}` : '');
}
