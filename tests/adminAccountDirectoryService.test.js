'use strict';

const fs = require('fs');
const path = require('path');

const {
    DEFAULT_PAGE_SIZE,
    DIRECTORY_SECTIONS,
    normalizeSection,
    normalizeSearch,
    normalizePage,
    buildSectionFilter,
    loadAdminAccountDirectory
} = require('../services/adminAccountDirectoryService');

const queryResult = (records) => ({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(records)
});

const createModels = ({ users = [], companies = [], subAccounts = [] } = {}) => {
    const User = {
        countDocuments: jest.fn((filter) => Promise.resolve(filter.role === 'agent' ? 1 : 2)),
        find: jest.fn(() => queryResult(users))
    };
    const ClientCompany = {
        countDocuments: jest.fn(() => Promise.resolve(1)),
        find: jest.fn(() => queryResult(companies))
    };
    const SubAccount = {
        countDocuments: jest.fn(() => Promise.resolve(3)),
        find: jest.fn(() => queryResult(subAccounts))
    };

    return { User, ClientCompany, SubAccount };
};

describe('Admin account directory service', () => {
    test('classifies accounts by their explicit type instead of sub-account ownership', () => {
        expect(DIRECTORY_SECTIONS).toEqual(['users', 'companies', 'agents']);
        expect(buildSectionFilter('users')).toEqual({
            status: { $ne: 'deleted' },
            role: { $ne: 'agent' }
        });
        expect(buildSectionFilter('agents')).toEqual({
            status: { $ne: 'deleted' },
            role: 'agent'
        });
        expect(buildSectionFilter('companies')).toEqual({
            status: { $ne: 'deleted' }
        });
        expect(normalizeSection('subaccounts')).toBe('users');
    });

    test('loads a new agent in the agents collection even when it has no sub-accounts', async () => {
        const agent = {
            _id: 'agent-1',
            name: 'وكيل تجريبي',
            role: 'agent',
            balance: 0
        };
        const models = createModels({ users: [agent] });

        const directory = await loadAdminAccountDirectory(models, { section: 'agents' });

        expect(directory.agents).toEqual([agent]);
        expect(directory.users).toEqual([]);
        expect(models.User.find).toHaveBeenCalledWith(expect.objectContaining({ role: 'agent' }));
        expect(models.SubAccount.find).not.toHaveBeenCalled();
    });

    test('keeps companies in the companies section regardless of their sub-accounts', async () => {
        const company = { _id: 'company-1', name: 'شركة تجريبية', balance: 100 };
        const models = createModels({ companies: [company] });

        const directory = await loadAdminAccountDirectory(models, { section: 'companies' });

        expect(directory.companies).toEqual([company]);
        expect(directory.agents).toEqual([]);
        expect(models.ClientCompany.find).toHaveBeenCalledWith({ status: { $ne: 'deleted' } });
        expect(models.User.find).not.toHaveBeenCalled();
    });

    test('does not list agency clients in دليل الحسابات', async () => {
        const agent = {
            _id: 'agent-1',
            name: 'وكالة النور',
            role: 'agent',
            agentCode: '2044'
        };
        const agencyClient = {
            _id: 'sub-1',
            masterType: 'user',
            masterId: 'agent-1',
            name: 'محل السراي',
            phone: '0910000001',
            webUsername: 'sarai.shop',
            balance: 75,
            creditLimit: 200,
            status: 'active'
        };
        const models = createModels({ users: [agent], subAccounts: [agencyClient] });

        const hidden = await loadAdminAccountDirectory(models, { section: 'subaccounts' });

        expect(hidden.activeSection).toBe('users');
        expect(hidden.subAccounts).toEqual([]);
        expect(hidden.directoryCounts.subaccounts).toBe(0);
        expect(JSON.stringify(hidden)).not.toContain('محل السراي');
        expect(models.SubAccount.find).not.toHaveBeenCalled();
        expect(models.SubAccount.countDocuments).not.toHaveBeenCalled();
    });

    test('admin directory page has no agency-client section or rows', () => {
        const html = fs.readFileSync(path.join(__dirname, '../views/clients.ejs'), 'utf8');
        expect(html).not.toContain('عملاء الوكلاء');
        expect(html).not.toContain('section=subaccounts');
        expect(html).not.toContain('subaccounts-tab');
        expect(html).not.toContain('/sub-account/');
        expect(fs.existsSync(path.join(__dirname, '../views/subaccount_details.ejs'))).toBe(false);
    });

    test('normalizes navigation input and escapes search expressions', () => {
        expect(normalizeSection('unknown')).toBe('users');
        expect(normalizePage('-2')).toBe(1);
        expect(normalizePage('3')).toBe(3);
        expect(normalizeSearch(`  ${'x'.repeat(140)}  `)).toHaveLength(120);

        const filter = buildSectionFilter('agents', '011.*');
        expect(filter.$or).toHaveLength(5);
        expect(filter.$or[0].name.test('011.*')).toBe(true);
        expect(filter.$or[0].name.test('011999')).toBe(false);
        expect(DEFAULT_PAGE_SIZE).toBe(24);
    });
});
