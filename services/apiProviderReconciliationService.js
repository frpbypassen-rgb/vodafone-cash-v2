'use strict';

const ApiBalanceAudit = require('../models/ApiBalanceAudit');
const ApiProviderReturn = require('../models/ApiProviderReturn');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const Transaction = require('../models/Transaction');
const { getApiProviderBalance, getApiProviderTransactions } = require('./externalApiService');
const logger = require('../utils/logger');

const DEFAULT_BALANCE_TOLERANCE = 0.01;
const DEFAULT_RETURN_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETURN_LOOKBACK_DAYS = 45;
const executorChains = new Map();
let returnMonitorTimer = null;
let initialReturnMonitorTimer = null;

const numericOrNull = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const rounded = (value) => {
    const parsed = numericOrNull(value);
    return parsed === null ? null : Math.round(parsed * 1000) / 1000;
};

const getBalanceTolerance = () => {
    const configured = Number(process.env.API_BALANCE_TOLERANCE);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_BALANCE_TOLERANCE;
};

const snapshotFromResult = (result) => ({
    success: Boolean(result && result.success),
    serviceCredit: result && result.success ? numericOrNull(result.serviceCredit) : null,
    cashCredit: result && result.success ? numericOrNull(result.cashCredit) : null,
    availableBalance: result && result.success ? numericOrNull(result.availableBalance ?? result.balance) : null,
    message: String(result && result.message ? result.message : ''),
    checkedAt: new Date()
});

const checkProviderBalanceSafely = async (executorGroup) => {
    try {
        return snapshotFromResult(await getApiProviderBalance(executorGroup));
    } catch (error) {
        return snapshotFromResult({ success: false, message: error.message });
    }
};

const updateExecutorBalanceSnapshot = async (executorGroupId, snapshot, status) => {
    const update = {
        lastApiBalanceCheckAt: snapshot.checkedAt || new Date(),
        lastApiBalanceCheckStatus: status
    };
    if (snapshot.success) {
        update.lastApiServiceCredit = snapshot.serviceCredit;
        update.lastApiCashCredit = snapshot.cashCredit;
        update.lastApiAvailableBalance = snapshot.availableBalance;
    }
    await ExecutorGroup.updateOne({ _id: executorGroupId }, { $set: update }).catch(() => {});
};

const createAdminAlert = async ({ executorGroup, tx, title, message, type, metadata = {} }) => {
    try {
        return await Notification.create({
            audience: 'admin',
            targetModel: 'ExecutorGroup',
            targetId: executorGroup._id,
            txId: tx ? tx.customId : undefined,
            type,
            title,
            message,
            metadata: {
                executorGroupId: String(executorGroup._id),
                executorName: executorGroup.name,
                url: `/executor/${executorGroup._id}`,
                ...metadata
            }
        });
    } catch (error) {
        logger.error('Failed to persist API reconciliation alert', { error: error.message });
        return null;
    }
};

const ensureApiReconciliationIndexes = async () => {
    try {
        await Promise.all([
            ApiBalanceAudit.createIndexes(),
            ApiProviderReturn.createIndexes()
        ]);
        logger.info('API reconciliation indexes are ready');
        return true;
    } catch (error) {
        logger.error('Failed to create API reconciliation indexes', { error: error.message });
        return false;
    }
};

const appendAlert = (alerts, message) => {
    const clean = String(message || '').trim();
    if (clean && !alerts.includes(clean)) alerts.push(clean);
};

const startApiBalanceAudit = async ({ tx, executorGroup }) => {
    const beforeCheck = await checkProviderBalanceSafely(executorGroup);
    const previousAudit = await ApiBalanceAudit.findOne({
        executorGroupId: executorGroup._id,
        'afterCheck.success': true,
        'afterCheck.availableBalance': { $ne: null }
    }).sort({ createdAt: -1 }).lean();

    const alerts = [];
    let continuityDifference = null;
    let checkStatus = 'pending';

    if (!beforeCheck.success) {
        checkStatus = 'check_failed';
        appendAlert(alerts, `تعذر فحص رصيد المزود قبل العملية: ${beforeCheck.message || 'لا توجد استجابة صالحة'}`);
    } else if (previousAudit && previousAudit.afterCheck) {
        const previousPost = numericOrNull(previousAudit.afterCheck.availableBalance);
        if (previousPost !== null && beforeCheck.availableBalance !== null) {
            continuityDifference = rounded(beforeCheck.availableBalance - previousPost);
            if (Math.abs(continuityDifference) > getBalanceTolerance()) {
                checkStatus = 'discrepancy';
                appendAlert(
                    alerts,
                    `رصيد ما قبل العملية (${beforeCheck.availableBalance}) لا يطابق رصيد ما بعد آخر عملية (${previousPost})؛ الفرق ${continuityDifference}`
                );
            }
        }
    }

    const audit = await ApiBalanceAudit.create({
        executorGroupId: executorGroup._id,
        transactionId: tx._id,
        transactionCustomId: tx.customId,
        beforeCheck,
        previousAuditId: previousAudit ? previousAudit._id : null,
        previousPostAvailableBalance: previousAudit && previousAudit.afterCheck
            ? numericOrNull(previousAudit.afterCheck.availableBalance)
            : null,
        continuityDifference,
        checkStatus,
        hasDiscrepancy: alerts.length > 0,
        alerts,
        reviewStatus: alerts.length ? 'pending' : 'not_required',
        tenantId: tx.tenantId || null
    });

    await updateExecutorBalanceSnapshot(executorGroup._id, beforeCheck, checkStatus);

    if (alerts.length) {
        await createAdminAlert({
            executorGroup,
            tx,
            title: 'تنبيه فرق رصيد منفذ API',
            message: `${tx.customId}: ${alerts.join(' | ')}. استمر إرسال العملية تلقائياً دون إيقاف الطابور.`,
            type: 'api_balance_discrepancy',
            metadata: { auditId: String(audit._id), stage: 'before' }
        });
    }

    return audit;
};

const finishApiBalanceAudit = async ({ audit, tx, executorGroup, apiResult }) => {
    if (!audit) return null;

    const afterCheck = await checkProviderBalanceSafely(executorGroup);
    const existingAlerts = Array.isArray(audit.alerts) ? audit.alerts.map(String) : [];
    const alerts = [...existingAlerts];
    const newAlerts = [];
    const expectedDebit = apiResult && apiResult.success === true ? rounded(tx.amount) : null;
    let observedDebit = null;
    let debitDifference = null;

    if (!afterCheck.success) {
        const message = `تعذر فحص رصيد المزود بعد العملية: ${afterCheck.message || 'لا توجد استجابة صالحة'}`;
        appendAlert(alerts, message);
        appendAlert(newAlerts, message);
    }

    if (audit.beforeCheck && audit.beforeCheck.success && afterCheck.success) {
        const beforeBalance = numericOrNull(audit.beforeCheck.availableBalance);
        const afterBalance = numericOrNull(afterCheck.availableBalance);
        if (beforeBalance !== null && afterBalance !== null) {
            observedDebit = rounded(beforeBalance - afterBalance);
            if (expectedDebit !== null) {
                debitDifference = rounded(observedDebit - expectedDebit);
                if (Math.abs(debitDifference) > getBalanceTolerance()) {
                    const message = `خصم المزود الفعلي (${observedDebit}) لا يطابق قيمة العملية (${expectedDebit})؛ الفرق ${debitDifference}`;
                    appendAlert(alerts, message);
                    appendAlert(newAlerts, message);
                }
            }
        }
    }

    const hasFailedCheck = !audit.beforeCheck || !audit.beforeCheck.success || !afterCheck.success;
    const checkStatus = hasFailedCheck ? 'check_failed' : (alerts.length ? 'discrepancy' : 'matched');
    const executionStatus = apiResult && apiResult.success === true
        ? 'success'
        : (apiResult && apiResult.success === 'pending' ? 'pending' : 'failed');

    audit.afterCheck = afterCheck;
    audit.providerTransactionId = String(apiResult && (apiResult.provider_transaction_id || apiResult.external_transaction_id) || '');
    audit.referenceNumber = String(apiResult && (apiResult.reference_number || apiResult.sender_number) || '');
    audit.expectedDebit = expectedDebit;
    audit.observedDebit = observedDebit;
    audit.debitDifference = debitDifference;
    audit.executionStatus = executionStatus;
    audit.checkStatus = checkStatus;
    audit.hasDiscrepancy = alerts.length > 0;
    audit.alerts = alerts;
    audit.reviewStatus = alerts.length ? 'pending' : 'not_required';
    await audit.save();

    tx.apiResultData = {
        ...(tx.apiResultData || {}),
        balanceAuditId: audit._id,
        providerBalanceBefore: numericOrNull(audit.beforeCheck && audit.beforeCheck.availableBalance),
        providerBalanceAfter: numericOrNull(afterCheck.availableBalance),
        providerBalanceDifference: debitDifference,
        providerBalanceCheckStatus: checkStatus
    };

    await updateExecutorBalanceSnapshot(executorGroup._id, afterCheck, checkStatus);

    if (newAlerts.length) {
        await createAdminAlert({
            executorGroup,
            tx,
            title: 'تنبيه تسوية رصيد منفذ API',
            message: `${tx.customId}: ${newAlerts.join(' | ')}. اكتمل مسار التنفيذ تلقائياً ولم يتم تعطيل العمليات التالية.`,
            type: 'api_balance_discrepancy',
            metadata: { auditId: String(audit._id), stage: 'after' }
        });
    }

    return audit;
};

const extractProviderTransactionId = (tx = {}) => {
    const direct = tx.apiResultData && (
        tx.apiResultData.providerTransactionId
        || tx.apiResultData.externalTransactionId
    );
    if (direct) return String(direct).trim();
    const match = String(tx.notes || '').match(/\[رقم عملية المزود:\s*([^\]]+)\]/);
    return match && match[1] ? match[1].trim() : '';
};

const syncProviderReturnedOperations = async (executorGroup, options = {}) => {
    const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100);
    const lookbackDays = Math.min(Math.max(Number(options.lookbackDays) || DEFAULT_RETURN_LOOKBACK_DAYS, 1), 365);
    const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const query = {
        executorGroupId: executorGroup._id,
        status: { $in: ['completed', 'processing', 'accepted', 'cancelled_by_admin'] },
        createdAt: { $gte: cutoff }
    };

    if (!options.force) {
        const checkedBefore = new Date(Date.now() - DEFAULT_RETURN_MONITOR_INTERVAL_MS);
        query.$or = [
            { 'apiResultData.providerLastCheckedAt': { $exists: false } },
            { 'apiResultData.providerLastCheckedAt': null },
            { 'apiResultData.providerLastCheckedAt': { $lte: checkedBefore } }
        ];
    }

    const transactions = await Transaction.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    const byProviderId = new Map();
    for (const tx of transactions) {
        const providerTransactionId = extractProviderTransactionId(tx);
        if (providerTransactionId && !byProviderId.has(providerTransactionId)) {
            byProviderId.set(providerTransactionId, tx);
        }
    }

    const providerIds = [...byProviderId.keys()];
    if (!providerIds.length) {
        await ExecutorGroup.updateOne({ _id: executorGroup._id }, {
            $set: {
                lastApiReturnSyncAt: new Date(),
                lastApiReturnSyncStatus: 'success',
                lastApiReturnSyncMessage: 'لا توجد عمليات جديدة قابلة للمراجعة'
            }
        }).catch(() => {});
        return { success: true, checkedCount: 0, returnedCount: 0, newAlerts: 0 };
    }

    const providerResult = await getApiProviderTransactions(executorGroup, providerIds);
    let checkedCount = 0;
    let returnedCount = 0;
    let newAlerts = 0;
    const now = new Date();

    for (const operation of providerResult.operations || []) {
        const requestedTransactionId = String(operation.requestedTransactionId || operation.providerTransactionId || '').trim();
        const providerTransactionId = requestedTransactionId;
        const tx = byProviderId.get(requestedTransactionId);
        if (!tx) continue;

        checkedCount += 1;
        await Transaction.updateOne({ _id: tx._id }, {
            $set: {
                'apiResultData.providerLastCheckedAt': now,
                'apiResultData.providerReportedStatus': operation.providerStatus || '',
                'apiResultData.providerStatusCheckSucceeded': Boolean(operation.success)
            }
        }).catch(() => {});

        if (!operation.success || !operation.isReturned) continue;
        returnedCount += 1;

        const alreadyCancelled = tx.status === 'cancelled_by_admin';
        const setFields = {
            transactionId: tx._id,
            transactionCustomId: tx.customId,
            referenceNumber: operation.referenceNumber || '',
            providerStatus: operation.providerStatus || '',
            amount: numericOrNull(operation.amount),
            phone: operation.phone || tx.vodafoneNumber || tx.accountNumber || '',
            serviceName: operation.serviceName || '',
            providerDate: operation.providerDate || '',
            providerTime: operation.providerTime || '',
            rawData: operation.rawData || null,
            lastCheckedAt: now
        };
        if (alreadyCancelled) {
            setFields.status = 'cancelled';
            setFields.reviewedAt = tx.cancelledAt || now;
            setFields.reviewedBy = tx.cancelledBy || 'الإدارة';
            setFields.cancellationNumber = tx.cancellationNumber || '';
        }
        const insertFields = {
            firstDetectedAt: now,
            tenantId: tx.tenantId || null
        };
        if (!alreadyCancelled) insertFields.status = 'pending_review';

        let writeResult;
        try {
            writeResult = await ApiProviderReturn.updateOne(
                { executorGroupId: executorGroup._id, providerTransactionId },
                {
                    $set: setFields,
                    $setOnInsert: insertFields
                },
                { upsert: true }
            );
        } catch (error) {
            if (error && error.code === 11000) {
                await ApiProviderReturn.updateOne(
                    { executorGroupId: executorGroup._id, providerTransactionId },
                    { $set: setFields }
                );
                writeResult = { upsertedCount: 0 };
            } else {
                throw error;
            }
        }

        if (writeResult.upsertedCount > 0 && !alreadyCancelled) {
            newAlerts += 1;
            await createAdminAlert({
                executorGroup,
                tx,
                title: 'عملية مسترجعة من مزود API',
                message: `أكد المزود أن العملية ${providerTransactionId} بحالة «${operation.providerStatus}». راجع العملية ${tx.customId} ثم نفذ الإلغاء لإرجاع رصيد العميل.`,
                type: 'api_provider_return',
                metadata: {
                    providerTransactionId,
                    transactionId: String(tx._id),
                    url: `/executor/${executorGroup._id}#provider-returns`
                }
            });
        }
    }

    const syncSucceeded = Boolean(providerResult.success);
    await ExecutorGroup.updateOne({ _id: executorGroup._id }, {
        $set: {
            lastApiReturnSyncAt: now,
            lastApiReturnSyncStatus: syncSucceeded ? 'success' : 'failed',
            lastApiReturnSyncMessage: syncSucceeded
                ? `تم فحص ${checkedCount} عملية واكتشاف ${returnedCount} عملية مسترجعة`
                : (providerResult.message || 'تعذر فحص عمليات المزود')
        }
    }).catch(() => {});

    return {
        success: syncSucceeded,
        checkedCount,
        returnedCount,
        newAlerts,
        failedCount: providerResult.failedCount || 0,
        message: providerResult.message || ''
    };
};

const reviewAllApiExecutors = async () => {
    const groups = await ExecutorGroup.find({ isApiBot: true, status: 'active' });
    for (const group of groups) {
        try {
            await syncProviderReturnedOperations(group, { limit: 25 });
        } catch (error) {
            logger.error('Automatic API provider return review failed', {
                executorGroupId: String(group._id),
                error: error.message
            });
        }
    }
};

const startApiProviderReturnMonitor = () => {
    if (returnMonitorTimer || process.env.API_RETURN_MONITOR_ENABLED === 'false') return returnMonitorTimer;
    const configured = Number(process.env.API_RETURN_MONITOR_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) && configured >= 60000
        ? configured
        : DEFAULT_RETURN_MONITOR_INTERVAL_MS;

    initialReturnMonitorTimer = setTimeout(() => {
        reviewAllApiExecutors().catch((error) => {
            logger.error('Initial API provider return review failed', { error: error.message });
        });
    }, 30000);
    if (typeof initialReturnMonitorTimer.unref === 'function') initialReturnMonitorTimer.unref();

    returnMonitorTimer = setInterval(() => {
        reviewAllApiExecutors().catch((error) => {
            logger.error('Scheduled API provider return review failed', { error: error.message });
        });
    }, intervalMs);
    if (typeof returnMonitorTimer.unref === 'function') returnMonitorTimer.unref();
    return returnMonitorTimer;
};

const withApiExecutorSerialization = async (executorGroupId, task) => {
    const key = String(executorGroupId);
    const previous = executorChains.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    executorChains.set(key, current);

    await previous.catch(() => {});
    try {
        return await task();
    } finally {
        release();
        if (executorChains.get(key) === current) executorChains.delete(key);
    }
};

module.exports = {
    DEFAULT_BALANCE_TOLERANCE,
    getBalanceTolerance,
    ensureApiReconciliationIndexes,
    startApiBalanceAudit,
    finishApiBalanceAudit,
    syncProviderReturnedOperations,
    reviewAllApiExecutors,
    startApiProviderReturnMonitor,
    withApiExecutorSerialization,
    extractProviderTransactionId
};
