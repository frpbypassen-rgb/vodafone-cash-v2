'use strict';

jest.mock('../models/Employee', () => ({
    findById: jest.fn(),
    updateOne: jest.fn(),
    find: jest.fn()
}));
jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));
jest.mock('../models/Transaction', () => ({ find: jest.fn() }));
jest.mock('../services/executorDeviceSessionService', () => ({
    enforceExecutorDeviceLimit: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../services/executorAuthCache', () => ({
    invalidateExecutorAuth: jest.fn(),
    clearExecutorAuthCache: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const { syncBotBalance } = require('../utils/helpers');
const {
    executorSupportsTransferType,
    getExecutorEnabledServiceKeys,
    getExecutorSupportedTransferTypes,
    normalizeEnabledServiceKeys
} = require('../utils/executorServiceCatalog');
const { snapshotServiceLedgers, completedTransferLedgerInc } = require('../utils/executorServiceLedger');
const {
    updateEmployeeExecutionPolicy,
    updateEmployeeExecutionPolicyAsAdmin
} = require('../services/mobileWebParityService');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('admin-only per-executor policy and per-service balances', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('manager updateEmployeeExecutionPolicy is rejected as ADMIN_ONLY', async () => {
        await expect(updateEmployeeExecutionPolicy({
            executorId: 'manager-1',
            targetId: 'operator-1',
            body: { proofRequired: true }
        })).rejects.toMatchObject({ message: 'ADMIN_ONLY', status: 403 });
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test('portal POST and PUT handlers refuse manager mutation of per-executor overrides', async () => {
        const portalRoutes = read('routes/executorPortal.js');
        const controllerSource = read('controllers/executorDashboardController.js');
        expect(portalRoutes).toContain("router.put('/api/employees/:id/execution-policy'");
        expect(controllerSource).toContain("code: 'ADMIN_ONLY'");
        expect(controllerSource).toContain('تعديل صلاحيات المنفذ متاح للإدارة المركزية فقط');
        expect(controllerSource).not.toContain('updateEmployeeExecutionPolicy({');
    });

    test('admin can create and clear a per-executor override', async () => {
        const employee = {
            _id: 'operator-1',
            role: 'operator',
            groupId: 'group-1',
            executionPolicyOverride: {},
            set: jest.fn(function set(key, value) { this[key] = value; })
        };
        employee.save = jest.fn().mockResolvedValue(employee);
        const leanEmployee = () => Promise.resolve(employee);
        Employee.findById.mockImplementation(() => ({
            lean: leanEmployee,
            then: (resolve, reject) => leanEmployee().then(resolve, reject)
        }));
        Employee.updateOne.mockResolvedValue({ acknowledged: true });
        ExecutorGroup.findById.mockResolvedValue({
            _id: 'group-1',
            manualProofRequired: false,
            manualAllowedPhoneLengths: [3, 4, 11],
            maxConcurrentDevices: 1,
            sessionTtlEnabled: false
        });

        const saved = await updateEmployeeExecutionPolicyAsAdmin({
            groupId: 'group-1',
            targetId: 'operator-1',
            body: {
                inheritCompanyPolicy: false,
                inheritProofRequired: false,
                inheritPhoneLengths: false,
                inheritMaxConcurrentDevices: false,
                inheritSessionTtl: false,
                phoneLengthMode: '11',
                proofRequired: true,
                maxConcurrentDevices: 3,
                sessionTtlEnabled: true,
                sessionTtlHours: 4
            }
        });
        expect(employee.set).toHaveBeenCalledWith('executionPolicyOverride', expect.objectContaining({
            proofRequired: true,
            allowedPhoneLengths: [11],
            maxConcurrentDevices: 3,
            sessionTtlEnabled: true
        }));
        expect(saved.executionPolicy.proofRequired).toBe(true);

        Employee.findById.mockImplementation(() => ({
            lean: leanEmployee,
            then: (resolve, reject) => leanEmployee().then(resolve, reject)
        }));
        await updateEmployeeExecutionPolicyAsAdmin({
            groupId: 'group-1',
            targetId: 'operator-1',
            body: { inheritCompanyPolicy: true }
        });
        expect(Employee.updateOne).toHaveBeenCalledWith(
            { _id: 'operator-1' },
            { $unset: { executionPolicyOverride: 1 } }
        );
    });

    test('enabling cash + bank on one company accepts both transfer types', () => {
        const company = { serviceKey: 'vodafone', serviceKeys: ['vodafone', 'bank_account'] };
        expect(getExecutorEnabledServiceKeys(company)).toEqual(['vodafone', 'bank_account']);
        expect(getExecutorSupportedTransferTypes(company)).toEqual(['vodafone', 'bank_account']);
        expect(executorSupportsTransferType(company, 'vodafone')).toBe(true);
        expect(executorSupportsTransferType(company, 'bank_account')).toBe(true);
        expect(normalizeEnabledServiceKeys(['bank_account'], 'vodafone')).toEqual(['vodafone', 'bank_account']);
    });

    test('syncBotBalance splits cash and bank private ledgers instead of mixing them', async () => {
        const bot = {
            _id: 'group-1',
            isManagerGroup: false,
            serviceKey: 'vodafone',
            serviceKeys: ['vodafone', 'bank_account'],
            save: jest.fn().mockResolvedValue(true)
        };
        ExecutorGroup.findById.mockResolvedValue(bot);
        Transaction.find.mockResolvedValue([
            { status: 'deposit', amount: 5000, transferType: 'vodafone', canonicalServiceKey: 'vodafone' },
            { status: 'completed', amount: 800, transferType: 'vodafone' },
            { status: 'deposit', amount: 2000, transferType: 'bank_account', canonicalServiceKey: 'bank_account' },
            { status: 'completed', amount: 300, transferType: 'bank_account' }
        ]);

        const balance = await syncBotBalance('group-1');
        expect(balance).toBe(4200);
        expect(bot.balance).toBe(4200);
        expect(bot.serviceBalances).toEqual({
            vodafone: 4200,
            bank_account: 1700
        });
    });

    test('manager/admin snapshots show cash total and bank balance separately', () => {
        const snapshot = snapshotServiceLedgers({
            group: {
                _id: 'group-1',
                name: 'شركة الأهرام',
                serviceKey: 'vodafone',
                serviceKeys: ['vodafone', 'bank_account'],
                balance: 4200,
                serviceBalances: { vodafone: 4200, bank_account: 1700 }
            },
            allocatedBalance: 800
        });
        expect(snapshot.multiService).toBe(true);
        expect(snapshot.privateBalance).toBe(4200);
        expect(snapshot.totalBalance).toBe(5000);
        expect(snapshot.totalBalance).not.toBe(4200 + 1700 + 800);
        const cash = snapshot.byService.find((row) => row.serviceKey === 'vodafone');
        const bank = snapshot.byService.find((row) => row.serviceKey === 'bank_account');
        expect(cash).toMatchObject({
            privateLabel: 'الرصيد الخاص للكاش',
            totalLabel: 'إجمالي الكاش',
            privateBalance: 4200,
            allocatedBalance: 800,
            totalBalance: 5000,
            appliesPoolModel: true
        });
        expect(bank).toMatchObject({
            singleLabel: 'رصيد التحويل البنكي',
            privateBalance: 1700,
            allocatedBalance: 0,
            totalBalance: 1700,
            appliesPoolModel: false
        });
    });

    test('executor-portal team UI no longer saves per-employee overrides', () => {
        const employeesView = read('views/executor/employees.ejs');
        const portalRoutes = read('routes/executorPortal.js');
        const detailsView = read('views/executor_details.ejs');
        const adminEdit = read('views/admin_account_edit.ejs');
        expect(employeesView).not.toContain('editExecutionPolicy');
        expect(employeesView).not.toContain('/execution-policy');
        expect(employeesView).toContain('companyBalances?.multiService');
        expect(portalRoutes).toContain("router.put('/api/employees/:id/execution-policy'");
        expect(detailsView).toContain('/employees/<%= member._id %>/execution-policy');
        expect(detailsView).toContain('صلاحيات التنفيذ لكل منفذ');
        expect(adminEdit).toContain('inheritCompanyPolicy');
        expect(adminEdit).toContain('enabledServices');
    });

    test('completing a bank transfer debits the bank ledger, not cash', () => {
        const company = { serviceKey: 'vodafone', serviceKeys: ['vodafone', 'bank_account'] };
        expect(completedTransferLedgerInc(company, { transferType: 'bank_account' }, -300)).toEqual({
            'serviceBalances.bank_account': -300
        });
        expect(completedTransferLedgerInc(company, { transferType: 'vodafone' }, -800)).toEqual({
            balance: -800,
            'serviceBalances.vodafone': -800
        });
    });
});
