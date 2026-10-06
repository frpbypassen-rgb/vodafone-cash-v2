'use strict';

const fs = require('fs');
const path = require('path');
const Employee = require('../models/Employee');
const { syncBotBalance } = require('../utils/helpers');
const { withOptionalMongoTransaction } = require('./adminFinancialMutationService');
const { acquireLock, releaseLock } = require('./lockService');
const { findOwnedAcceptedExecutorTask } = require('./executorTaskRoutingService');
const { ManualExecutionNumberError, maskManualExecutionNumber } = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('./manualExecutorReceiptReferenceService');
const { ExecutorSenderEntriesError, normalizeExecutorSenderEntries } = require('../utils/executorSenderEntries');
const { preparePersistedSenderEntries } = require('../utils/splitPartProofs');
const { readExecutorManualPolicy } = require('../utils/executorManualPolicy');
const {
    BankTransferExecutionError,
    BANK_TRANSFER_PROOF_NOTE,
    isBankTransferOperation,
    prepareBankTransferCompletion
} = require('../utils/bankTransferExecution');
const { appendAdminNote } = require('../utils/executorTransactionNotes');
const {
    getProofImages,
    saveProofBuffer,
    saveProofImageBase64,
    generateManualExecutorReceiptProof
} = require('./executorProofStorageService');
const { ExecutorTransactionError, logExecutorFailure } = require('./executorTransactionError');
const {
    enqueueCompletionEffects,
    runCompletionOutboxTick
} = require('./executorCompletionOutboxService');

const completeExecutorTask = async ({ transactionId, executorId, executor, body = {}, auditRequest }) => {
    let lock = null;
    const savedPaths = [];
    let transactionCompleted = false;
    try {
        lock = await acquireLock(`executor-complete:${transactionId}`, 30000, { retryCount: 1 });
        const emp = executor || await Employee.findById(executorId).populate('groupId');
        if (!emp || emp.status !== 'active' || !emp.groupId || emp.groupId.status !== 'active') {
            throw new ExecutorTransactionError('حساب المنفذ غير مفعل.', 401);
        }

        const manualPolicy = readExecutorManualPolicy(emp.groupId, emp);
        const tx = await findOwnedAcceptedExecutorTask({
            transactionId,
            executor: emp
        });
        if (!tx) {
            throw new ExecutorTransactionError('العملية غير متاحة للإنهاء أو تم إنهاؤها مسبقاً.', 409);
        }

        const bankTransfer = isBankTransferOperation(tx);
        let bankProofPayloads = null;
        if (bankTransfer) {
            try {
                bankProofPayloads = prepareBankTransferCompletion(body).proofs;
            } catch (error) {
                if (error instanceof BankTransferExecutionError) {
                    throw new ExecutorTransactionError(error.message, error.statusCode);
                }
                throw error;
            }
        }

        const requestedSenderEntries = bankTransfer
            ? null
            : (Array.isArray(body.senderEntries)
                ? body.senderEntries.map((entry) => ({
                    phone: entry?.phone,
                    amount: entry?.amount,
                    proofImage: entry?.proofImageBase64 || entry?.proofImage || null
                }))
                : null);
        let senderEntries = [];
        if (!bankTransfer) {
            try {
                senderEntries = normalizeExecutorSenderEntries({
                    requestedSenderEntries,
                    senderPhone: body.executionNumber ?? body.senderPhone,
                    operationAmount: tx.amount,
                    group: emp.groupId,
                    policy: manualPolicy
                });
            } catch (error) {
                if (error instanceof ExecutorSenderEntriesError) {
                    throw new ExecutorTransactionError(error.message, error.statusCode);
                }
                throw error;
            }
        }

        const executionNumber = bankTransfer
            ? ''
            : String(
                body.executionNumber
                ?? body.senderPhone
                ?? senderEntries[0]?.phone
                ?? ''
            ).trim();
        let maskedExecutionNumber = '';
        if (!bankTransfer) {
            try {
                maskedExecutionNumber = maskManualExecutionNumber(executionNumber || senderEntries[0]?.phone || '');
            } catch (error) {
                if (error instanceof ManualExecutionNumberError) {
                    throw new ExecutorTransactionError(error.message);
                }
                throw error;
            }
        }

        const proofs = getProofImages(bankTransfer ? { imagesBase64: bankProofPayloads } : body);
        if (!bankTransfer && manualPolicy.proofRequired && proofs.length === 0 && senderEntries.every((entry) => !entry.proofImage)) {
            throw new ExecutorTransactionError('إرفاق صورة الإثبات إجباري لهذا المنفذ.');
        }

        const splitCompletion = !bankTransfer && senderEntries.length > 1;
        const executorReceipt = bankTransfer || splitCompletion
            ? null
            : await reserveManualExecutorReceiptReference({ group: emp.groupId });
        const completedAt = new Date();
        tx.completedAt = completedAt;

        const localFileNames = [];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) {
            fs.mkdirSync(proofsDir, { recursive: true });
        }
        if (!bankTransfer && !splitCompletion) {
            localFileNames.push(await generateManualExecutorReceiptProof({
                tx,
                executionNumber: maskedExecutionNumber,
                executorReference: executorReceipt.reference,
                proofsDir,
                savedPaths
            }));
        }

        const persistedSenderEntries = preparePersistedSenderEntries({
            transactionId: tx._id,
            completedAt,
            requestedEntries: Array.isArray(body.senderEntries) ? body.senderEntries : [],
            entries: senderEntries.map((entry, index) => ({
                phone: entry.phone,
                amount: entry.amount,
                proofImage: saveProofImageBase64({
                    tx,
                    proofsDir,
                    savedPaths,
                    imageBase64: entry.proofImage,
                    suffix: `sender_${index + 1}`
                })
            }))
        });

        for (let i = 0; i < proofs.length; i++) {
            localFileNames.push(saveProofBuffer({
                tx,
                proofsDir,
                savedPaths,
                buffer: proofs[i].buffer,
                extension: proofs[i].extension,
                suffix: `${i + 1}`
            }));
        }

        const proofSource = bankTransfer
            ? 'bank-transfer-executor-upload'
            : (splitCompletion
                ? 'split-part-proofs'
                : (proofs.length || persistedSenderEntries.some((entry) => entry.proofImage)
                    ? 'system-generated-with-executor-upload'
                    : 'system-generated'));
        const systemReceiptId = splitCompletion ? undefined : localFileNames[0];
        const executorProofImages = splitCompletion ? localFileNames : localFileNames.slice(1);
        if (bankTransfer) {
            appendAdminNote(tx, BANK_TRANSFER_PROOF_NOTE);
        } else if (splitCompletion) {
            appendAdminNote(tx, '[تم تسجيل أجزاء التنفيذ لإصدار إثبات مستقل لكل جزء ناجح]');
        } else {
            appendAdminNote(tx, `[تم توليد إيصال تنفيذ يدوي | مرجع المنفذ: ${executorReceipt.reference}]`);
        }

        tx.status = 'completed';
        tx.proofImage = systemReceiptId;
        tx.proofImages = systemReceiptId ? [systemReceiptId] : [];
        tx.executorProofImages = executorProofImages;
        tx.executorExecutionNumber = bankTransfer ? undefined : (executionNumber || senderEntries[0]?.phone || undefined);
        tx.executorSenderPhone = bankTransfer ? undefined : (maskedExecutionNumber || undefined);
        tx.executorExecutionNumberMasked = bankTransfer ? undefined : (maskedExecutionNumber || undefined);
        tx.executorSenderEntries = bankTransfer ? [] : persistedSenderEntries;
        tx.manualExecutorReceiptReference = bankTransfer || splitCompletion ? undefined : executorReceipt.reference;
        tx.completedAt = completedAt;
        tx.completedBy = emp._id;
        tx.broadcastMessages = [];
        tx.adminMessages = [];
        tx.$where = { status: 'accepted', operatorId: tx.operatorId };
        const groupId = emp.groupId._id || emp.groupId;
        const parentGroupId = emp.groupId.parentGroupId || emp.groupId.parentBotId;
        const completionAuditContext = {
            request: auditRequest ? {
                method: auditRequest.method,
                path: auditRequest.originalUrl,
                ip: auditRequest.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || auditRequest.ip || 'unknown',
                userAgent: auditRequest.headers?.['user-agent'] || ''
            } : null,
            newData: {
                status: 'completed',
                proofCount: tx.proofImages.length,
                executorProofCount: executorProofImages.length,
                proofSource,
                proofRequired: manualPolicy.proofRequired,
                senderEntryCount: bankTransfer ? 0 : persistedSenderEntries.length,
                manualExecutorReceiptReference: bankTransfer || splitCompletion ? null : executorReceipt.reference,
                executorExecutionNumberMasked: bankTransfer ? null : (maskedExecutionNumber || null)
            }
        };
        await withOptionalMongoTransaction(async (session) => {
            await tx.save(session ? { session } : {});
            await syncBotBalance(groupId, { session });
            if (parentGroupId) await syncBotBalance(parentGroupId, { session });
            await enqueueCompletionEffects({ tx, emp, auditContext: completionAuditContext, session });
        });
        transactionCompleted = true;
        runCompletionOutboxTick().catch((error) => logExecutorFailure('completion-effects', error));

        return { bankTransfer };
    } catch (error) {
        if (!transactionCompleted) {
            savedPaths.forEach((filePath) => {
                try {
                    fs.unlinkSync(filePath);
                } catch (cleanupError) {
                    logExecutorFailure('completion-proof-cleanup', cleanupError);
                }
            });
        }
        throw error;
    } finally {
        await releaseLock(lock).catch((error) => logExecutorFailure('completion-lock-release', error));
    }
};

module.exports = { completeExecutorTask };
