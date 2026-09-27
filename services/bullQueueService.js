// services/bullQueueService.js
// ===============================================
// 📥 خدمة طوابير المهام الموزعة — BullMQ Queue Service
// ===============================================
'use strict';

const { isRedis, createBullMQConnection } = require('../config/redis');
const queueService = require('./queueService');
const logger = require('../utils/logger');
const {
    UNRESOLVED_CODE,
    guardAutomaticProviderRedispatch
} = require('./providerDispatchClaimService');
const { isBullmqWorkersEnabled } = require('../utils/runtimeControls');

// طوابير المهام
let apiTransferQueue = null;
let notificationQueue = null;
let reportQueue = null;
let backupQueue = null;
let reconciliationQueue = null;

// معالجو طوابير المهام (Workers)
let apiTransferWorker = null;
let notificationWorker = null;
let reportWorker = null;
let backupWorker = null;
let reconciliationWorker = null;
let bullmqReady = false;

const resetBullMQState = () => {
    apiTransferQueue = null;
    notificationQueue = null;
    reportQueue = null;
    backupQueue = null;
    reconciliationQueue = null;
    apiTransferWorker = null;
    notificationWorker = null;
    reportWorker = null;
    backupWorker = null;
    reconciliationWorker = null;
    bullmqReady = false;
};

const bullWorkersDisabled = () => !isBullmqWorkersEnabled();

const isApiTransferWorkerReady = () => Boolean(
    isRedis() && bullmqReady && apiTransferQueue && apiTransferWorker
);

/**
 * تهيئة طوابير BullMQ بعد اتصال Redis. إعادة الاستدعاء آمنة: إذا كانت
 * التهيئة اكتملت لا تُعاد، وإذا فشلت سابقاً تُعاد المحاولة حتى لا تُحتجز
 * عمليات API في Redis بلا عامل.
 */
const initBullMQ = () => {
    if (bullWorkersDisabled()) return false;
    if (isApiTransferWorkerReady()) return true;
    if (!isRedis()) return false;

    try {
        const { Queue, Worker } = require('bullmq');
        const queueConnection = createBullMQConnection();
        const workerConnection = createBullMQConnection();
        if (!queueConnection || !workerConnection) {
            logger.warn('⚠️ BullMQ skipped: dedicated Redis connection is unavailable');
            resetBullMQState();
            return false;
        }

        const nextApiTransferQueue = new Queue('api-transfers-queue', { connection: queueConnection });
        const nextApiTransferWorker = new Worker('api-transfers-queue', async (job) => {
            const { txId, apiGroupId } = job.data;
            logger.info(`[BullMQ Worker] Processing job ${job.id} for transaction ${txId}`);
            const guard = await guardAutomaticProviderRedispatch(txId);
            if (guard.handled) {
                logger.warn('[BullMQ Worker] retry skipped provider Payment', {
                    jobId: job.id,
                    txId,
                    reason: guard.reason,
                    code: guard.code || UNRESOLVED_CODE
                });
                return { skipped: true, code: guard.code || UNRESOLVED_CODE };
            }
            await queueService.processSingleJob(txId, apiGroupId);
        }, {
            connection: workerConnection,
            concurrency: 5
        });

        notificationQueue = new Queue('notifications-queue', { connection: queueConnection });
        notificationWorker = new Worker('notifications-queue', async (job) => {
            const { userId, title, message, type, dedupeKey } = job.data || {};
            logger.info(`[BullMQ Worker] Sending notification to ${userId}`);
            await recordInAppNotification({ userId, title, message, type, dedupeKey });
        }, {
            connection: workerConnection,
            concurrency: 10
        });

        reportQueue = new Queue('reports-queue', { connection: queueConnection });
        reportWorker = new Worker('reports-queue', async (job) => {
            const { action, date } = job.data;
            logger.info(`[BullMQ Worker] Generating report/settlement: ${action}`);
            if (action === 'daily_settlement') {
                const settlementService = require('./settlementService');
                await settlementService.generateDailySettlement(date ? new Date(date) : new Date());
            }
        }, { connection: workerConnection });

        backupQueue = new Queue('backups-queue', { connection: queueConnection });
        backupWorker = new Worker('backups-queue', async (job) => {
            logger.info(`[BullMQ Worker] Triggering system backup...`);
            const { exec } = require('child_process');
            return new Promise((resolve, reject) => {
                exec('sh ./scripts/backup.sh', (err, stdout, stderr) => {
                    if (err) {
                        logger.error('Backup failed via BullMQ', { error: err.message });
                        return reject(err);
                    }
                    logger.info('Backup completed successfully via BullMQ', { output: stdout });
                    resolve(stdout);
                });
            });
        }, { connection: workerConnection });

        reconciliationQueue = new Queue('reconciliations-queue', { connection: queueConnection });
        reconciliationWorker = new Worker('reconciliations-queue', async (job) => {
            const { date } = job.data;
            logger.info(`[BullMQ Worker] Running daily reconciliation...`);
            const reconciliationService = require('./reconciliationService');
            await reconciliationService.reconcileDaily(date ? new Date(date) : new Date());
        }, { connection: workerConnection });

        const registerWorkerEvents = (worker, name) => {
            worker.on('completed', (job) => {
                logger.info(`[BullMQ ${name} Worker] Job ${job.id} completed successfully`);
            });
            worker.on('failed', (job, err) => {
                logger.error(`[BullMQ ${name} Worker] Job ${job ? job.id : 'unknown'} failed`, { error: err.message });
            });
            worker.on('error', (err) => {
                logger.error(`[BullMQ ${name} Worker] error`, { error: err.message });
            });
        };

        registerWorkerEvents(nextApiTransferWorker, 'API Transfer');
        registerWorkerEvents(notificationWorker, 'Notification');
        registerWorkerEvents(reportWorker, 'Report');
        registerWorkerEvents(backupWorker, 'Backup');
        registerWorkerEvents(reconciliationWorker, 'Reconciliation');

        apiTransferQueue = nextApiTransferQueue;
        apiTransferWorker = nextApiTransferWorker;
        bullmqReady = true;
        logger.info('✅ BullMQ Distributed Queues & Workers initialized successfully');
        return true;
    } catch (e) {
        resetBullMQState();
        logger.warn('⚠️ Failed to initialize BullMQ, falling back to in-memory processing', { error: e.message });
        return false;
    }
};

/**
 * إضافة عملية تحويل لطابور المعالجة.
 * لا تُدفع المهمة إلى Redis إلا إذا كان العامل يعمل فعلياً، وإلا تُعالَج
 * في الذاكرة داخل نفس العملية حتى لا تبقى العملية في حالة «توجيه».
 */
const addTransferJob = async (txId, apiGroupId) => {
    if (bullWorkersDisabled()) return;
    const guard = await guardAutomaticProviderRedispatch(txId);
    if (guard.handled) {
        logger.warn('[BullMQ] refused to enqueue unresolved provider dispatch', {
            txId,
            apiGroupId,
            reason: guard.reason,
            code: guard.code || UNRESOLVED_CODE
        });
        return { queued: false, code: guard.code || UNRESOLVED_CODE };
    }
    initBullMQ();
    if (isApiTransferWorkerReady()) {
        try {
            await apiTransferQueue.add(`transfer_${txId}`, { txId, apiGroupId }, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: true,
                removeOnFail: false
            });
            logger.info('[BullMQ] Job added to distributed queue', { txId });
            return;
        } catch (err) {
            logger.warn('[BullMQ] Failed to add job to Redis queue, falling back to In-Memory', { error: err.message });
        }
    }
    await queueService.addJob(txId, apiGroupId);
};

/**
 * إضافة إشعار للمعالجة الخلفية
 */
const explicitNotificationKey = (dedupeKey) => {
    const key = String(dedupeKey || '').trim();
    return key || '';
};

const recordInAppNotification = async ({ userId, title, message, type, dedupeKey }) => {
    const Notification = require('../models/Notification');
    const key = explicitNotificationKey(dedupeKey);
    // No explicit key: same insert as main. Identical text is a new row.
    // An explicit key uses one upsert. Sequential calls keep a single row
    // without a unique index. Overlapping calls can insert more than one row
    // until notifications.dedupeKey_1 exists. A duplicate-key error is ignored
    // only when that index rejects the second insert. No wallet is changed.
    if (!key) {
        await Notification.create({
            userId,
            title,
            message,
            type: type || 'system_alert'
        });
        return;
    }
    try {
        await Notification.updateOne(
            { dedupeKey: key },
            {
                $setOnInsert: {
                    userId,
                    title,
                    message,
                    type: type || 'system_alert',
                    dedupeKey: key,
                    isRead: false
                }
            },
            { upsert: true }
        );
    } catch (error) {
        if (error && (error.code === 11000 || error.code === 11001)) return;
        throw error;
    }
};

const addNotificationJob = async (userId, title, message, type, dedupeKey) => {
    const key = explicitNotificationKey(dedupeKey);
    const payload = {
        userId,
        title,
        message,
        type: type || 'system_alert'
    };
    if (key) payload.dedupeKey = key;
    // In-app notifications are not dropped when workers are off. An explicit
    // event key is what a later worker shares with that direct write. Jobs
    // without a key are plain inserts and are not given a dedupe jobId.
    // Queued jobs are not deleted. WhatsApp, SMTP, and push stay on their
    // existing paths.
    if (bullWorkersDisabled()) {
        await recordInAppNotification(payload).catch(() => {});
        return;
    }
    initBullMQ();
    if (isRedis() && notificationQueue) {
        try {
            if (key) {
                await notificationQueue.add(`notify_${key}`, payload, { jobId: key });
            } else {
                await notificationQueue.add(`notify_${userId}_${Date.now()}`, payload);
            }
            return;
        } catch (err) {
            logger.warn('Failed to add notification to BullMQ', { error: err.message });
        }
    }
    await recordInAppNotification(payload).catch(() => {});
};

/**
 * إضافة مهمة توليد تسوية أو تقرير
 */
const addReportJob = async (action, date) => {
    if (bullWorkersDisabled()) return;
    if (isRedis() && reportQueue) {
        try {
            await reportQueue.add(`report_${action}_${Date.now()}`, { action, date });
            return;
        } catch (err) {
            logger.warn('Failed to add report job to BullMQ', { error: err.message });
        }
    }
    if (action === 'daily_settlement') {
        const settlementService = require('./settlementService');
        await settlementService.generateDailySettlement(date ? new Date(date) : new Date()).catch(()=>{});
    }
};

/**
 * إضافة مهمة نسخ احتياطي خلفية
 */
const addBackupJob = async () => {
    if (bullWorkersDisabled()) return;
    if (isRedis() && backupQueue) {
        try {
            await backupQueue.add(`backup_${Date.now()}`, {});
            return;
        } catch (err) {
            logger.warn('Failed to add backup job to BullMQ', { error: err.message });
        }
    }
};

/**
 * إضافة مهمة مطابقة مالية
 */
const addReconciliationJob = async (date) => {
    if (bullWorkersDisabled()) return;
    if (isRedis() && reconciliationQueue) {
        try {
            await reconciliationQueue.add(`reconciliation_${Date.now()}`, { date });
            return;
        } catch (err) {
            logger.warn('Failed to add reconciliation job to BullMQ', { error: err.message });
        }
    }
    const reconciliationService = require('./reconciliationService');
    await reconciliationService.reconcileDaily(date ? new Date(date) : new Date()).catch(()=>{});
};

module.exports = {
    addTransferJob,
    addNotificationJob,
    explicitNotificationKey,
    recordInAppNotification,
    addReportJob,
    addBackupJob,
    addReconciliationJob,
    initBullMQ,
    isApiTransferWorkerReady,
    resetBullMQState
};
