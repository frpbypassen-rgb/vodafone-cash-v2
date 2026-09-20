// services/bullQueueService.js
// ===============================================
// 📥 خدمة طوابير المهام الموزعة — BullMQ Queue Service
// ===============================================
'use strict';

const { isRedis, createBullMQConnection } = require('../config/redis');
const queueService = require('./queueService');
const logger = require('../utils/logger');

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

const isApiTransferWorkerReady = () => Boolean(
    isRedis() && bullmqReady && apiTransferQueue && apiTransferWorker
);

/**
 * تهيئة طوابير BullMQ بعد اتصال Redis. إعادة الاستدعاء آمنة: إذا كانت
 * التهيئة اكتملت لا تُعاد، وإذا فشلت سابقاً تُعاد المحاولة حتى لا تُحتجز
 * عمليات API في Redis بلا عامل.
 */
const initBullMQ = () => {
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
            await queueService.processSingleJob(txId, apiGroupId);
        }, {
            connection: workerConnection,
            concurrency: 5
        });

        notificationQueue = new Queue('notifications-queue', { connection: queueConnection });
        notificationWorker = new Worker('notifications-queue', async (job) => {
            const { userId, title, message, type } = job.data;
            logger.info(`[BullMQ Worker] Sending notification to ${userId}`);
            const Notification = require('../models/Notification');
            await Notification.create({ userId, title, message, type: type || 'system_alert' });
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
const addNotificationJob = async (userId, title, message, type) => {
    initBullMQ();
    if (isRedis() && notificationQueue) {
        try {
            await notificationQueue.add(`notify_${userId}_${Date.now()}`, { userId, title, message, type });
            return;
        } catch (err) {
            logger.warn('Failed to add notification to BullMQ', { error: err.message });
        }
    }
    const Notification = require('../models/Notification');
    await Notification.create({ userId, title, message, type: type || 'system_alert' }).catch(()=>{});
};

/**
 * إضافة مهمة توليد تسوية أو تقرير
 */
const addReportJob = async (action, date) => {
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
    addReportJob,
    addBackupJob,
    addReconciliationJob,
    initBullMQ,
    isApiTransferWorkerReady
};
