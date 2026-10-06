'use strict';

const crypto = require('crypto');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const zaynpay = require('./zaynpayApi');
const { directProviderExecutionBlock } = require('../utils/runtimeControls');
const { completedTransferLedgerInc } = require('../utils/executorServiceLedger');
const { generateManualExecutorReceiptBase64 } = require('../utils/manualExecutorReceipt');
const { appendAdminNote, appendCustomerReference } = require('../utils/executorTransactionNotes');
const { saveProviderReceiptProof } = require('./executorProofStorageService');
const { withOptionalMongoTransaction } = require('./adminFinancialMutationService');
const { markProviderResultUnresolved } = require('./providerDispatchClaimService');
const { ExecutorTransactionError, logExecutorFailure } = require('./executorTransactionError');

const executeExecutorProviderTask = async ({ transactionId, executorId }) => {
    const blocked = directProviderExecutionBlock();
    if (blocked) throw new ExecutorTransactionError(blocked.message, 200, blocked.code);
    let claimedTx = null;
    try {
        const tx = await Transaction.findById(transactionId);
        const emp = await Employee.findById(executorId).populate('groupId');
        if (!emp || emp.webUsername !== 'zaynapi@ahram.com') {
            throw new ExecutorTransactionError('غير مصرح لك باستخدام بوابة ZaynPay', 200);
        }
        if (!tx) throw new ExecutorTransactionError('الطلب غير موجود', 200);
        if (tx.status !== 'accepted' || String(tx.operatorId) !== String(emp._id)
            || String(tx.executorGroupId) !== String(emp.groupId?._id)
            || tx.apiResultData?.providerDispatchAttemptId) {
            throw new ExecutorTransactionError('الطلب غير متاح للدفع أو سبق إرساله للمزود', 409);
        }

        const walletNumber = tx.vodafoneNumber || tx.accountNumber;
        if (!walletNumber) throw new ExecutorTransactionError('رقم المحفظة غير متوفر', 200);
        let paymentBillInfo;
        try {
            paymentBillInfo = await zaynpay.inquiry(walletNumber, tx.amount);
        } catch (error) {
            logExecutorFailure('provider-inquiry', error);
            throw new ExecutorTransactionError('تعذر الاستعلام لدى مزود الدفع. أعد المحاولة.', 200);
        }

        const attemptId = crypto.randomUUID();
        claimedTx = await Transaction.findOneAndUpdate(
            {
                _id: tx._id,
                status: 'accepted',
                operatorId: String(emp._id),
                executorGroupId: emp.groupId._id,
                'apiResultData.providerDispatchAttemptId': { $exists: false }
            },
            { $set: {
                status: 'processing',
                'apiResultData.providerDispatchAttemptId': attemptId,
                'apiResultData.providerDispatchStartedAt': new Date(),
                'apiResultData.providerDispatchExecutorGroupId': emp.groupId._id
            } },
            { returnDocument: 'after', writeConcern: { w: 'majority' } }
        );
        if (!claimedTx) throw new ExecutorTransactionError('بدأ تنفيذ الطلب بالفعل', 409);

        // A claim survives a lost response, preventing a second payment attempt.
        const paymentRes = await zaynpay.pay(paymentBillInfo, walletNumber, tx.amount);
        if (!paymentRes?.success || !(paymentRes.refNumber || paymentRes.transactionNumber)) {
            throw new Error('PROVIDER_RESULT_UNRESOLVED');
        }
        const completedAt = new Date();
        const apiReference = paymentRes.refNumber || paymentRes.transactionNumber || tx.customId || tx._id.toString();
        const receiptBase64 = await generateManualExecutorReceiptBase64({
            amount: tx.amount,
            customerPhone: walletNumber,
            executionNumber: apiReference,
            executorReference: paymentRes.transactionNumber || apiReference,
            executionReferenceLabel: 'مرجع تنفيذ API',
            executionNumberLabel: 'رقم تنفيذ API',
            customId: tx.customId || tx._id.toString().slice(-6),
            serviceName: 'محافظ كاش',
            completedAt
        });
        const localFileNames = [saveProviderReceiptProof({ tx, receiptBase64 })];
        const parentGroupId = emp.groupId.parentGroupId || emp.groupId.parentBotId;
        const ledgerInc = completedTransferLedgerInc(emp.groupId, tx, -tx.amount);
        appendCustomerReference(tx, 'الرقم المرجعي', paymentRes.refNumber);
        appendCustomerReference(tx, 'رقم العملية الخارجي', paymentRes.transactionNumber);
        appendAdminNote(tx, `[ZaynPay Auto-Executed | Ref: ${paymentRes.refNumber} | TxNo: ${paymentRes.transactionNumber}]`);
        await withOptionalMongoTransaction(async (session) => {
            const completion = await Transaction.findOneAndUpdate(
                {
                    _id: tx._id,
                    status: 'processing',
                    'apiResultData.providerDispatchAttemptId': attemptId,
                    'apiResultData.providerResultUnresolved': { $ne: true }
                },
                { $set: {
                    status: 'completed', proofImage: localFileNames[0], proofImages: localFileNames,
                    completedAt, completedBy: emp._id, executorBotId: emp.groupId.token,
                    notes: tx.notes, adminNotes: tx.adminNotes,
                    'apiResultData.providerDispatchResult': 'accepted',
                    'apiResultData.referenceNumber': paymentRes.refNumber || paymentRes.transactionNumber
                } },
                { returnDocument: 'after', session }
            );
            if (!completion) throw new Error('PROVIDER_COMPLETION_NOT_SAVED');
            if (parentGroupId) {
                const parent = await ExecutorGroup.findByIdAndUpdate(parentGroupId, { $inc: ledgerInc }, { session });
                if (!parent) throw new Error('PARENT_EXECUTOR_GROUP_UNAVAILABLE');
            }
            const group = await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: ledgerInc }, { session });
            if (!group) throw new Error('EXECUTOR_GROUP_UNAVAILABLE');
        });
        claimedTx = null;
        return { transactionNumber: paymentRes.transactionNumber };
    } catch (error) {
        if (!claimedTx) throw error;
        logExecutorFailure('provider-execution', error);
        try {
            await markProviderResultUnresolved({
                txId: claimedTx._id,
                reason: 'تعذر التحقق من نتيجة الدفع أو حفظها محلياً.',
                source: 'zaynpay'
            });
        } catch (holdError) {
            logExecutorFailure('provider-unresolved-hold', holdError);
        }
        throw new ExecutorTransactionError(
            'نتيجة الدفع غير مؤكدة. يلزم مراجعتها يدوياً قبل أي محاولة أخرى.',
            409,
            'PROVIDER_RESULT_UNRESOLVED'
        );
    }
};

module.exports = { executeExecutorProviderTask };
