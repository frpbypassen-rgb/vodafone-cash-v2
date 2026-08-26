'use strict';

jest.mock('../models/User', () => ({
    findOne: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('../models/ClientEmployee', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Employee', () => ({ findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn() }));

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const SubAccount = require('../models/SubAccount');
const ClientCompany = require('../models/ClientCompany');
const bcrypt = require('bcryptjs');
const { findByCredentials } = require('../repositories/userRepository');

describe('mobile login parity with website login', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLegacyMode = process.env.ALLOW_LEGACY_TENANTLESS_RECORDS;

    beforeEach(() => {
        jest.clearAllMocks();
        Employee.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
        Employee.find.mockReturnValue({ populate: jest.fn().mockResolvedValue([]) });
        ClientEmployee.findOne.mockResolvedValue(null);
        AgentEmployee.findOne.mockResolvedValue(null);
        SubAccount.findOne.mockResolvedValue(null);
        User.findOne.mockResolvedValue({
            _id: 'direct-client-1',
            webUsername: 'client.demo@ahram.com',
            webPassword: '$2b$12$hash',
            name: 'عميل تجريبي',
            status: 'active',
            balance: 120
        });
        bcrypt.compare.mockResolvedValue(true);
        process.env.NODE_ENV = 'test';
        delete process.env.ALLOW_LEGACY_TENANTLESS_RECORDS;
    });

    afterAll(() => {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalLegacyMode === undefined) delete process.env.ALLOW_LEGACY_TENANTLESS_RECORDS;
        else process.env.ALLOW_LEGACY_TENANTLESS_RECORDS = originalLegacyMode;
    });

    test('accepts the short username used by the website for a direct customer', async () => {
        const result = await findByCredentials('CLIENT.DEMO', 'pass1234', 'tenant-current');

        expect(result).toEqual(expect.objectContaining({
            accountType: 'client_user',
            balance: 120
        }));
        const lookup = User.findOne.mock.calls[0][0];
        expect(lookup.tenantId).toEqual({ $in: ['tenant-current', null] });
        const usernameMatchers = lookup.$or
            .filter((item) => item.webUsername)
            .map((item) => item.webUsername);
        expect(usernameMatchers.some((matcher) => matcher.test('client.demo@ahram.com'))).toBe(true);
        expect(usernameMatchers.some((matcher) => matcher.test('CLIENT.DEMO'))).toBe(true);
    });

    test('accepts the short username used by the website for an agent customer', async () => {
        User.findOne.mockResolvedValue(null);
        SubAccount.findOne.mockResolvedValue({
            _id: 'agent-client-1',
            webUsername: 'agent.client@ahram.com',
            webPassword: '$2b$12$hash',
            status: 'active',
            balance: 75
        });

        const result = await findByCredentials('AGENT.CLIENT', 'pass1234');

        expect(result).toEqual(expect.objectContaining({
            accountType: 'sub_client',
            balance: 75
        }));
        const lookup = SubAccount.findOne.mock.calls[0][0];
        const usernameMatchers = lookup.$or
            .filter((item) => item.webUsername)
            .map((item) => item.webUsername);
        expect(usernameMatchers.some((matcher) => matcher.test('agent.client@ahram.com'))).toBe(true);
    });

    test('uses an exact tenant match for production logins', async () => {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_LEGACY_TENANTLESS_RECORDS = 'false';

        const result = await findByCredentials('CLIENT.DEMO', 'pass1234', 'tenant-current');

        expect(result.accountType).toBe('client_user');
        expect(Employee.find.mock.calls[0][0].tenantId).toBe('tenant-current');
        expect(ClientEmployee.findOne.mock.calls[0][0].tenantId).toBe('tenant-current');
        expect(AgentEmployee.findOne.mock.calls[0][0].tenantId).toBe('tenant-current');
        expect(User.findOne.mock.calls[0][0].tenantId).toBe('tenant-current');
    });

    test('scopes both a company employee and its parent company to the tenant', async () => {
        process.env.NODE_ENV = 'production';
        process.env.ALLOW_LEGACY_TENANTLESS_RECORDS = 'false';
        ClientEmployee.findOne.mockResolvedValue({
            _id: 'company-employee-1',
            companyId: 'company-1',
            webPassword: '$2b$12$hash',
            status: 'active'
        });
        ClientCompany.findOne.mockResolvedValue({
            _id: 'company-1',
            tenantId: 'tenant-current',
            balance: 600
        });

        const result = await findByCredentials('COMPANY.USER', 'pass1234', 'tenant-current');

        expect(result).toEqual(expect.objectContaining({
            accountType: 'client_company',
            balance: 600
        }));
        expect(ClientEmployee.findOne.mock.calls[0][0].tenantId).toBe('tenant-current');
        expect(ClientCompany.findOne).toHaveBeenCalledWith({
            _id: 'company-1',
            tenantId: 'tenant-current'
        });
    });
});
