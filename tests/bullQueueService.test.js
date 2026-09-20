// tests/bullQueueService.test.js
'use strict';

// محاكاة النماذج والخدمات والعمليات الخارجية بشكل عالمي في أعلى الملف لمنع الـ Hoisting والاتصال الفعلي
jest.mock('../models/Notification', () => ({
    create: jest.fn().mockResolvedValue({})
}));

jest.mock('../services/settlementService', () => ({
    generateDailySettlement: jest.fn().mockResolvedValue({})
}));

jest.mock('../services/reconciliationService', () => ({
    reconcileDaily: jest.fn().mockResolvedValue({})
}));

jest.mock('child_process', () => ({
    exec: jest.fn().mockImplementation((cmd, cb) => {
        cb(null, 'stdout output', '');
    })
}));

describe('BullMQ Queue Service Tests (Local / Memory Fallback)', () => {
    let Notification, settlementService, reconciliationService;

    beforeEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
        
        // إعادة التحميل بعد resetModules للحصول على النسخ المحاكاة الصحيحة من السجل
        Notification = require('../models/Notification');
        settlementService = require('../services/settlementService');
        reconciliationService = require('../services/reconciliationService');

        jest.mock('../config/redis', () => ({
            isRedis: () => false,
            getRedisClient: () => null,
            createBullMQConnection: () => null
        }));
        
        jest.mock('../services/queueService', () => ({
            addJob: jest.fn().mockResolvedValue(true)
        }));
    });

    afterEach(() => {
        jest.unmock('../config/redis');
        jest.unmock('../services/queueService');
    });

    test('يجب استدعاء طابور الذاكرة الداخلي في حال عدم وجود Redis لمهام التحويل', async () => {
        const queueService = require('../services/queueService');
        const { addTransferJob } = require('../services/bullQueueService');
        
        await addTransferJob('tx-123', 'group-abc');
        expect(queueService.addJob).toHaveBeenCalledWith('tx-123', 'group-abc');
    });

    test('يجب استدعاء التخزين المباشر أو الـ fallback للوظائف الأخرى في حال عدم وجود Redis', async () => {
        const { addNotificationJob, addReportJob, addReconciliationJob, addBackupJob } = require('../services/bullQueueService');

        await addNotificationJob('user123', 'Title', 'Msg', 'alert');
        expect(Notification.create).toHaveBeenCalled();

        await addReportJob('daily_settlement', new Date());
        expect(settlementService.generateDailySettlement).toHaveBeenCalled();

        await addReconciliationJob(new Date());
        expect(reconciliationService.reconcileDaily).toHaveBeenCalled();

        await expect(addBackupJob()).resolves.not.toThrow();
    });

    test('يجب ألا تفشل دالة التهيئة initBullMQ عند عدم وجود Redis وتعود false', () => {
        const { initBullMQ } = require('../services/bullQueueService');
        const result = initBullMQ();
        expect(result).toBe(false);
    });
});

describe('BullMQ Queue Service Tests (Redis / Distributed Queue)', () => {
    let mockAdd;
    let mockOn;
    let mockWorkerCallbacks = {};
    let Notification, settlementService, reconciliationService, childProcess;

    beforeEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();

        // إعادة التحميل بعد resetModules للحصول على النسخ المحاكاة الصحيحة من السجل
        Notification = require('../models/Notification');
        settlementService = require('../services/settlementService');
        reconciliationService = require('../services/reconciliationService');
        childProcess = require('child_process');

        mockAdd = jest.fn();
        mockOn = jest.fn();
        mockWorkerCallbacks = {};

        jest.mock('../config/redis', () => ({
            isRedis: () => true,
            getRedisClient: () => ({ options: { maxRetriesPerRequest: 3 } }),
            createBullMQConnection: () => ({ options: { maxRetriesPerRequest: null } })
        }));

        jest.mock('../services/queueService', () => ({
            processSingleJob: jest.fn().mockResolvedValue(true),
            addJob: jest.fn().mockResolvedValue(true)
        }));

        jest.mock('bullmq', () => {
            const Queue = jest.fn().mockImplementation((name) => ({
                add: mockAdd
            }));
            const Worker = jest.fn().mockImplementation((name, processor, options) => {
                mockWorkerCallbacks[name] = processor;
                return {
                    on: mockOn
                };
            });
            return { Queue, Worker };
        });
    });

    afterEach(() => {
        jest.unmock('../config/redis');
        jest.unmock('../services/queueService');
        jest.unmock('bullmq');
    });

    test('يجب تهيئة BullMQ بنجاح وإنشاء الـ Workers والمستمعين', () => {
        const { initBullMQ } = require('../services/bullQueueService');
        const result = initBullMQ();
        expect(result).toBe(true);
        expect(mockOn).toHaveBeenCalledWith('completed', expect.any(Function));
        expect(mockOn).toHaveBeenCalledWith('failed', expect.any(Function));
    });

    test('يجب إضافة مهمة بنجاح لكل نوع من طوابير BullMQ', async () => {
        const { initBullMQ, addTransferJob, addNotificationJob, addReportJob, addBackupJob, addReconciliationJob } = require('../services/bullQueueService');
        initBullMQ();
        
        mockAdd.mockResolvedValue({ id: 'job-ok' });
        
        await addTransferJob('tx-123', 'group-abc');
        await addNotificationJob('u1', 'Title', 'Message', 'alert');
        await addReportJob('daily_settlement', new Date());
        await addBackupJob();
        await addReconciliationJob(new Date());

        expect(mockAdd).toHaveBeenCalledTimes(5);
    });

    test('يجب تشغيل معالج الـ Worker الخاص بالإشعارات وتخزين الإشعار بقاعدة البيانات', async () => {
        const { initBullMQ } = require('../services/bullQueueService');
        initBullMQ();

        const handler = mockWorkerCallbacks['notifications-queue'];
        await handler({ id: 'job-notify', data: { userId: 'u1', title: 'T', message: 'M', type: 'system' } });
        
        expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1',
            title: 'T',
            message: 'M'
        }));
    });

    test('يجب تشغيل معالج الـ Worker الخاص بالتقارير وتوليد تسوية يومية', async () => {
        const { initBullMQ } = require('../services/bullQueueService');
        initBullMQ();

        const handler = mockWorkerCallbacks['reports-queue'];
        await handler({ id: 'job-report', data: { action: 'daily_settlement', date: '2026-06-08' } });
        
        expect(settlementService.generateDailySettlement).toHaveBeenCalled();
    });

    test('يجب تشغيل معالج الـ Worker الخاص بالمطابقة وتشغيل المطابقة اليومية', async () => {
        const { initBullMQ } = require('../services/bullQueueService');
        initBullMQ();

        const handler = mockWorkerCallbacks['reconciliations-queue'];
        await handler({ id: 'job-reconcile', data: { date: '2026-06-08' } });
        
        expect(reconciliationService.reconcileDaily).toHaveBeenCalled();
    });

    test('يجب تشغيل معالج الـ Worker الخاص بالنسخ الاحتياطي ومحاكاة سكربت sh', async () => {
        const { initBullMQ } = require('../services/bullQueueService');
        initBullMQ();

        const handler = mockWorkerCallbacks['backups-queue'];
        const p = handler({ id: 'job-backup' });
        await expect(p).resolves.toBe('stdout output');
        expect(childProcess.exec).toHaveBeenCalledWith('sh ./scripts/backup.sh', expect.any(Function));
    });

    test('falls back to in-memory when the API worker fails to start so jobs are not stranded in Redis', async () => {
        jest.resetModules();
        jest.doMock('../config/redis', () => ({
            isRedis: () => true,
            getRedisClient: () => ({ options: { maxRetriesPerRequest: 3 } }),
            createBullMQConnection: () => ({ options: { maxRetriesPerRequest: null } })
        }));
        const addJob = jest.fn().mockResolvedValue(true);
        jest.doMock('../services/queueService', () => ({
            processSingleJob: jest.fn().mockResolvedValue(true),
            addJob
        }));
        jest.doMock('bullmq', () => ({
            Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
            Worker: jest.fn().mockImplementation((name) => {
                if (name === 'api-transfers-queue') {
                    throw new Error('BullMQ: Your redis options maxRetriesPerRequest must be null.');
                }
                return { on: mockOn };
            })
        }));

        const queueService = require('../services/queueService');
        const { initBullMQ, addTransferJob, isApiTransferWorkerReady } = require('../services/bullQueueService');

        expect(initBullMQ()).toBe(false);
        expect(isApiTransferWorkerReady()).toBe(false);

        await addTransferJob('tx-stuck', 'api-group');

        expect(mockAdd).not.toHaveBeenCalled();
        expect(queueService.addJob).toHaveBeenCalledWith('tx-stuck', 'api-group');
    });

    test('retries BullMQ init after Redis becomes available', async () => {
        jest.resetModules();
        const redisState = { available: false };
        jest.doMock('../config/redis', () => ({
            isRedis: () => redisState.available,
            getRedisClient: () => (redisState.available ? { options: { maxRetriesPerRequest: 3 } } : null),
            createBullMQConnection: () => (redisState.available ? { options: { maxRetriesPerRequest: null } } : null)
        }));
        const addJob = jest.fn().mockResolvedValue(true);
        jest.doMock('../services/queueService', () => ({
            processSingleJob: jest.fn().mockResolvedValue(true),
            addJob
        }));
        jest.doMock('bullmq', () => {
            const Queue = jest.fn().mockImplementation(() => ({ add: mockAdd }));
            const Worker = jest.fn().mockImplementation((name, processor) => {
                mockWorkerCallbacks[name] = processor;
                return { on: mockOn };
            });
            return { Queue, Worker };
        });

        mockAdd.mockResolvedValue({ id: 'job-ok' });
        const queueService = require('../services/queueService');
        const { addTransferJob, initBullMQ, isApiTransferWorkerReady } = require('../services/bullQueueService');

        await addTransferJob('tx-before-redis', 'group-1');
        expect(queueService.addJob).toHaveBeenCalledWith('tx-before-redis', 'group-1');
        expect(isApiTransferWorkerReady()).toBe(false);

        redisState.available = true;
        expect(initBullMQ()).toBe(true);
        expect(isApiTransferWorkerReady()).toBe(true);

        await addTransferJob('tx-after-redis', 'group-2');
        expect(mockAdd).toHaveBeenCalledWith(
            'transfer_tx-after-redis',
            { txId: 'tx-after-redis', apiGroupId: 'group-2' },
            expect.any(Object)
        );
    });
});
