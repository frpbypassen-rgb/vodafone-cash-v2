'use strict';

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const appendAdminNote = (tx, note) => {
    tx.adminNotes = appendNoteText(tx.adminNotes, note);
};

const appendCustomerReference = (tx, label, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return;
    const line = `[${label}: ${cleanValue}]`;
    if (!String(tx.notes || '').includes(line)) {
        tx.notes = appendNoteText(tx.notes, line);
    }
};

module.exports = { appendAdminNote, appendCustomerReference };
