// services/queueService.js
'use strict';

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { executeTransferViaApi, saveApiReceiptProof } = require('./externalApiService');
const {
    completeApiTransactionWithReference,
    resolveApiReferenceNumber
} = require('./apiExecutionLifecycleService');
const {
    startApiBalanceAudit,
    finishApiBalanceAudit,
    withApiExecutorSerialization
} = require('./apiProviderReconciliationService');
const eventBus = require('./eventBus');
const logger = require('../utils/logger');
const { executorSupportsTransferType } = require('../utils/executorServiceCatalog');
const {
    UNRESOLVED_CODE,
    hasDispatchMarker,
    isProviderResultUnresolved,
    needsUnresolvedHold,
    markProviderResultUnresolved,
    guardAutomaticProviderRedispatch
} = require('./providerDispatchClaimService');

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

class ApiTransferQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    async addJob(txId, apiGroupId) {
        const guard = await guardAutomaticProviderRedispatch(txId);
        if (guard.handled) {
            logger.warn('In-memory API job refused for unresolved provider dispatch', {
                txId,
                apiGroupId,
                reason: guard.reason,
                code: guard.code || UNRESOLVED_CODE
            });
            return { queued: false, code: guard.code || UNRESOLVED_CODE };
        }
        this.queue.push({ txId, apiGroupId });
        this.processQueue();
        return { queued: true };
    }

    async processSingleJob(txId, apiGroupId) {
        const guard = await guardAutomaticProviderRedispatch(txId);
        if (guard.handled) {
            logger.warn('API transfer job held before provider dispatch', {
                txId,
                apiGroupId,
                reason: guard.reason,
                code: guard.code || UNRESOLVED_CODE
            });
            return { skipped: true, code: guard.code || UNRESOLVED_CODE };
        }
        return withApiExecutorSerialization(apiGroupId, () => this.processSingleJobSerialized(txId, apiGroupId));
    }

    async processSingleJobSerialized(txId, apiGroupId) {
        try {
            const tx = await Transaction.findById(txId);
            const executorGroup = await ExecutorGroup.findById(apiGroupId);

            if (!tx || !executorGroup || tx.status !== 'processing') {
                logger.warn('API transfer job skipped before provider dispatch', {
                    txId,
                    apiGroupId,
                    hasTx: Boolean(tx),
                    hasExecutorGroup: Boolean(executorGroup),
                    status: tx ? tx.status : null
                });
                return;
            }

            if (needsUnresolvedHold(tx) || isProviderResultUnresolved(tx)) {
                if (needsUnresolvedHold(tx)) {
                    await markProviderResultUnresolved({
                        txId: tx._id,
                        reason: 'queue worker found a provider dispatch without a definitive result',
                        source: 'queue-worker'
                    });
                }
                logger.warn('API transfer job held: provider result is unresolved', {
                    txId: tx.customId,
                    code: UNRESOLVED_CODE
                });
                return;
            }

            if (!executorSupportsTransferType(executorGroup, tx.transferType)) {
                tx.status = 'pending';
                tx.executorGroupId = undefined;
                tx.managerGroupId = undefined;
                tx.executorName = undefined;
                appendAdminNote(tx, '[أوقف التنفيذ الآلي: خدمة العملية لا تطابق خدمة المنفذ]');
                await tx.save();
                logger.warn('API executor service mismatch', {
                    txId: tx.customId,
                    transferType: tx.transferType,
                    executorGroupId: String(executorGroup._id),
                    executorServiceKey: executorGroup.serviceKey || 'vodafone'
                });
                return;
            }

            let balanceAudit = null;
            try {
                balanceAudit = await startApiBalanceAudit({ tx, executorGroup });
            } catch (auditError) {
                logger.error('API pre-execution balance audit failed without blocking execution', {
                    txId: tx.customId,
                    executorGroupId: String(executorGroup._id),
                    error: auditError.message
                });
            }

            const apiResult = await executeTransferViaApi(tx, executorGroup);
            try {
                balanceAudit = await finishApiBalanceAudit({
                    audit: balanceAudit,
                    tx,
                    executorGroup,
                    apiResult
                });
            } catch (auditError) {
                logger.error('API post-execution balance audit failed without blocking completion', {
                    txId: tx.customId,
                    executorGroupId: String(executorGroup._id),
                    error: auditError.message
                });
            }

            if (apiResult && (apiResult.success === 'unresolved' || apiResult.code === UNRESOLVED_CODE)) {
                await markProviderResultUnresolved({
                    txId: tx._id,
                    reason: apiResult.message || 'provider result unresolved',
                    source: 'provider-response'
                });
                logger.error('API provider result unresolved; holding executor and skipping debit', {
                    txId: tx.customId,
                    code: UNRESOLVED_CODE
                });
                return;
            }

            const balanceLog = balanceAudit
                ? `\n--- مطابقة رصيد المزود ---\nالحالة: ${balanceAudit.checkStatus}\nقبل: ${balanceAudit.beforeCheck?.availableBalance ?? '---'}\nبعد: ${balanceAudit.afterCheck?.availableBalance ?? '---'}\nالفرق عن المتوقع: ${balanceAudit.debitDifference ?? '---'}`
                : '';
            const detailedLog = apiResult.processLog
                ? `--- سجل الـ API ---\n${apiResult.processLog}${balanceLog}`
                : balanceLog.trim();

            if (apiResult.success === true) {
                const exactRefNumber = resolveApiReferenceNumber(apiResult);

                if (exactRefNumber) {
                    let receiptProof = null;
                    try {
                        receiptProof = await saveApiReceiptProof(tx, apiResult);
                        if (!receiptProof) appendAdminNote(tx, '[تنبيه: تم تنفيذ API بنجاح لكن تعذر توليد صورة الإيصال]');
                    } catch (fileErr) {
                        logger.error('[API File Save Error]:', fileErr.message);
                        appendAdminNote(tx, `[تعذر توليد إيصال API: ${fileErr.message}]`);
                    }

                    const completion = await completeApiTransactionWithReference({
                        tx,
                        executorGroup,
                        apiResult,
                        receiptProof,
                        detailedLog
                    });

                    await tx.save();
                    eventBus.publish('transfer:completed', {
                        tx,
                        emp: { name: executorGroup.name || 'تنفيذ آلي (API)' }
                    });

                    logger.info('API Execution Reference Received - Completed Immediately', {
                        txId: tx.customId,
                        exactRefNumber,
                        ledgerPosted: completion ? !completion.ledgerError : false
                    });
                    return;
                }

                tx.status = 'pending';
                tx.executorGroupId = executorGroup._id;
                tx.executorName = 'في انتظار رقم مرجعي (API)';
                appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                appendAdminNote(tx, '[في الانتظار - تم تنفيذ طلب API بدون رقم مرجعي واضح]');
                if (detailedLog) appendAdminNote(tx, detailedLog);
                tx.apiResultData = {
                    ...(tx.apiResultData || {}),
                    providerDispatchResult: hasDispatchMarker(tx) ? 'pending_reference' : tx.apiResultData?.providerDispatchResult,
                    providerResultUnresolved: false
                };
                if (typeof tx.markModified === 'function') tx.markModified('apiResultData');
                if (typeof tx.set === 'function') {
                    tx.set('isApiReview', undefined, { strict: false });
                    tx.set('originalApiGroupId', undefined, { strict: false });
                }
                await tx.save();

                logger.info('API Execution Pending Verification', { txId: tx.customId });

                try {
                    const { sendWhatsAppAlert } = require('./whatsappService');
                    await sendWhatsAppAlert(tx, apiResult);
                } catch (waErr) {
                    logger.error('[API WhatsApp Alert Error]:', waErr.message);
                }
            } else if (apiResult.success === 'pending') {
                tx.status = 'pending';
                appendCustomerReference(tx, 'الرقم المرجعي', apiResult.external_transaction_id);
                appendAdminNote(tx, `[العملية معلقة بانتظار شبكة المحمول | المرجع: ${apiResult.external_transaction_id}]`);
                if (detailedLog) appendAdminNote(tx, detailedLog);
                tx.executorGroupId = executorGroup._id;
                tx.executorName = executorGroup.name;
                tx.apiResultData = {
                    ...(tx.apiResultData || {}),
                    providerDispatchResult: hasDispatchMarker(tx) ? 'pending_reference' : tx.apiResultData?.providerDispatchResult,
                    providerResultUnresolved: false
                };
                if (typeof tx.markModified === 'function') tx.markModified('apiResultData');
                await tx.save();

                logger.info('API Execution Network Pending', { txId: tx.customId });
            } else if (needsUnresolvedHold(tx) || isProviderResultUnresolved(tx)) {
                await markProviderResultUnresolved({
                    txId: tx._id,
                    reason: apiResult && apiResult.message || 'provider dispatch has no definitive result',
                    source: 'queue-failure-guard'
                });
                logger.error('API Execution held unresolved instead of returning to pending', {
                    txId: tx.customId,
                    code: UNRESOLVED_CODE
                });
            } else {
                tx.status = 'pending';
                appendAdminNote(tx, `[فشل التنفيذ الآلي: ${apiResult.message}]`);
                if (detailedLog) appendAdminNote(tx, detailedLog);
                tx.executorGroupId = undefined;
                tx.executorName = undefined;
                await tx.save();

                logger.error('API Execution Failed', { txId: tx.customId, error: apiResult.message });
            }
        } catch (error) {
            try {
                const tx = await Transaction.findById(txId);
                if (tx && (needsUnresolvedHold(tx) || isProviderResultUnresolved(tx))) {
                    await markProviderResultUnresolved({
                        txId: tx._id,
                        reason: error.message,
                        source: 'queue-exception'
                    });
                    logger.error('API Queue Processing Error held unresolved', {
                        txId: tx.customId,
                        code: UNRESOLVED_CODE,
                        error: error.message
                    });
                    return;
                }
                if (tx) {
                    tx.status = 'pending';
                    tx.executorGroupId = undefined;
                    tx.executorName = undefined;
                    appendAdminNote(tx, `[خطأ داخلي في السيرفر أثناء المعالجة: ${error.message}]`);
                    await tx.save();
                    logger.error('API Queue Processing Error', { txId: tx.customId, error: error.message });
                }
            } catch (_) {}
        }
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        const job = this.queue.shift();

        await this.processSingleJob(job.txId, job.apiGroupId);

        this.isProcessing = false;
        setTimeout(() => this.processQueue(), 2000);
    }
}

module.exports = new ApiTransferQueue();
