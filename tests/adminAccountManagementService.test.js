'use strict';

jest.mock('../models/User', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findById: jest.fn(), findOne: jest.fn(), exists: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Employee', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Admin', () => ({ findOne: jest.fn() }));
jest.mock('../models/Settings', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Transaction', () => ({ countDocuments: jest.fn() }));
jest.mock('../services/accountCodeService', () => ({
    CODE_LENGTHS: { user: 6, agent: 4, company: 5, subAccount: 6 },
    expectedUserCodeLength: jest.fn((account) => account.role === 'agent' ? 4 : 6),
    validateAccountCode: jest.fn((value) => value),
    ensureAccountCodeAvailable: jest.fn(),
    reserveAccountCode: jest.fn(),
    releaseAccountCodeReservation: jest.fn()
}));

const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Admin = require('../models/Admin');
const Settings = require('../models/Settings');
const Transaction = require('../models/Transaction');
const {
    updateEditableAccount,
    findEditableAccount,
    safeSnapshot
} = require('../services/adminAccountManagementService');

const IDS = Object.freeze({
    account: '507f1f77bcf86cd799439011',
    owner: '507f1f77bcf86cd799439012'
});

const queryResult = (value) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
    sort: jest.fn().mockReturnThis()
});

const makeAccount = (overrides = {}) => {
    const account = {
        _id: IDS.account,
        name: 'حساب تجريبي',
        phone: '0911111111',
        webUsername: 'account_user',
        webPassword: '$2b$12$existing-hash',
        role: 'user',
        status: 'active',
        tier: 2,
        balance: 250,
        creditLimit: 0,
        accountCode: '123456',
        businessProfile: {},
        set(path, value) {
            const [, field] = path.split('.');
            if (path.startsWith('businessProfile.')) this.businessProfile[field] = value;
            else this[path] = value;
        },
        save: jest.fn(),
        ...overrides
    };
    account.save.mockImplementation(async () => account);
    return account;
};

const userPayload = (overrides = {}) => ({
    name: 'الاسم بعد التعديل',
    phone: '0911111111',
    webUsername: 'account_user',
    newPassword: '',
    status: 'active',
    tier: '3',
    creditLimit: '750',
    accountCode: '123456',
    contactName: 'مسؤول الحساب',
    email: 'owner@example.com',
    city: 'طرابلس',
    address: 'وسط المدينة',
    registrationNumber: 'REG-10',
    ...overrides
});

const resetIdentityQueries = () => {
    [User, ClientCompany, SubAccount, ClientEmployee, AgentEmployee, Employee, Admin]
        .forEach((Model) => Model.findOne?.mockReturnValue(queryResult(null)));
};

describe('admin account management service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetIdentityQueries();
        SubAccount.exists.mockResolvedValue(false);
        Settings.updateMany.mockResolvedValue({ modifiedCount: 0 });
        Transaction.countDocuments.mockResolvedValue(0);
    });

    test('rejects using the agent editor for a normal client', async () => {
        User.findById.mockResolvedValue(makeAccount({ role: 'user' }));

        await expect(findEditableAccount('agent', IDS.account))
            .rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    });

    test('updates a client profile without changing its password or balance', async () => {
        const account = makeAccount();
        User.findById.mockResolvedValue(account);

        const result = await updateEditableAccount({
            type: 'user',
            id: IDS.account,
            payload: userPayload()
        });

        expect(account.save).toHaveBeenCalledTimes(1);
        expect(account.name).toBe('الاسم بعد التعديل');
        expect(account.tier).toBe(3);
        expect(account.creditLimit).toBe(750);
        expect(account.balance).toBe(250);
        expect(account.webPassword).toBe('$2b$12$existing-hash');
        expect(result.passwordChanged).toBe(false);
        expect(result.changedFields).toEqual(expect.arrayContaining(['name', 'tier', 'creditLimit', 'businessProfile']));
    });

    test('accepts a new password but never includes it in audit snapshots', async () => {
        const account = makeAccount();
        User.findById.mockResolvedValue(account);

        const result = await updateEditableAccount({
            type: 'user',
            id: IDS.account,
            payload: userPayload({ newPassword: 'Secure-7788' })
        });

        expect(account.webPassword).toBe('Secure-7788');
        expect(result.passwordChanged).toBe(true);
        expect(result.oldData).not.toHaveProperty('webPassword');
        expect(result.newData).not.toHaveProperty('webPassword');
        expect(safeSnapshot('user', account)).not.toHaveProperty('webPassword');
    });

    test('rejects a username already used by a different account type', async () => {
        const account = makeAccount();
        User.findById.mockResolvedValue(account);
        SubAccount.findOne.mockReturnValue(queryResult({ _id: IDS.owner }));

        await expect(updateEditableAccount({
            type: 'user',
            id: IDS.account,
            payload: userPayload({ webUsername: 'duplicate_user' })
        })).rejects.toMatchObject({ code: 'USERNAME_TAKEN', field: 'webUsername' });

        expect(account.save).not.toHaveBeenCalled();
    });

    test('updates a company employee association, role, and permissions', async () => {
        const account = makeAccount({
            companyId: IDS.owner,
            role: 'employee',
            canViewAllReports: false,
            canManageCompany: false,
            canCreateCompanyStaff: false,
            accountCode: undefined,
            businessProfile: undefined
        });
        ClientEmployee.findById.mockResolvedValue(account);
        ClientCompany.findOne.mockReturnValue(queryResult({ _id: IDS.owner }));

        const result = await updateEditableAccount({
            type: 'client-employee',
            id: IDS.account,
            payload: {
                name: 'موظف الحسابات',
                phone: '0911111111',
                webUsername: 'account_user',
                newPassword: '',
                status: 'active',
                role: 'accountant',
                companyId: IDS.owner,
                canViewAllReports: 'true',
                canManageCompany: 'on'
            }
        });

        expect(account.role).toBe('accountant');
        expect(account.canViewAllReports).toBe(true);
        expect(account.canManageCompany).toBe(true);
        expect(account.canCreateCompanyStaff).toBe(false);
        expect(String(account.companyId)).toBe(IDS.owner);
        expect(result.changedFields).toEqual(expect.arrayContaining(['role', 'canViewAllReports', 'canManageCompany']));
    });

    test('blocks changing an executor service while operations are in flight', async () => {
        const executor = makeAccount({
            phone: undefined,
            webUsername: undefined,
            webPassword: undefined,
            role: undefined,
            serviceKey: 'vodafone',
            isManagerBot: false,
            isApiBot: false,
            accountCode: undefined,
            businessProfile: undefined
        });
        ExecutorGroup.findById.mockResolvedValue(executor);
        Transaction.countDocuments.mockResolvedValue(2);

        await expect(updateEditableAccount({
            type: 'executor',
            id: IDS.account,
            payload: { name: executor.name, status: 'active', serviceKey: 'postal', parentGroupId: '' }
        })).rejects.toMatchObject({ code: 'ACTIVE_TASKS', field: 'serviceKey' });

        expect(executor.save).not.toHaveBeenCalled();
    });

    test('clears stale automatic routing when an executor service changes', async () => {
        const executor = makeAccount({
            phone: undefined,
            webUsername: undefined,
            webPassword: undefined,
            role: undefined,
            serviceKey: 'vodafone',
            isManagerBot: false,
            isApiBot: false,
            accountCode: undefined,
            businessProfile: undefined
        });
        ExecutorGroup.findById.mockResolvedValue(executor);

        const result = await updateEditableAccount({
            type: 'executor',
            id: IDS.account,
            payload: { name: executor.name, status: 'active', serviceKey: 'postal', parentGroupId: '' }
        });

        expect(result.serviceChanged).toBe(true);
        expect(executor.serviceKey).toBe('postal');
        expect(Settings.updateMany).toHaveBeenNthCalledWith(1, {}, {
            $pull: { autoRouteRules: { executorGroupId: IDS.account } }
        });
        expect(Settings.updateMany).toHaveBeenNthCalledWith(2, {
            autoRouteBotId: IDS.account
        }, {
            $set: { autoRouteBotId: null }
        });
    });
});
