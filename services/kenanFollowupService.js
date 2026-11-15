'use strict';
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { isKenanFollowupEnabled } = require('../utils/runtimeControls');
const { pollPendingOrders, getTransactions } = require('./kenanProviderService');
const { reconcileKenanOrder } = require('./kenanReconciliationService');
const { attachCompletionReceiptAfterCommit } = require('./apiExecutionLifecycleService');
const logger = require('../utils/logger');
let timer = null;
let running = false;

async function refreshMissingReceipts() {
    const due = { status: 'completed', 'apiResultData.kenanReference': { $exists: true },
        'apiResultData.executorReceiptProof': null,
        $or: [{ 'apiResultData.kenanNextReceiptAt': { $exists: false } },
            { 'apiResultData.kenanNextReceiptAt': { $lte: new Date() } }] };
    for (const row of await Transaction.find(due).limit(10)) {
        if (!isKenanFollowupEnabled()) break;
        const claimed = await Transaction.findOneAndUpdate({ ...due, _id: row._id },
            { $set: { 'apiResultData.kenanNextReceiptAt': new Date(Date.now() + 60000) } }, { returnDocument: 'after' });
        if (!claimed) continue;
        const bot = await ExecutorGroup.findById(claimed.executorGroupId);
        if (!bot?.isApiBot || bot.apiProviderKey !== 'kenan') continue;
        const response = await getTransactions(bot, [claimed.apiResultData.kenanReference]);
        const op = response.operations?.[0];
        if (!op?.success || op.providerStatus !== 'success' || op.phone !== claimed.vodafoneNumber
            || op.amount !== Number(claimed.amount) || op.providerTransactionId !== claimed.apiResultData.kenanReference) continue;
        const fresh = await Transaction.findOneAndUpdate({ _id: claimed._id, status: 'completed', updatedAt: claimed.updatedAt,
            executorGroupId: claimed.executorGroupId, 'apiResultData.executorReceiptProof': null }, { $set: {
            'apiResultData.kenanOrder': op.rawData, 'apiResultData.kenanProviderStatus': 'success',
            'apiResultData.kenanLastCheckedAt': new Date(), 'apiResultData.referenceNumber': op.referenceNumber,
            'apiResultData.kenanAwaitingStatus': false, 'apiResultData.providerResultUnresolved': false,
            'apiResultData.providerDispatchResult': 'accepted', 'apiResultData.waitingApiAutoCompletion': false,
            executorSenderPhone: op.rawData.executor_phone || ''
        } }, { returnDocument: 'after' });
        // Receipt repair never posts a ledger, changes a balance, or reopens
        // a manually completed order. Historical accounting stays separate.
        if (fresh) await attachCompletionReceiptAfterCommit(fresh);
    }
}

async function runKenanFollowupCycle() {
    if (!isKenanFollowupEnabled() || running) return;
    running = true;
    try {
        await pollPendingOrders();
        const due = { status: 'processing', 'apiResultData.waitingApiAutoCompletion': true,
            'apiResultData.kenanOrder.status': 'success', 'apiResultData.kenanReference': { $exists: true },
            'apiResultData.providerResolutionOutcome': { $exists: false },
            $or: [{ 'apiResultData.kenanNextCompletionAt': { $exists: false } },
                { 'apiResultData.kenanNextCompletionAt': { $lte: new Date() } }] };
        const rows = await Transaction.find(due).limit(20);
        for (const row of rows) {
            if (!isKenanFollowupEnabled()) break;
            const claimed = await Transaction.findOneAndUpdate({ ...due, _id: row._id },
                { $set: { 'apiResultData.kenanNextCompletionAt': new Date(Date.now() + 60000) } },
                { returnDocument: 'after' });
            if (!claimed) continue;
            try {
                await reconcileKenanOrder({ transactionId: String(claimed._id), executorGroupId: String(claimed.executorGroupId),
                    actor: { role: 'master', model: 'System', name: 'Kenan automatic verified follow-up' },
                    confirm: true, expectedUpdatedAt: claimed.updatedAt });
            } catch (error) {
                // Keep the paid order for retry, including insufficient local
                // prepaid funding. Never resend, refund, or change credit policy.
                const code = /^KENAN_[A-Z_]+$/.test(error.message || '') ? error.message : 'KENAN_COMPLETION_RETRY_REQUIRED';
                await Transaction.updateOne({ _id: claimed._id, status: 'processing', updatedAt: claimed.updatedAt }, { $set: {
                    'apiResultData.kenanCompletionState': code === 'KENAN_PREPAID_FUNDING_REQUIRED' ? 'awaiting_funding' : 'retrying_confirmation',
                    'apiResultData.kenanCompletionError': code
                } });
                logger.warn('Kenan verified completion deferred', { transactionId: claimed.customId, code });
            }
        }
        await refreshMissingReceipts();
    } finally { running = false; }
}
function startKenanFollowupMonitor() {
    if (!isKenanFollowupEnabled() || timer) return timer;
    const scan = () => runKenanFollowupCycle().catch(() => logger.error('Kenan automatic follow-up scan failed'));
    timer = setInterval(scan, 5000);
    timer.unref?.();
    void scan();
    logger.info('Kenan automatic saved-reference follow-up started', { intervalMs: 5000 });
    return timer;
}
function stopKenanFollowupMonitor() { if (timer) clearInterval(timer); timer = null; }
module.exports = { runKenanFollowupCycle, startKenanFollowupMonitor, stopKenanFollowupMonitor };
