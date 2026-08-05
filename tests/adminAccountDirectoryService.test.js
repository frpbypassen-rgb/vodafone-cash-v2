'use strict';

const {
    DEFAULT_PAGE_SIZE,
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
