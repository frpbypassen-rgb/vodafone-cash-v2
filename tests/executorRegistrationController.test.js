'use strict';

jest.mock('../models/Employee', () => ({ exists: jest.fn() }));
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
            formData: {}
        });
    });

    test('submits a normalized pending request without exposing the password in view data', async () => {
        req.body = {
            companyName: 'منفذ التسجيل التجريبي',
            managerName: 'مدير التسجيل التجريبي',
            phone: '091-123-4567',
            webUsername: 'REGISTERED_01',
            webPassword: 'secret1',
            confirmPassword: 'secret1'
        };

        await controller.postRegister(req, res);

        expect(RegistrationRequest.create).toHaveBeenCalledWith(expect.objectContaining({
            accountType: 'executor',
            phone: '0911234567',
            username: 'registered_01@ahram.com',
            password: 'secret1'
        }));
        const viewData = res.render.mock.calls[0][1];
        expect(viewData.success).toEqual({
            refCode: 'REG-TEST-001',
            username: 'registered_01@ahram.com'
        });
        expect(JSON.stringify(viewData)).not.toContain('secret1');
    });

    test('preserves non-sensitive fields when validation fails', async () => {
        req.body = {
            companyName: 'منفذ التسجيل التجريبي',
            managerName: 'مدير التسجيل التجريبي',
            phone: '0911234567',
            webUsername: 'registered_01',
            webPassword: 'secret1',
            confirmPassword: 'different'
        };

        await controller.postRegister(req, res);

        expect(res.render).toHaveBeenCalledWith('executor/register', expect.objectContaining({
            error: 'كلمات المرور غير متطابقة.',
            formData: {
                companyName: 'منفذ التسجيل التجريبي',
                managerName: 'مدير التسجيل التجريبي',
                phone: '0911234567',
                webUsername: 'registered_01'
            }
        }));
        expect(RegistrationRequest.create).not.toHaveBeenCalled();
    });
});
