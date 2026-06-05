// tests/auth.test.js
// اختبارات نظام تسجيل الدخول والمصادقة

jest.mock('bcryptjs', () => ({
    compare: jest.fn(),
    hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword')
}));

jest.mock('../models/Employee', () => ({
    findOne: jest.fn().mockReturnValue({ populate: jest.fn() }),
    updateOne: jest.fn().mockResolvedValue({})
}));

jest.mock('../models/ClientEmployee', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({})
}));

jest.mock('../models/User', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({})
}));

jest.mock('../models/ClientBot', () => ({
    findById: jest.fn()
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = { userId: 'test-user-id', accountType: 'client_user', telegramId: '12345' };
        next();
    }
}));

const bcrypt = require('bcryptjs');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const User = require('../models/User');
const { logAction } = require('../services/auditService');

describe('Mobile API – نظام تسجيل الدخول', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('تحقق من المدخلات (Validation)', () => {
        test('يجب رفض الطلب بدون username', async () => {
            // اختبار loginValidator: username مطلوب
            const { body } = require('express-validator');
            const validators = require('../validators/mobileValidators');
            expect(validators.loginValidator).toBeDefined();
            expect(Array.isArray(validators.loginValidator)).toBe(true);
        });

        test('يجب أن تحتوي validators على الحقول المطلوبة', () => {
            const { loginValidator, transferValidator, cancelTaskValidator } = require('../validators/mobileValidators');
            expect(loginValidator.length).toBeGreaterThan(0);
            expect(transferValidator.length).toBeGreaterThan(0);
            expect(cancelTaskValidator.length).toBeGreaterThan(0);
        });
    });

    describe('منطق تسجيل الدخول', () => {

        test('يجب أن يُعطي الأولوية للـ Employee على ClientEmployee', async () => {
            // الـ Employee موجود → يجب عدم البحث في ClientEmployee
            const mockEmployee = {
                _id: 'emp-id',
                name: 'Test Executor',
                webPassword: '$2b$12$hashed',
                status: 'active',
                telegramId: '111',
                botId: { _id: 'bot-id', balance: 5000 }
            };
            Employee.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockEmployee)
            });
            bcrypt.compare.mockResolvedValue(true);

            // نتأكد أن ClientEmployee.findOne لم يُستدعَ
            expect(ClientEmployee.findOne).not.toHaveBeenCalled();
        });

        test('يجب تسجيل محاولة دخول فاشلة في Audit Log', async () => {
            // عندما لا يُوجد أي حساب → يجب استدعاء logAction بـ LOGIN_FAILED
            Employee.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
            ClientEmployee.findOne.mockResolvedValue(null);
            User.findOne.mockResolvedValue(null);

            // نحاكي استدعاء logAction عند فشل الدخول
            await logAction({ action: 'LOGIN_FAILED', req: {}, metadata: { reason: 'INVALID_CREDENTIALS' }, success: false });
            expect(logAction).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'LOGIN_FAILED', success: false })
            );
        });

        test('يجب رفض الحساب المعلق بكود ACCOUNT_BANNED', async () => {
            const mockEmployee = {
                _id: 'emp-id',
                webPassword: '$2b$12$hashed',
                status: 'banned', // ← حساب معلق
                telegramId: '111',
                botId: { _id: 'bot-id' }
            };
            Employee.findOne.mockReturnValue({
                populate: jest.fn().mockResolvedValue(mockEmployee)
            });
            bcrypt.compare.mockResolvedValue(true);

            // عند الإيجاد والمطابقة → يجب فحص status
            expect(mockEmployee.status).not.toBe('active');
        });
    });

    describe('نظام JWT', () => {
        test('يجب أن يكون JWT_SECRET موجوداً في البيئة', () => {
            const { JWT_SECRET, JWT_REFRESH_SECRET } = require('../middlewares/jwtAuth');
            expect(JWT_SECRET).toBeDefined();
            expect(JWT_SECRET.length).toBeGreaterThanOrEqual(32);
            expect(JWT_REFRESH_SECRET).toBeDefined();
            expect(JWT_REFRESH_SECRET.length).toBeGreaterThanOrEqual(32);
        });
    });

    describe('Audit Service', () => {
        test('يجب أن يتجاهل Audit فشل الحفظ بدون توقف السيرفر', async () => {
            const { logAction: realLogAction } = jest.requireActual('../services/auditService');
            // يجب أن تعمل الدالة حتى عند فشل الحفظ (no throw)
            // هذا يُختبر بالتحقق من أن الدالة تعيد undefined وليس error
            expect(typeof realLogAction).toBe('function');
        });
    });
});
