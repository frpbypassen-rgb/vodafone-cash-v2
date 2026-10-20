'use strict';

jest.mock('../models/Employee', () => ({ exists: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/RegistrationRequest', () => ({
    findOne: jest.fn(),
    create: jest.fn()
}));
jest.mock('../models/Admin', () => ({ find: jest.fn() }));
jest.mock('../models/Notification', () => ({ create: jest.fn() }));

const Employee = require('../models/Employee');
const RegistrationRequest = require('../models/RegistrationRequest');
const Admin = require('../models/Admin');
const controller = require('../controllers/executorAuthController');

describe('Executor public registration', () => {
    let req;
    let res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            session: {},
            body: {},
            ip: '127.0.0.1',
            headers: { 'user-agent': 'Jest' }
        };
        res = {
            render: jest.fn(),
            redirect: jest.fn()
        };
        Employee.exists.mockResolvedValue(null);
        RegistrationRequest.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
        RegistrationRequest.create.mockResolvedValue({ refCode: 'REG-TEST-001' });
        Admin.find.mockResolvedValue([]);
    });

    test('renders a clean registration form', () => {
        controller.getRegister(req, res);

        expect(res.render).toHaveBeenCalledWith('executor/register', {
            error: null,
            success: null,
            formData: {},
            executorServiceOptions: expect.arrayContaining([
                expect.objectContaining({ key: 'vodafone' }),
                expect.objectContaining({ key: 'postal' })
            ])
        });
    });

    test('submits a normalized pending request without exposing the password in view data', async () => {
        req.body = {
            companyName: 'منفذ التسجيل التجريبي',
            managerName: 'مدير التسجيل التجريبي',
            phone: '091-123-4567',
            webUsername: 'REGISTERED_01',
            executorServiceKey: 'postal',
            webPassword: 'secret12',
            confirmPassword: 'secret12'
        };

        await controller.postRegister(req, res);

        expect(RegistrationRequest.create).toHaveBeenCalledWith(expect.objectContaining({
            accountType: 'executor',
            phone: '0911234567',
            username: 'registered_01@ahram.com',
            executorServiceKey: 'postal',
            password: 'secret12'
        }));
        const viewData = res.render.mock.calls[0][1];
        expect(viewData.success).toEqual({
            refCode: 'REG-TEST-001',
            username: 'registered_01@ahram.com'
        });
        expect(JSON.stringify(viewData)).not.toContain('secret12');
    });

    test('preserves non-sensitive fields when validation fails', async () => {
        req.body = {
            companyName: 'منفذ التسجيل التجريبي',
            managerName: 'مدير التسجيل التجريبي',
            phone: '0911234567',
            webUsername: 'registered_01',
            executorServiceKey: 'bank_account',
            webPassword: 'secret12',
            confirmPassword: 'different'
        };

        await controller.postRegister(req, res);

        expect(res.render).toHaveBeenCalledWith('executor/register', expect.objectContaining({
            error: 'كلمات المرور غير متطابقة.',
            formData: {
                companyName: 'منفذ التسجيل التجريبي',
                managerName: 'مدير التسجيل التجريبي',
                phone: '0911234567',
                webUsername: 'registered_01',
                executorServiceKey: 'bank_account'
            },
            executorServiceOptions: expect.any(Array)
        }));
        expect(RegistrationRequest.create).not.toHaveBeenCalled();
    });
});

describe('Executor portal login tenant scope', () => {
    const originalMode = process.env.TENANT_MODE;

    afterEach(() => {
        if (originalMode === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = originalMode;
    });

    test('looks up the executor inside the resolved tenant and includes legacy rows only in single mode', async () => {
        const req = {
            session: {},
            body: { username: 'operator.one', password: 'secret12' },
            tenant: { _id: 'tenant-a' },
            ip: '127.0.0.1',
            headers: { 'user-agent': 'Jest' }
        };
        const res = { render: jest.fn(), redirect: jest.fn() };
        Employee.findOne.mockReturnValue({
            populate: () => ({ lean: async () => null })
        });

        process.env.TENANT_MODE = 'multi';
        await controller.postLogin(req, res);
        expect(Employee.findOne).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-a'
        }));

        process.env.TENANT_MODE = 'single';
        await controller.postLogin(req, res);
        expect(Employee.findOne).toHaveBeenLastCalledWith(expect.objectContaining({
            tenantId: { $in: ['tenant-a', null] }
        }));
        expect(res.render).toHaveBeenCalledWith('executor/login', expect.objectContaining({
            error: 'اسم المستخدم أو كلمة المرور غير صحيحة.'
        }));
    });
});
