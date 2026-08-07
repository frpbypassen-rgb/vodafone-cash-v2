'use strict';

const SYSTEM_NOTE_PATTERNS = Object.freeze([
    /^سبب الرفض:/,
    /^\[تم /,
    /^\[فشل /,
    /^\[معلقة /,
    /^\[رقم الإلغاء:/,
    /^تحويل رصيد صادر إلى/,
    /^تحويل رصيد وارد من/,
    /^تمويل نقطة بيع/,
    /^سحب رصيد من نقطة بيع/,
    /^\[طلب وارد عبر API/
]);

const normalizeCustomerNote = (value, maxLength = 500) => String(value || '').trim().slice(0, maxLength);
const isExecutorReferenceLine = (line) => /رقم\s*المرسل|المنفذ|executor|operator/i.test(line);
const isCustomerReferenceLine = (line) => (
    !isExecutorReferenceLine(line)
    && /رقم المحول|الرقم المرجعي|مرجع|reference|ref/i.test(line)
);

const normalizeCustomerNoteInput = (body = {}, maxLength = 500) => normalizeCustomerNote(
    body.customerNotes ?? body.customerNote ?? body.clientNotes ?? body.clientNote ?? body.notes ?? body.note ?? '',
    maxLength
);

const extractLegacyCustomerNote = (notes) => {
    const raw = normalizeCustomerNote(notes, 10000);
    if (!raw) return '';
    const beforeApiLog = raw.split(/---\s*سجل\s+الـ\s+API/i)[0].trim();
    const legacyTransfer = beforeApiLog.match(/(?:تحويل رصيد صادر إلى|تحويل رصيد وارد من).*\|\s*(.+)$/s);
    if (legacyTransfer) return legacyTransfer[1].trim();

    return beforeApiLog
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => {
            if (isCustomerReferenceLine(line)) return true;
            return !SYSTEM_NOTE_PATTERNS.some((pattern) => pattern.test(line));
        })
        .join('\n')
        .trim();
};

const customerNoteFromTransaction = (transaction = {}) => {
    const explicitNote = normalizeCustomerNote(transaction.customerNotes, 10000);
    if (!explicitNote) return extractLegacyCustomerNote(transaction.notes);

    const lines = explicitNote.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    String(transaction.notes || '').split(/---\s*سجل\s+الـ\s+API/i)[0]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => isCustomerReferenceLine(line) && !lines.includes(line))
        .forEach((line) => lines.push(line));
    return lines.join('\n').trim();
};

module.exports = {
    SYSTEM_NOTE_PATTERNS,
    normalizeCustomerNote,
    normalizeCustomerNoteInput,
    isExecutorReferenceLine,
    isCustomerReferenceLine,
    extractLegacyCustomerNote,
    customerNoteFromTransaction
};
