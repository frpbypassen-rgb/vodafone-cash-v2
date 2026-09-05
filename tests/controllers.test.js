// tests/controllers.test.js
'use strict';

const mongoose = require('mongoose');

// محاكاة متزامنة لـ setImmediate لمنع استدعاء require بعد انتهاء بيئة Jest
global.setImmediate = (fn) => fn();

// محاكاة الموديلات وقاعدة البيانات لتسريع الاختبارات وعزلها
jest.mock('../models/User');
jest.mock('../models/ClientEmployee');
jest.mock('../models/ClientCompany');
jest.mock('../models/Transaction');
jest.mock('../models/Settings');
jest.mock('../models/SubAccount');
jest.mock('../models/Counter');
jest.mock('../models/Ledger');
jest.mock('../models/Admin');
jest.mock('../models/Employee');
jest.mock('../models/ExecutorGroup');
jest.mock('../models/Notification', () => ({
    create: jest.fn().mockResolvedValue({})
}));
jest.mock('../services/transferService');
jest.mock('../services/auditService');
jest.mock('../services/transferCooldownService', () => {
    class TransferCooldownError extends Error {
        constructor(details) {
            super(details.message);
            Object.assign(this, details);
            this.name = 'TransferCooldownError';
            this.statusCode = this.statusCode || 429;
        }
    }

    return {
        TransferCooldownError,
        acquireTransferCooldown: jest.fn(),
        releaseTransferCooldown: jest.fn()
    };
});

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const SubAccount = require('../models/SubAccount');
const Counter = require('../models/Counter');
const Ledger = require('../models/Ledger');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const transferService = require('../services/transferService');
const {
    TransferCooldownError,
    acquireTransferCooldown,
    releaseTransferCooldown
} = require('../services/transferCooldownService');

// محاكاة الاتصال بقاعدة البيانات لتجنب البحث الفعلي عن الـ Replica Set
mongoose.connection = {
    db: {
        admin: () => ({
            command: jest.fn().mockRejectedValue(new Error('No replication'))
        })
    }
};

describe('Client Auth Controller Tests', () => {
    let req, res;
    const clientAuthController = require('../controllers/clientAuthController');

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            session: {},
            body: {},
            ip: '127.0.0.1',
            headers: { 'user-agent': 'Jest Test' }
        };
        res = {
            render: jest.fn(),
            redirect: jest.fn(),
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
            set: jest.fn()
        };
    });

    test('getLogin - يجب إعادة التوجيه للوحة التحكم إذا كان مسجلاً بالفعل', () => {
        req.session.isClientLoggedIn = true;
        clientAuthController.getLogin(req, res);
        expect(res.redirect).toHaveBeenCalledWith('/client/dashboard');
    });

    test('getLogin - يجب عرض صفحة تسجيل الدخول إذا لم يكن مسجلاً', () => {
        req.session.isClientLoggedIn = false;
        clientAuthController.getLogin(req, res);
        expect(res.redirect).toHaveBeenCalledWith('/login');
    });

    test('getRegister - يجب إعادة التوجيه للوحة التحكم إذا كان مسجلاً', () => {
        req.session.isClientLoggedIn = true;
        clientAuthController.getRegister(req, res);
        expect(res.redirect).toHaveBeenCalledWith('/client/dashboard');
    });

    test('getRegister - يجب عرض صفحة التسجيل مع ضبط الكاش', () => {
        req.session.isClientLoggedIn = false;
        clientAuthController.getRegister(req, res);
        expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        expect(res.render).toHaveBeenCalledWith('client/register', expect.objectContaining({
            error: null,
            success: false,
            refCode: null,
            createdUsername: null,
            createdPassword: null,
            formData: {},
            restoreNewAgentVerified: false,
            restoredAgentName: ''
        }));
        const viewData = res.render.mock.calls[0][1];
        expect(Array.isArray(viewData.libyanCities)).toBe(true);
        expect(viewData.libyanCities.length).toBeGreaterThan(0);
    });

    test('postRegister - يجب حفظ بيانات التسجيل غير الحساسة عند خطأ التحقق', async () => {
        req.body = {
            accountType: 'new',
            agentCode: '1234',
            newFullName: 'أحمد علي',
            newPhone: '0912345678',
            newUsername: 'ahmed_ali',
            nationality: 'libyan',
            newCity: 'طرابلس',
            newPassword: 'secret1',
            newPasswordConfirm: 'secret2'
        };

        await clientAuthController.postRegister(req, res);

        expect(res.render).toHaveBeenCalledWith('client/register', expect.objectContaining({
            success: false,
            refCode: null,
            formData: expect.objectContaining({
                accountType: 'new',
                agentCode: '1234',
                newFullName: 'أحمد علي',
                newPhone: '0912345678',
                newUsername: 'ahmed_ali'
            })
        }));
        const viewData = res.render.mock.calls[0][1];
        expect(viewData.formData.newPassword).toBeUndefined();
        expect(viewData.formData.newPasswordConfirm).toBeUndefined();
    });

    test('logout - يجب تدمير الجلسة وإعادة التوجيه لصفحة الدخول', () => {
        req.session.destroy = jest.fn();
        clientAuthController.logout(req, res);
        expect(req.session.destroy).toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/login');
    });
});

describe('Executor Controller Tests', () => {
    let req, res;
    const executorController = require('../controllers/executor/executorController');

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            user: { userId: 'exec1', executorGroupId: 'group1', accountType: 'executor' },
            params: { id: 'tx123' },
            body: {},
            headers: {}
        };
        res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };
    });

    test('getLiveTasks - يجب إرجاع المهام بنجاح للمنفذين', async () => {
        const mockTasks = [{ _id: 'tx123', status: 'processing' }];
        
        const chain = {
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(mockTasks)
        };
        Transaction.find = jest.fn().mockReturnValue(chain);

        await executorController.getLiveTasks(req, res);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            tasks: mockTasks
        }));
    });

    test('acceptTask - يجب قبول المهمة بنجاح وتحديث حالتها', async () => {
        const mockEmp = { _id: 'emp1', name: 'Executor Ali', groupId: { _id: 'g1' } };
        Employee.findOne = jest.fn().mockReturnValue({
            populate: jest.fn().mockResolvedValue(mockEmp)
        });

        const mockTx = { _id: 'tx123', customId: 'ATT-001', amount: 500 };
        Transaction.findOneAndUpdate = jest.fn().mockResolvedValue(mockTx);

        await executorController.acceptTask(req, res);
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('cancelTask - يجب استدعاء خدمة إلغاء الحوالة وإرجاع النتيجة', async () => {
        req.body.reason = 'wrong phone number';
        const mockResult = { statusCode: 200, success: true, message: 'Cancelled successfully' };
        transferService.cancelTransfer.mockResolvedValue(mockResult);

        await executorController.cancelTask(req, res);
        expect(transferService.cancelTransfer).toHaveBeenCalledWith({
            taskId: 'tx123',
            userId: 'exec1',
            reason: 'wrong phone number',
            req
        });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(mockResult);
    });

    test('completeTask - يجب استكمال المهمة بنجاح وخصم الرصيد للجروب وتغيير الحالة', async () => {
        req.body.imageBase64 = 'data:image/jpeg;base64,abcdef';
        req.body.senderPhone = '0912345678';

        const mockTx = {
            _id: 'tx123',
            customId: 'ATT-002',
            amount: 100,
            transferType: 'vodafone',
            status: 'accepted',
            operatorId: 'emp1',
            save: jest.fn().mockResolvedValue(true)
        };
        Transaction.findById = jest.fn().mockResolvedValue(mockTx);

        const mockEmp = {
            _id: 'emp1',
            name: 'Executor Ali',
            groupId: { _id: 'g1', parentGroupId: 'parent_g1' }
        };
        Employee.findOne = jest.fn().mockReturnValue({
            populate: jest.fn().mockResolvedValue(mockEmp)
        });

        ExecutorGroup.findByIdAndUpdate = jest.fn().mockResolvedValue({});

        await executorController.completeTask(req, res);

        expect(Transaction.findById).toHaveBeenCalledWith('tx123');
        expect(ExecutorGroup.findByIdAndUpdate).toHaveBeenCalledTimes(2); // للجروب والجروب الأب
        expect(mockTx.status).toBe('completed');
        expect(mockTx.proofImage).toBeDefined();
        expect(mockTx.executorSenderPhone).toBe('0912345678');
        expect(res.json).toHaveBeenCalledWith({ success: true, message: 'تم إرسال الإثبات بنجاح' });
    });
});

describe('Client Transaction Controller Tests', () => {
    let req, res;
    const clientTransactionController = require('../controllers/clientTransactionController');

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            session: { clientId: 'client123', accountType: 'user' },
            body: { transactionId: '507f1f77bcf86cd799439011', complaintText: 'complaint info' },
            xhr: true,
            headers: {}
        };
        res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis()
        };
        acquireTransferCooldown.mockResolvedValue({
            lock: {},
            guardFields: {
                requestOwnerKey: 'wallet:User:client123',
                canonicalServiceKey: 'vodafone',
                canonicalRecipient: '01012345678'
            }
        });
        releaseTransferCooldown.mockResolvedValue(undefined);
    });

    test('postComplaint - يجب تحديث نص الشكوى وحفظ العملية بنجاح', async () => {
        const mockTx = {
            _id: '507f1f77bcf86cd799439011',
            save: jest.fn().mockResolvedValue(true)
        };
        Transaction.findOne = jest.fn().mockResolvedValue(mockTx);
        User.findById = jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'client123', phone: '01012345678', status: 'active', role: 'user' }) })
        });

        await clientTransactionController.postComplaint(req, res);
        expect(Transaction.findOne).toHaveBeenCalled();
        expect(mockTx.complaintText).toBe('complaint info');
        expect(mockTx.emergencyAlert).toBe('شكوى عميل: complaint info');
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('postTransfer - يجب إنشاء التحويل بنجاح للوكيل المباشر (User)', async () => {
        req.body = {
            amount: '100',
            phone: '01012345678',
            type: 'كاش',
            name: 'Receipent Name',
            number: '123'
        };

        const mockUser = {
            _id: 'client123',
            name: 'Client User Name',
            tier: 1,
            balance: 1000,
            creditLimit: 0,
            phone: '01012345678'
        };
        User.findById = jest.fn().mockResolvedValue(mockUser);
        User.findOneAndUpdate = jest.fn().mockResolvedValue(mockUser);

        Settings.findOne = jest.fn().mockResolvedValue({
            rateLevel1: 6.40,
            rateLevel2: 6.45,
            rateLevel3: 6.50
        });

        Counter.findOneAndUpdate = jest.fn().mockResolvedValue({ value: 42 });
        Ledger.prototype.save = jest.fn().mockResolvedValue({});
        Transaction.prototype.save = jest.fn().mockResolvedValue({});

        await clientTransactionController.postTransfer(req, res);

        expect(User.findById).toHaveBeenCalledWith('client123');
        expect(User.findOneAndUpdate).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            message: 'تم الإرسال بنجاح.'
        }));
    });

    test('postTransfer - يحسب تحويل سيفا بقيمة 10 وسعر 15 على أنه 150 دينار', async () => {
        req.body = {
            amount: '10',
            phone: '123456789',
            number: '123456789',
            type: 'سيفا النيجر',
            name: 'Nita Recipient',
            serviceSubtype: 'nita',
            city: 'Niamey',
            dataEntryAcknowledged: 'true'
        };

        const mockUser = {
            _id: 'client123',
            name: 'Client User Name',
            tier: 1,
            balance: 1000,
            creditLimit: 0,
            phone: '01012345678'
        };
        User.findById = jest.fn().mockResolvedValue(mockUser);
        User.findOneAndUpdate = jest.fn().mockResolvedValue(mockUser);
        Settings.findOne = jest.fn().mockResolvedValue({
            rateLevel1: 6.40,
            sefaNigerRateLevel1: 15
        });
        Counter.findOneAndUpdate = jest.fn().mockResolvedValue({ value: 44 });
        Ledger.prototype.save = jest.fn().mockResolvedValue({});
        Transaction.prototype.save = jest.fn().mockResolvedValue({});

        await clientTransactionController.postTransfer(req, res);

        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ _id: 'client123', balance: { $gte: 150 } }),
            expect.objectContaining({ $inc: { balance: -150 } }),
            expect.any(Object)
        );
        expect(Transaction).toHaveBeenCalledWith(expect.objectContaining({
            amount: 10,
            costLYD: 150,
            exchangeRate: 15,
            transferType: 'sefa_niger',
            serviceDetails: expect.objectContaining({
                subtype: 'nita',
                city: 'Niamey',
                amountCurrency: 'XOF',
                rateDirection: 'source_to_lyd',
                dataEntryAcknowledged: true
            })
        }));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('postTransfer - يرجع مهلة التكرار قبل خصم الرصيد', async () => {
        req.body = {
            amount: '100',
            phone: '01012345678',
            type: 'كاش',
            name: 'Recipient Name',
            number: '01012345678'
        };
        User.findById = jest.fn().mockResolvedValue({
            _id: 'client123',
            name: 'Client User Name',
            tier: 1,
            balance: 1000,
            creditLimit: 0,
            phone: '01012345678'
        });
        Settings.findOne = jest.fn().mockResolvedValue({ rateLevel1: 6.4 });
        Counter.findOneAndUpdate = jest.fn().mockResolvedValue({ value: 43 });
        acquireTransferCooldown.mockRejectedValueOnce(new TransferCooldownError({
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldownType: 'different_amount',
            retryAfterSeconds: 90,
            retryAt: '2026-08-09T12:01:30.000Z',
            message: 'تم إدخال تحويل سابق إلى الرقم نفسه بقيمة مختلفة. أعد المحاولة بعد 90 ثانية.'
        }));

        await clientTransactionController.postTransfer(req, res);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldownType: 'different_amount',
            retryAfterSeconds: 90
        }));
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('postTransfer - يفشل قبل الخصم عند غياب Mongo transactions في production', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalRequirement = process.env.MONGO_TRANSACTIONS_REQUIRED;
        process.env.NODE_ENV = 'production';
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
        req.body = {
            amount: '100',
            phone: '01012345678',
            type: 'كاش',
            name: 'Recipient Name',
            number: '01012345678'
        };

        try {
            await clientTransactionController.postTransfer(req, res);

            expect(res.status).toHaveBeenCalledWith(503);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                success: false,
                code: 'FINANCIAL_TRANSACTIONS_UNAVAILABLE'
            }));
            expect(User.findOneAndUpdate).not.toHaveBeenCalled();
            expect(Transaction.prototype.save).not.toHaveBeenCalled();
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalRequirement === undefined) delete process.env.MONGO_TRANSACTIONS_REQUIRED;
            else process.env.MONGO_TRANSACTIONS_REQUIRED = originalRequirement;
        }
    });
});
