// services/bullQueueService.js
// ===============================================
// 📥 خدمة طوابير المهام الموزعة — BullMQ Queue Service
// ===============================================
'use strict';

const { isRedis, getRedisClient } = require('../config/redis');
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

/**
 * تهيئة طوابير BullMQ في حال وجود Redis
 */
const initBullMQ = () => {
    if (!isRedis()) return false;
    
    try {
        const { Queue, Worker } = require('bullmq');
        const redisConnection = getRedisClient();
        
        // 1. طابور العمليات (API Transfers)
        apiTransferQueue = new Queue('api-transfers-queue', { connection: redisConnection });
        apiTransferWorker = new Worker('api-transfers-queue', async (job) => {
            const { txId, apiGroupId } = job.data;
            logger.info(`[BullMQ Worker] Processing job ${job.id} for transaction ${txId}`);
            await queueService.processSingleJob(txId, apiGroupId);
        }, {
            connection: redisConnection,
            concurrency: 5
        });

        // 2. طابور الإشعارات (Notifications)
        notificationQueue = new Queue('notifications-queue', { connection: redisConnection });
        notificationWorker = new Worker('notifications-queue', async (job) => {
            const { userId, title, message, type } = job.data;
            logger.info(`[BullMQ Worker] Sending notification to ${userId}`);
            const Notification = require('../models/Notification');
            await Notification.create({ userId, title, message, type: type || 'system_alert' });
        }, {
            connection: redisConnection,
            concurrency: 10
        });

        // 3. طابور التقارير والتسويات (Reports & Settlements)
        reportQueue = new Queue('reports-queue', { connection: redisConnection });
        reportWorker = new Worker('reports-queue', async (job) => {
            const { action, date } = job.data;
            logger.info(`[BullMQ Worker] Generating report/settlement: ${action}`);
            if (action === 'daily_settlement') {
                const settlementService = require('./settlementService');
                await settlementService.generateDailySettlement(date ? new Date(date) : new Date());
            }
        }, { connection: redisConnection });

        // 4. طابور النسخ الاحتياطية (System Backups)
        backupQueue = new Queue('backups-queue', { connection: redisConnection });
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
        }, { connection: redisConnection });

        // 5. طابور المطابقة المالية (Reconciliation)
        reconciliationQueue = new Queue('reconciliations-queue', { connection: redisConnection });
        reconciliationWorker = new Worker('reconciliations-queue', async (job) => {
            const { date } = job.data;
            logger.info(`[BullMQ Worker] Running daily reconciliation...`);
            const reconciliationService = require('./reconciliationService');
            await reconciliationService.reconcileDaily(date ? new Date(date) : new Date());
        }, { connection: redisConnection });

        // مستمعو الأحداث للعمال
        const registerWorkerEvents = (worker, name) => {
            worker.on('completed', (job) => {
                logger.info(`[BullMQ ${name} Worker] Job ${job.id} completed successfully`);
            });
            worker.on('failed', (job, err) => {
                logger.error(`[BullMQ ${name} Worker] Job ${job ? job.id : 'unknown'} failed`, { error: err.message });
            });
        };

        registerWorkerEvents(apiTransferWorker, 'API Transfer');
        registerWorkerEvents(notificationWorker, 'Notification');
        registerWorkerEvents(reportWorker, 'Report');
        registerWorkerEvents(backupWorker, 'Backup');
        registerWorkerEvents(reconciliationWorker, 'Reconciliation');

        logger.info('✅ BullMQ Distributed Queues & Workers initialized successfully');
        return true;
    } catch (e) {
        logger.warn('⚠️ Failed to initialize BullMQ, falling back to in-memory processing', { error: e.message });
        return false;
    }
};

// تشغيل التهيئة تلقائياً عند بدء التشغيل
initBullMQ();

/**
 * إضافة عملية تحويل لطابور المعالجة
 */
const addTransferJob = async (txId, apiGroupId) => {
    if (isRedis() && apiTransferQueue) {
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
    initBullMQ
};
