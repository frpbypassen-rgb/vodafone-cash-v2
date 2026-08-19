'use strict';

const { customerNoteFromTransaction } = require('./transactionNotes');

const EXECUTOR_LEDGER_MODELS = Object.freeze(['ExecutorBot', 'ExecutorGroup']);
const EXECUTOR_PRIVATE_FIELDS = Object.freeze([
    'executorGroupId',
    'managerGroupId',
    'originalApiGroupId',
    'executorGroupName',
    'operatorId',
    'operatorName',
    'executorName',
    'executorSenderPhone',
    'executorExecutionNumber',
    'executorExecutionNumberMasked',
    'manualExecutorReceiptReference',
    'executorBotId',
    'parentGroupId',
    'parentBotId',
    'isApiReview',
    'apiResultData',
    'executorWebAlert',
    'emergencyAlert',
    'broadcastMessages',
    'idempotencyKey',
    'idempotencyFingerprint',
    'idempotencyResponse',
    'editIdempotencyKey',
    'editIdempotencyFingerprint',
    'editIdempotencyResponse',
    'zaynpayIdempotencyKey',
    'zaynpayIdempotencyFingerprint',
    'zaynpayIdempotencyResponse',
    'adminNotes',
    'cancelledBy',
    'executorProofImages'
]);

const EXECUTOR_TEXT_PATTERN = /(?:منفذ|البوت|روبوت|رقم\s*المرسل|executor|operator|\bapi\b)/i;
const TRANSACTION_ARRAY_KEYS = Object.freeze([
    'completedOperations',
    'pendingOperations',
    'cancelledOperations',
    'deposits',
    'deductions',
    'pendingDeposits',
    'operations',
    'depositsAndDeductions',
    'currentTransactions'
]);

const plainObject = (value) => {
    if (!value) return {};
    if (typeof value.toObject === 'function') return value.toObject();
    return { ...value };
};

const defaultMovementDescription = (type) => ({
    DEPOSIT: 'إيداع رصيد',
    DEDUCTION: 'خصم رصيد',
    TRANSFER: 'تحويل مالي',
    COMMISSION: 'عمولة',
    REFUND: 'استرجاع مالي',
    REVERSAL: 'قيد عكسي'
}[type] || 'حركة مالية');

const sanitizeStatementText = (value, fallback = '') => {
    const text = String(value || '').replace(/---\s*سجل\s+الـ\s+API[\s\S]*$/i, '').trim();
    if (!text) return fallback;

    const reasonMatch = text.match(/(?:سبب\s*الإلغاء|السبب)\s*[:：]\s*([^|\]\r\n]+)/i);
    if (reasonMatch && !EXECUTOR_TEXT_PATTERN.test(reasonMatch[1])) {
        return reasonMatch[1].trim() || fallback;
    }

    const safeLines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !EXECUTOR_TEXT_PATTERN.test(line));

    return safeLines.join('\n').trim() || fallback;
};

const sanitizeStatementTransaction = (transaction = {}) => {
    const source = plainObject(transaction);
    const sanitized = { ...source };
    EXECUTOR_PRIVATE_FIELDS.forEach((field) => { delete sanitized[field]; });

    const customerNote = sanitizeStatementText(customerNoteFromTransaction(source));
    sanitized.notes = customerNote || undefined;
    sanitized.customerNotes = customerNote || undefined;

    // Only the system-generated receipt is visible in customer statements.
    const publicReceiptId = String(
        source.proofImage
        || (Array.isArray(source.proofImages) ? source.proofImages[0] : '')
        || ''
    ).trim();
    sanitized.proofImage = publicReceiptId || undefined;
    sanitized.proofImages = publicReceiptId ? [publicReceiptId] : [];

    if (source.cancellationReason) {
        sanitized.cancellationReason = sanitizeStatementText(source.cancellationReason, 'تم إلغاء العملية');
    }

    if (source.balanceAdjustment) {
        sanitized.balanceAdjustment = { ...source.balanceAdjustment };
        delete sanitized.balanceAdjustment.voidedBy;
        sanitized.balanceAdjustment.voidReason = sanitizeStatementText(
            source.balanceAdjustment.voidReason,
            source.balanceAdjustment.voidReason ? 'تم إلغاء الحركة المالية' : ''
        ) || undefined;
    }

    return sanitized;
};

const sanitizeStatementMovement = (movement = {}) => {
    const source = plainObject(movement);
    if (EXECUTOR_LEDGER_MODELS.includes(source.entityModel)) return null;

    const sanitized = {
        ...source,
        description: defaultMovementDescription(source.type)
    };
    delete sanitized.debitAccount;
    delete sanitized.creditAccount;
    return sanitized;
};

const sanitizeStatementChange = (change = {}) => {
    if (EXECUTOR_TEXT_PATTERN.test(String(change.action || ''))) return null;
    return {
        ...plainObject(change),
        actor: 'الإدارة',
        details: sanitizeStatementText(change.details, 'تم تعديل الحركة بعد الإقفال المالي')
    };
};

const isCustomerAccountStatement = (scope = {}) => (
    !['executor', 'api_executor'].includes(String(scope.mainCategory || ''))
);

const sanitizeAccountStatementReport = (report = {}) => {
    if (!isCustomerAccountStatement(report.scope)) return report;
    const sanitized = { ...report };

    if (report.stats && typeof report.stats === 'object') {
        sanitized.stats = { ...report.stats };
        delete sanitized.stats.isExecutor;
    }

    TRANSACTION_ARRAY_KEYS.forEach((key) => {
        if (Array.isArray(report[key])) {
            sanitized[key] = report[key].map(sanitizeStatementTransaction);
        }
    });
    sanitized.movements = (report.movements || [])
        .map(sanitizeStatementMovement)
        .filter(Boolean);
    sanitized.closedDayChanges = (report.closedDayChanges || [])
        .map(sanitizeStatementChange)
        .filter(Boolean);
    return sanitized;
};

module.exports = {
    EXECUTOR_LEDGER_MODELS,
    EXECUTOR_PRIVATE_FIELDS,
    EXECUTOR_TEXT_PATTERN,
    isCustomerAccountStatement,
    sanitizeAccountStatementReport,
    sanitizeStatementChange,
    sanitizeStatementMovement,
    sanitizeStatementText,
    sanitizeStatementTransaction
};
