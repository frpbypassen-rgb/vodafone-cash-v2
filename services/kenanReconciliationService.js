'use strict';
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const provider = require('./kenanProviderService');
const { completeApiTransactionWithReference } = require('./apiExecutionLifecycleService');
const { logAction } = require('./auditService');
const eventBus = require('./eventBus');

// Explicit administrator reconciliation remains available while background
// financial schedulers are paused. It only GETs a saved Kenan reference.
async function reconcileKenanOrder({ transactionId, executorGroupId, actor, req, confirm = false, expectedUpdatedAt }) {
    if (actor?.role !== 'master') throw new Error('KENAN_RECONCILIATION_FORBIDDEN');
    const tx = await Transaction.findById(transactionId);
    if (!tx || String(tx.executorGroupId) !== String(executorGroupId)) throw new Error('KENAN_TRANSACTION_NOT_FOUND');
    const bot = await ExecutorGroup.findById(executorGroupId);
    if (!bot?.isApiBot || bot.apiProviderKey !== 'kenan') throw new Error('KENAN_ACCOUNT_REQUIRED');
    if (tx.status === 'completed') return { success: true, applied: false, idempotent: true, customId: tx.customId };
    const reference = tx.apiResultData?.kenanReference;
    if (tx.status !== 'processing' || !reference || tx.apiResultData?.providerResolutionOutcome) throw new Error('KENAN_STATE_CONFLICT');
    const response = await provider.getTransactions(bot, [reference]);
    const operation = response.operations?.[0];
    if (!operation?.success || operation.phone !== tx.vodafoneNumber || operation.amount !== Number(tx.amount)
        || operation.providerTransactionId !== reference) throw new Error('KENAN_AUTHORITATIVE_RESULT_UNAVAILABLE');
    const order = operation.rawData;
    const debitQuery = { entityModel: 'ExecutorGroup', entityId: bot._id, transactionId: tx.customId, type: 'TRANSFER' };
    const [existing, allDebits] = await Promise.all([
        Ledger.countDocuments({ ...debitQuery, amount: -Number(tx.amount), description: 'تنفيذ API آلي' }),
        Ledger.countDocuments(debitQuery)
    ]);
    if (existing > 1 || allDebits !== existing) throw new Error('KENAN_LEDGER_CONFLICT');
    const eligible = order.status === 'success' && (existing === 1 || bot.apiSettlementMode === 'credit' || Number(bot.balance) >= Number(tx.amount));
    const preview = { success: true, applied: false, eligible, customId: tx.customId, reference, providerStatus: order.status,
        expectedUpdatedAt: tx.updatedAt, executorDebit: existing ? 0 : Number(tx.amount), existingDebitCount: existing,
        executorBalance: Number(bot.balance), order };
    if (!confirm) return preview;
    if (!eligible) throw new Error('KENAN_SUCCESS_OR_BALANCE_REQUIRED');
    if (!expectedUpdatedAt || new Date(expectedUpdatedAt).getTime() !== new Date(tx.updatedAt).getTime()) throw new Error('KENAN_ROW_CHANGED');
    const result = await completeApiTransactionWithReference({ tx, executorGroup: bot,
        apiResult: { reference_number: reference, provider_transaction_id: reference, external_transaction_id: reference },
        verifiedKenan: { order, expectedUpdatedAt: tx.updatedAt },
        beforeCommit: async (completed, session) => logAction({ action: 'KENAN_VERIFIED_SUCCESS_RECONCILED', req,
            performedById: actor.id, performedByModel: actor.model === 'System' ? 'System' : 'Admin', performedByName: actor.name || 'Admin',
            targetModel: 'Transaction', targetId: completed._id, metadata: { reference, providerPaymentCalls: 0 },
            required: true, success: true, session }) });
    if (!result?.idempotent) {
        try { await eventBus.publish('transfer:completed', { tx, emp: { name: bot.name } }); } catch (_) { /* Saved completion is authoritative. */ }
    }
    return { ...preview, applied: !result?.idempotent, idempotent: Boolean(result?.idempotent), statusAfter: tx.status };
}
module.exports = { reconcileKenanOrder };
