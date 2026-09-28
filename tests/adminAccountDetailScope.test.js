'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const { adminAccountScope, tenantScope } = require('../utils/tenantScope');
const {
    adminAccountFindQuery,
    buildAdminAccountHistoryQuery
} = require('../services/adminAccountVisibilityService');
const { loadAdminAccountDirectory } = require('../services/adminAccountDirectoryService');

const CURRENT_TENANT = { _bsontype: 'ObjectId', toHexString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' };
const HISTORICAL_TENANT = { _bsontype: 'ObjectId', toHexString: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' };
const COMPANY_ID = 'cccccccccccccccccccccccc';
const AGENT_ID = 'dddddddddddddddddddddddd';

const mongoMatches = (doc, query) => {
    if (query._id && String(query._id) !== String(doc._id)) return false;
    if (query.role && query.role !== doc.role) return false;
    if (query.status && query.status.$ne && doc.status === query.status.$ne) return false;
    if (query.tenantId && query.tenantId.$in) {
        return query.tenantId.$in.some((value) => (
            value === doc.tenantId || (value === null && (doc.tenantId === null || doc.tenantId === undefined))
        ));
    }
    if (Object.prototype.hasOwnProperty.call(query, 'tenantId')) {
        return query.tenantId === doc.tenantId;
    }
    return true;
};

const queryResult = (records) => ({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(records)
});

describe('admin company and agency account detail scope', () => {
    const req = { tenantId: CURRENT_TENANT };

    test('company detail opens under single-tenant adminAccountScope even with a historical tenantId', () => {
        const company = {
            _id: COMPANY_ID,
            name: 'شركة النور',
            tenantId: HISTORICAL_TENANT,
            status: 'active'
        };
        const brokenLookup = {
            _id: COMPANY_ID,
            ...tenantScope(req),
            status: { $ne: 'deleted' }
        };
        const openLookup = adminAccountFindQuery(req, { _id: COMPANY_ID });

        expect(adminAccountScope(req)).toEqual({});
        expect(openLookup).toEqual({ _id: COMPANY_ID, status: { $ne: 'deleted' } });
        expect(openLookup.tenantId).toBeUndefined();
        expect(mongoMatches(company, brokenLookup)).toBe(false);
        expect(mongoMatches(company, openLookup)).toBe(true);
    });

    test('agency master accounts stay visible and openable while SubAccounts stay hidden', async () => {
        const agent = {
            _id: AGENT_ID,
            name: 'وكالة السراي',
            role: 'agent',
            phone: '0911111111',
            webUsername: 'sarai.agency',
            tenantId: HISTORICAL_TENANT,
            status: 'active'
        };
        const agencyClient = {
            _id: 'sub-1',
            masterType: 'user',
            masterId: AGENT_ID,
            name: 'محل السراي',
            phone: '0922222222',
            status: 'active'
        };

        expect(mongoMatches(agent, adminAccountFindQuery(req, { _id: AGENT_ID }))).toBe(true);
        expect(mongoMatches(agent, {
            _id: AGENT_ID,
            ...tenantScope(req),
            status: { $ne: 'deleted' }
        })).toBe(false);

        const agentHistory = buildAdminAccountHistoryQuery({
            kind: 'agent',
            account: agent,
            tenant: adminAccountScope(req)
        });
        expect(agentHistory.isSubAccountTx).toEqual({ $ne: true });
        expect(agentHistory.userId).toEqual({ $in: [agent.phone, agent.webUsername] });
        expect(agentHistory.companyId).toBeNull();
        expect(JSON.stringify(agentHistory)).not.toContain(String(agencyClient._id));
        expect(JSON.stringify(agentHistory)).not.toContain(agencyClient.name);

        const hiddenLedger = buildAdminAccountHistoryQuery({
            kind: 'subaccount',
            account: agencyClient,
            tenant: adminAccountScope(req)
        });
        expect(hiddenLedger).toEqual({ isSubAccountTx: { $ne: true }, _id: null });

        const User = {
            countDocuments: jest.fn((filter) => Promise.resolve(filter.role === 'agent' ? 1 : 0)),
            find: jest.fn(() => queryResult([agent]))
        };
        const ClientCompany = {
            countDocuments: jest.fn(() => Promise.resolve(0)),
            find: jest.fn(() => queryResult([]))
        };
        const SubAccount = {
            countDocuments: jest.fn(() => Promise.resolve(1)),
            find: jest.fn(() => queryResult([agencyClient]))
        };

        const directory = await loadAdminAccountDirectory({ User, ClientCompany, SubAccount }, { section: 'agents' });
        expect(directory.agents).toEqual([agent]);
        expect(directory.subAccounts).toEqual([]);
        expect(JSON.stringify(directory)).not.toContain(agencyClient.name);
        expect(SubAccount.find).not.toHaveBeenCalled();
        expect(SubAccount.countDocuments).not.toHaveBeenCalled();
    });

    test('detail routes look up company and agent masters with adminAccountScope and never add a SubAccount page', () => {
        const clientsSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'clients.js'), 'utf8');
        const aliasesSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'adminAliases.js'), 'utf8');
        const clientsView = fs.readFileSync(path.join(__dirname, '..', 'views', 'clients.ejs'), 'utf8');

        expect(clientsSource).toMatch(/User\.findOne\(adminAccountFindQuery\(req, \{ _id: req\.params\.id \}\)\)/);
        expect(clientsSource).toMatch(/ClientCompany\.findOne\(adminAccountFindQuery\(req, \{ _id: req\.params\.id \}\)\)/);
        expect(clientsSource).toMatch(/tenant: adminAccountScope\(req\)/);
        expect(clientsSource).not.toMatch(/User\.findOne\(\{ _id: req\.params\.id, \.\.\.tenantScope\(req\)/);
        expect(clientsSource).not.toMatch(/ClientCompany\.findOne\(\{ _id: req\.params\.id, \.\.\.tenantScope\(req\)/);
        expect(clientsSource).not.toContain("router.get('/sub-account/:id'");
        expect(clientsView).not.toContain('/sub-account/');
        expect(aliasesSource).toContain("router.get('/admin/company/:id'");
        expect(aliasesSource).toContain("router.get('/admin/user/:id'");
        expect(aliasesSource).toContain("'/admin/clients': '/clients'");
        expect(aliasesSource).toContain("'/admin/agents': '/clients?section=agents'");
    });
});
