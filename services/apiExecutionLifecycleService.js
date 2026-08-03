'use strict';

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { updateBalanceWithLedger } = require('./walletService');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');

const DEFAULT_API_COMPLETION_DELAY_MS = 25000;
const MONITOR_INTERVAL_MS = 5000;
let monitorTimer = null;

const getApiCompletionDelayMs = () => {
    const configured = Number(process.env.API_COMPLETION_DELAY_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_API_COMPLETION_DELAY_MS;
};

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

const getParentGroupId = (group) => group?.parentGroupId || group?.parentBotId || null;

const sameId = (left, right) => String(left || '') === String(right || '');

const resolveApiReferenceNumber = (apiResult = {}) => {
    let referenceNumber = apiResult.reference_number
        || apiResult.sender_number
        || apiResult.external_transaction_id
        || apiResult.provider_transaction_id
        || '';

    if (apiResult.processLog && !referenceNumber) {
        const refMatch = String(apiResult.processLog).match(/"RefTransactionNumber"\s*:\s*"([^"]+)"/);
        if (refMatch && refMatch[1]) referenceNumber = refMatch[1];
    }

    return String(referenceNumber || '').trim();
};

const prepareApiTransactionForDelayedCompletion = ({
    tx,
    executorGroup,
    apiResult,
    receiptProof,
    detailedLog
}) => {
    const referenceNumber = resolveApiReferenceNumber(apiResult);
    if (!referenceNumber) return null;

    const delayMs = getApiCompletionDelayMs();
    const autoCompleteAt = new Date(Date.now() + delayMs);

    tx.status = 'processing';
    tx.executorGroupId = executorGroup._id;
    tx.managerGroupId = getParentGroupId(executorGroup);
    tx.executorName = 'قيد التنفيذ عبر API';
    tx.executorSenderPhone = referenceNumber;

    appendCustomerReference(tx, 'الرقم المرجعي', referenceNumber);
    if (apiResult.external_transaction_id && apiResult.external_transaction_id !== referenceNumber) {
        appendCustomerReference(tx, 'رقم عملية المزود', apiResult.external_transaction_id);
    }

    appendAdminNote(
        tx,
        `[تنفيذ API قيد الاعتماد | الرقم المرجعي: ${referenceNumber} | سيتم تحويل العملية إلى ناجحة بعد ${Math.round(delayMs / 1000)} ثانية]`
    );
    if (detailedLog) appendAdminNote(tx, detailedLog);

    if (receiptProof) {
        tx.proofImage = receiptProof;
        tx.proofImages = [receiptProof];
        if (typeof tx.set === 'function') {
            tx.set('localProofImage', receiptProof, { strict: false });
        }
    }

    tx.apiResultData = {
        ...(tx.apiResultData || {}),
        waitingApiAutoCompletion: true,
        autoCompleteAt,
        referenceNumber,
        externalTransactionId: apiResult.external_transaction_id || null,
        providerTransactionId: apiResult.provider_transaction_id || null,
        completionDelayMs: delayMs
    };

    return { referenceNumber, autoCompleteAt, delayMs };
};

const completeApiTransactionWithReference = async ({
    tx,
    executorGroup,
    apiResult,
    receiptProof,
    detailedLog
}) => {
    const referenceNumber = resolveApiReferenceNumber(apiResult);
    if (!referenceNumber) return null;

    let ledgerResult = null;
    let ledgerError = null;

    try {
        ledgerResult = await updateBalanceWithLedger(
            'ExecutorGroup',
            executorGroup._id,
            -Number(tx.amount || 0),
            'TRANSFER',
            tx.customId,
            'تنفيذ API آلي'
        );
    } catch (error) {
        ledgerError = error;
        appendAdminNote(tx, `[تنبيه مالي: تم استلام الرقم المرجعي واعتماد العملية، لكن تعذر تسجيل قيد رصيد المنفذ: ${error.message}]`);
        logger.error('Immediate API completion balance update failed', {
            txId: tx.customId,
            executorGroupId: String(executorGroup._id),
            error: error.message
        });
    }

    tx.status = 'completed';
    tx.executorGroupId = executorGroup._id;
    tx.managerGroupId = getParentGroupId(executorGroup);
    tx.executorName = 'تنفيذ آلي (API)';
    tx.executorSenderPhone = referenceNumber;

    appendCustomerReference(tx, 'الرقم المرجعي', referenceNumber);
    if (apiResult.external_transaction_id && apiResult.external_transaction_id !== referenceNumber) {
        appendCustomerReference(tx, 'رقم عملية المزود', apiResult.external_transaction_id);
    }

    appendAdminNote(
        tx,
        `[تنفيذ API ناجح | تم اعتماد العملية فور استلام الرقم المرجعي: ${referenceNumber} | رقم عملية المزود: ${apiResult.external_transaction_id || '---'}]`
    );
    if (detailedLog) appendAdminNote(tx, detailedLog);

    if (receiptProof) {
        tx.proofImage = receiptProof;
        tx.proofImages = [receiptProof];
        if (typeof tx.set === 'function') {
            tx.set('localProofImage', receiptProof, { strict: false });
        }
    }

    tx.apiResultData = {
        ...(tx.apiResultData || {}),
        waitingApiAutoCompletion: false,
        autoCompleteAt: null,
        referenceNumber,
        externalTransactionId: apiResult.external_transaction_id || null,
        providerTransactionId: apiResult.provider_transaction_id || null,
        completedAt: new Date(),
        completionMode: 'immediate_reference',
        ledgerPosted: Boolean(ledgerResult),
        ledgerError: ledgerError ? ledgerError.message : null
    };

    return {
        completed: true,
        referenceNumber,
        ledgerResult,
        ledgerError
    };
};

const completeApiTransaction = async (txId, executorGroupId) => {
    const tx = await Transaction.findById(txId);
    if (!tx) return { completed: false, reason: 'transaction_not_found' };

    if (tx.status !== 'processing') {
        return { completed: false, reason: `invalid_status:${tx.status}` };
    }

    if (!sameId(tx.executorGroupId, executorGroupId)) {
        return { completed: false, reason: 'executor_changed' };
    }

    if (!tx.apiResultData || tx.apiResultData.waitingApiAutoCompletion !== true) {
        return { completed: false, reason: 'not_waiting_api_completion' };
    }

    const executorGroup = await ExecutorGroup.findById(executorGroupId);
    if (!executorGroup) {
        appendAdminNote(tx, '[تعذر اعتماد نجاح API: المنفذ غير موجود]');
        await tx.save();
        return { completed: false, reason: 'executor_not_found' };
    }

    try {
        await updateBalanceWithLedger(
            'ExecutorGroup',
            executorGroup._id,
            -Number(tx.amount || 0),
            'TRANSFER',
            tx.customId,
            'تنفيذ API آلي'
        );
    } catch (error) {
        appendAdminNote(tx, `[تعذر اعتماد نجاح API بسبب الرصيد أو القيد المالي: ${error.message}]`);
        await tx.save();
        logger.error('Delayed API completion balance update failed', {
            txId: tx.customId,
            executorGroupId: String(executorGroup._id),
            error: error.message
        });
        return { completed: false, reason: 'balance_update_failed' };
    }

    tx.status = 'completed';
    tx.executorName = 'تنفيذ آلي (API)';
    tx.apiResultData = {
        ...(tx.apiResultData || {}),
        waitingApiAutoCompletion: false,
        completedAt: new Date()
    };
    appendAdminNote(tx, `[تم اعتماد نجاح API بعد انتظار ${Math.round(getApiCompletionDelayMs() / 1000)} ثانية]`);
    await tx.save();

    eventBus.publish('transfer:completed', {
        tx,
        emp: { name: executorGroup.name || 'تنفيذ آلي (API)' }
    });

    logger.info('Delayed API completion succeeded', {
        txId: tx.customId,
        executorGroupId: String(executorGroup._id)
    });

    return { completed: true };
};

const scheduleApiCompletion = ({ txId, executorGroupId, delayMs = getApiCompletionDelayMs() }) => {
    const timer = setTimeout(() => {
        completeApiTransaction(txId, executorGroupId).catch((error) => {
            logger.error('Delayed API completion timer failed', {
                txId: String(txId),
                executorGroupId: String(executorGroupId),
                error: error.message
            });
        });
    }, delayMs);

    if (typeof timer.unref === 'function') timer.unref();
    return timer;
};

const completeDueApiTransactions = async () => {
    const dueTransactions = await Transaction.find({
        status: 'processing',
        'apiResultData.waitingApiAutoCompletion': true,
        'apiResultData.autoCompleteAt': { $lte: new Date() }
    }).limit(50);

    for (const tx of dueTransactions) {
        if (tx.executorGroupId) {
            await completeApiTransaction(tx._id, tx.executorGroupId);
        }
    }
};

const startApiCompletionMonitor = () => {
    if (monitorTimer) return monitorTimer;

    completeDueApiTransactions().catch((error) => {
        logger.error('Initial API completion monitor scan failed', { error: error.message });
    });

    monitorTimer = setInterval(() => {
        completeDueApiTransactions().catch((error) => {
            logger.error('API completion monitor scan failed', { error: error.message });
        });
    }, MONITOR_INTERVAL_MS);

    if (typeof monitorTimer.unref === 'function') monitorTimer.unref();
    return monitorTimer;
};

module.exports = {
    DEFAULT_API_COMPLETION_DELAY_MS,
    getApiCompletionDelayMs,
    resolveApiReferenceNumber,
    completeApiTransactionWithReference,
    prepareApiTransactionForDelayedCompletion,
    scheduleApiCompletion,
    completeApiTransaction,
    completeDueApiTransactions,
    startApiCompletionMonitor
};
