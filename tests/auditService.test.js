// tests/auditService.test.js
'use strict';

// محاكاة موديل AuditLog
jest.mock('../models/AuditLog', () => {
    const mockSave = jest.fn().mockResolvedValue(true);
    const mockFind = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ action: 'LOGIN_SUCCESS', performedByName: 'أحمد' }])
    });
    const mockFindOne = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ hash: 'mock-last-hash' })
    });

    const MockAuditLog = jest.fn().mockImplementation(function(data) {
        Object.assign(this, data);
        this.save = mockSave;
    });

    MockAuditLog.find = mockFind;
    MockAuditLog.findOne = mockFindOne;
    MockAuditLog.mockSave = mockSave;
    MockAuditLog.mockFind = mockFind;
    MockAuditLog.mockFindOne = mockFindOne;

    return MockAuditLog;
});

const { logAction, getAuditLogs } = require('../services/auditService');
const AuditLog = require('../models/AuditLog');

describe('Audit Service Tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('يجب تسجيل العملية بشكل صحيح بدون كائن طلب (System Event)', async () => {
        await logAction({
            action: 'SETTINGS_CHANGED',
            performedByName: 'النظام',
            newData: { rate: 6.40 }
        });

        expect(AuditLog).toHaveBeenCalled();
        expect(AuditLog.mockSave).toHaveBeenCalled();
    });

    test('يجب تسجيل العملية مع وجود كائن طلب وتحديد الـ IP والمتصفح والمسار', async () => {
        const req = {
            headers: {
                'x-forwarded-for': '1.2.3.4, 5.6.7.8',
                'user-agent': 'Mozilla/5.0'
            },
            ip: '127.0.0.1',
            method: 'POST',
            originalUrl: '/api/mobile/client/new-transfer'
        };

        await logAction({
            action: 'TRANSFER_CREATED',
            req,
            performedById: 'user-id-123',
            performedByName: 'أحمد محمد',
            newData: { amount: 100 }
        });

        expect(AuditLog).toHaveBeenCalledWith(expect.objectContaining({
            action: 'TRANSFER_CREATED',
            ipAddress: '1.2.3.4',
            userAgent: 'Mozilla/5.0',
            endpoint: 'POST /api/mobile/client/new-transfer',
            performedBy: 'user-id-123'
        }));
    });

    test('يجب حجب الحقول الحساسة مثل كلمة المرور والرمز', async () => {
        await logAction({
            action: 'USER_CREATED',
            newData: {
                name: 'خالد',
                webPassword: 'secretpassword123',
                token: 'sensitive-token'
            }
        });

        expect(AuditLog).toHaveBeenCalledWith(expect.objectContaining({
            newData: {
                name: 'خالد',
                webPassword: '[REDACTED]',
                token: '[REDACTED]'
            }
        }));
    });

    test('يجب ألا يرمي خطأ إذا فشل الحفظ في قاعدة البيانات', async () => {
        AuditLog.mockSave.mockRejectedValueOnce(new Error('Save Error'));
        
        // لا يجب أن يرمي الخطأ
        await expect(logAction({ action: 'LOGIN_SUCCESS' })).resolves.not.toThrow();
    });

    test('يجب جلب سجلات التدقيق بشكل صحيح باستخدامgetAuditLogs', async () => {
        const logs = await getAuditLogs('entity-123', { limit: 10, skip: 5, action: 'LOGIN_SUCCESS' });
        
        expect(AuditLog.find).toHaveBeenCalledWith({
            $or: [{ performedBy: 'entity-123' }, { targetId: 'entity-123' }],
            action: 'LOGIN_SUCCESS'
        });
        expect(logs).toEqual([{ action: 'LOGIN_SUCCESS', performedByName: 'أحمد' }]);
    });

    test('يجب حساب الهاش وربط السجل بالسجل السابق بشكل سليم', async () => {
        const req = { headers: {}, ip: '127.0.0.1' };
        await logAction({
            action: 'LOGIN_SUCCESS',
            req,
            performedByName: 'أحمد محمد'
        });

        expect(AuditLog.mockFindOne).toHaveBeenCalled();
        expect(AuditLog).toHaveBeenCalledWith(expect.objectContaining({
            previousHash: 'mock-last-hash',
            hash: expect.any(String)
        }));
    });
});
