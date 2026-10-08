'use strict';

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../services/reportPdfService', () => {
    const actual = jest.requireActual('../services/reportPdfService');
    return {
        ...actual,
        generateAdminReportPdf: jest.fn(async (app, data) => {
            const html = await actual.renderView(app, 'reports_pdf', {
                ...data,
                report: actual.preparePdfReport(data.report),
                logoDataUri: ''
            });
            return Buffer.from(html, 'utf8');
        })
    };
});

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const Settlement = require('../models/Settlement');
const { loadReports, resolveAgentPermissions } = require('../services/businessPortalService');
const { exportReportCsv } = require('../controllers/clientWorkspaceController');

jest.setTimeout(180000);

const SHARED_NAME = 'أحمد المشترك';
const PREHASHED_PASSWORD = '$2b$12$hashed';
const DAY = '2026-12-01';
const AT = new Date('2026-12-01T10:00:00.000Z');
const VICTIM_NUMBER = '01055550199';
const INTRUDER_NUMBER = '01011110111';
const INTRUDER_DEPOSIT = 'DEP-INTRUDER-250';
const RENAMED_PHONE_NUMBER = '01016000001';
const RENAMED_ACTOR_NUMBER = '01016000002';
const ORPHAN_NUMBER = '01042420000';
const SUB_OWN_NUMBER = '01088880111';
const SUB_OTHER_NUMBER = '01088880222';
const MASTER_NUMBER = '01088880000';
const COMPANY_OWN_NUMBER = '01030000001';
const COMPANY_OTHER_NUMBER = '01030000002';
const COMPANY_NAME_ONLY_NUMBER = '01030000099';
const STAFF_OWN_NUMBER = '01041000001';
const STAFF_NAME_ONLY_NUMBER = '01041000099';
const STAFF_OTHER_NUMBER = '01041000002';

const bodyText = (response) => (
    Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.text || '')
);

const beneficiaryNumbers = (report) => {
    const rows = []
        .concat(report?.currentTransactions || [])
        .concat(report?.operations || [])
        .concat(report?.deposits || []);
    return rows.map((row) => String(row.vodafoneNumber || row.accountNumber || ''));
};

describe('client report ownership', () => {
    let memory;
    let app;
    let session;
    let intruder;
    let renamed;
    let emptyTwin;
    let subOwn;
    let subEmpty;
    let companyEmployee;
    let agentStaff;
    let agent;
    let openingBalances;

    const asClient = (account, accountType) => {
        session = {
            isClientLoggedIn: true,
            clientId: String(account._id),
            accountType
        };
    };

    const filterReport = (dateValue = DAY) => request(app)
        .post('/client/reports/filter')
        .send({ dateType: 'day', dateValue });

    const reportPdf = (dateValue = DAY) => request(app)
        .get('/client/reports/admin-copy.pdf')
        .query({ dateType: 'day', dateValue });

    const balanceSnapshot = async () => {
        const [users, companies, subs, ledgerCount, transactionCount, settlementCount] = await Promise.all([
            User.find().select('balance').lean(),
            ClientCompany.find().select('balance').lean(),
            SubAccount.find().select('balance').lean(),
            Ledger.countDocuments(),
            Transaction.countDocuments(),
            Settlement.countDocuments()
        ]);
        return {
            users: users.map((row) => [String(row._id), row.balance]),
            companies: companies.map((row) => [String(row._id), row.balance]),
            subs: subs.map((row) => [String(row._id), row.balance]),
            ledgerCount,
            transactionCount,
            settlementCount
        };
    };

    beforeAll(async () => {
        mongoose.set('strictQuery', false);
        memory = await MongoMemoryServer.create();
        await mongoose.connect(memory.getUri());

        app = express();
        app.set('view engine', 'ejs');
        app.set('views', path.join(__dirname, '../views'));
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = session;
            next();
        });
        app.use('/client', require('../routes/clientReports'));

        const victim = await User.create({
            name: SHARED_NAME,
            phone: '0912000001',
            webUsername: 'client-victim',
            webPassword: PREHASHED_PASSWORD,
            balance: 500,
            role: 'user',
            status: 'active'
        });
        intruder = await User.create({
            name: SHARED_NAME,
            phone: '0912000002',
            webUsername: 'client-intruder',
            webPassword: PREHASHED_PASSWORD,
            balance: 80,
            role: 'user',
            status: 'active'
        });
        renamed = await User.create({
            name: 'سالم القديم',
            phone: '0912000003',
            webUsername: 'client-renamed',
            webPassword: PREHASHED_PASSWORD,
            balance: 40,
            role: 'user',
            status: 'active'
        });
        emptyTwin = await User.create({
            name: SHARED_NAME,
            phone: '0912000004',
            webUsername: 'client-empty',
            webPassword: PREHASHED_PASSWORD,
            balance: 0,
            role: 'user',
            status: 'active'
        });
        agent = await User.create({
            name: 'وكالة الهرم',
            phone: '0912000099',
            webUsername: 'agent-owner',
            webPassword: PREHASHED_PASSWORD,
            balance: 900,
            role: 'agent',
            status: 'active'
        });
        subOwn = await SubAccount.create({
            masterType: 'user',
            masterId: agent._id,
            name: 'نقطة البيع',
            phone: '0922000001',
            webUsername: 'sub-own',
            webPassword: PREHASHED_PASSWORD,
            balance: 30,
            status: 'active'
        });
        const subOther = await SubAccount.create({
            masterType: 'user',
            masterId: agent._id,
            name: 'نقطة البيع',
            phone: '0922000002',
            webUsername: 'sub-other',
            webPassword: PREHASHED_PASSWORD,
            balance: 70,
            status: 'active'
        });
        subEmpty = await SubAccount.create({
            masterType: 'user',
            masterId: agent._id,
            name: 'نقطة البيع',
            phone: '0922000003',
            webUsername: 'sub-empty',
            webPassword: PREHASHED_PASSWORD,
            balance: 0,
            status: 'active'
        });
        const company = await ClientCompany.create({
            name: 'شركة التجربة',
            phone: '0932000000',
            balance: 1000,
            status: 'active'
        });
        companyEmployee = await ClientEmployee.create({
            companyId: company._id,
            name: 'موظف مشترك',
            phone: '0932000001',
            webUsername: 'emp-own',
            webPassword: PREHASHED_PASSWORD,
            role: 'employee',
            canViewAllReports: false,
            status: 'active'
        });
        const companyPeer = await ClientEmployee.create({
            companyId: company._id,
            name: 'موظف مشترك',
            phone: '0932000002',
            webUsername: 'emp-peer',
            webPassword: PREHASHED_PASSWORD,
            role: 'employee',
            canViewAllReports: false,
            status: 'active'
        });
        agentStaff = await AgentEmployee.create({
            agentId: agent._id,
            name: 'موظف الوكيل',
            phone: '0942000001',
            webUsername: 'staff-own',
            webPassword: PREHASHED_PASSWORD,
            role: 'employee',
            canViewAllReports: false,
            status: 'active'
        });
        const agentPeer = await AgentEmployee.create({
            agentId: agent._id,
            name: 'موظف الوكيل',
            phone: '0942000002',
            webUsername: 'staff-peer',
            webPassword: PREHASHED_PASSWORD,
            role: 'employee',
            canViewAllReports: false,
            status: 'active'
        });

        await Transaction.create([
            {
                customId: 'TX-VICTIM',
                userId: victim.phone,
                companyId: null,
                companyName: 'عميل فردي',
                employeeName: SHARED_NAME,
                amount: 8800,
                costLYD: 1400,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: VICTIM_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-INTRUDER',
                userId: intruder.phone,
                companyId: null,
                companyName: 'عميل فردي (ويب)',
                employeeName: SHARED_NAME,
                clientActorId: String(intruder._id),
                clientActorModel: 'User',
                amount: 1500,
                costLYD: 240,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: INTRUDER_NUMBER,
                createdAt: AT
            },
            {
                customId: INTRUDER_DEPOSIT,
                userId: intruder.phone,
                companyId: null,
                companyName: 'عميل فردي',
                employeeName: 'الإدارة (إيداع)',
                amount: 250,
                costLYD: 0,
                status: 'deposit',
                transferType: 'balance_transfer',
                vodafoneNumber: '01000000000',
                createdAt: AT
            },
            {
                customId: 'TX-RENAMED-PHONE',
                userId: renamed.phone,
                companyId: null,
                companyName: 'عميل فردي (ويب)',
                employeeName: 'سالم القديم',
                clientActorId: String(renamed._id),
                clientActorModel: 'User',
                amount: 1600,
                costLYD: 250,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: RENAMED_PHONE_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-RENAMED-ACTOR',
                userId: 'stale-phone-not-current',
                companyId: null,
                companyName: 'عميل فردي (ويب)',
                employeeName: 'سالم القديم',
                clientActorId: String(renamed._id),
                clientActorModel: 'User',
                amount: 1602,
                costLYD: 251,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: RENAMED_ACTOR_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-ORPHAN-NAME',
                companyId: null,
                companyName: 'عميل فردي',
                employeeName: SHARED_NAME,
                amount: 4242,
                costLYD: 10,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: ORPHAN_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-SUB-OWN',
                userId: agent.phone,
                subAccountId: subOwn._id,
                isSubAccountTx: true,
                companyName: agent.name,
                employeeName: 'نقطة البيع',
                subAccountName: 'نقطة البيع',
                clientActorId: String(subOwn._id),
                clientActorModel: 'SubAccount',
                amount: 210,
                costLYD: 30,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: SUB_OWN_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-SUB-OTHER',
                userId: agent.phone,
                subAccountId: subOther._id,
                isSubAccountTx: true,
                companyName: agent.name,
                employeeName: 'نقطة البيع',
                subAccountName: 'نقطة البيع',
                amount: 990,
                costLYD: 150,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: SUB_OTHER_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-MASTER',
                userId: agent.phone,
                companyId: null,
                companyName: 'وكيل فردي',
                employeeName: agent.name,
                amount: 50,
                costLYD: 8,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: MASTER_NUMBER,
                createdAt: AT
            },
            {
                customId: 'TX-CO-OWN',
                companyId: company._id,
                userId: companyEmployee.phone,
                companyName: company.name,
                employeeName: 'موظف مشترك',
                clientActorId: String(companyEmployee._id),
                clientActorModel: 'ClientEmployee',
                amount: 3100,
                costLYD: 20,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: COMPANY_OWN_NUMBER,
                createdAt: new Date()
            },
            {
                customId: 'TX-CO-OTHER',
                companyId: company._id,
                userId: companyPeer.phone,
                companyName: company.name,
                employeeName: 'موظف مشترك',
                clientActorId: String(companyPeer._id),
                clientActorModel: 'ClientEmployee',
                amount: 3200,
                costLYD: 21,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: COMPANY_OTHER_NUMBER,
                createdAt: new Date()
            },
            {
                customId: 'TX-CO-NAME-ONLY',
                companyId: company._id,
                userId: companyPeer.phone,
                companyName: company.name,
                employeeName: 'موظف مشترك',
                amount: 3999,
                costLYD: 22,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: COMPANY_NAME_ONLY_NUMBER,
                createdAt: new Date()
            },
            {
                customId: 'TX-STAFF-OWN',
                userId: agent.phone,
                companyId: null,
                companyName: agent.name,
                employeeName: 'موظف الوكيل',
                clientActorId: String(agentStaff._id),
                clientActorModel: 'AgentEmployee',
                amount: 2100,
                costLYD: 12,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: STAFF_OWN_NUMBER,
                createdAt: new Date()
            },
            {
                customId: 'TX-STAFF-NAME-ONLY',
                userId: agent.phone,
                companyId: null,
                companyName: agent.name,
                employeeName: 'موظف الوكيل',
                amount: 6700,
                costLYD: 13,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: STAFF_NAME_ONLY_NUMBER,
                createdAt: new Date()
            },
            {
                customId: 'TX-STAFF-OTHER',
                userId: agent.phone,
                companyId: null,
                companyName: agent.name,
                employeeName: 'موظف الوكيل',
                clientActorId: String(agentPeer._id),
                clientActorModel: 'AgentEmployee',
                amount: 6800,
                costLYD: 14,
                status: 'completed',
                transferType: 'vodafone',
                vodafoneNumber: STAFF_OTHER_NUMBER,
                createdAt: new Date()
            }
        ]);

        renamed.name = SHARED_NAME;
        await renamed.save();
        openingBalances = await balanceSnapshot();
    });

    afterAll(async () => {
        await mongoose.disconnect();
        if (memory) await memory.stop();
    });

    test('a client does not see another client with the same name in the filter or the PDF', async () => {
        asClient(intruder, 'user');

        const filtered = await filterReport();
        expect(filtered.status).toBe(200);
        const numbers = beneficiaryNumbers(filtered.body.data);
        expect(numbers).toContain(INTRUDER_NUMBER);
        expect(numbers).not.toContain(VICTIM_NUMBER);
        expect(numbers).not.toContain(ORPHAN_NUMBER);
        expect(filtered.body.data.deposits.map((row) => row.customId)).toContain(INTRUDER_DEPOSIT);
        expect(filtered.body.data.currentTransactions.map((row) => row.amount)).not.toContain(8800);
        expect(filtered.body.data.currentTransactions.map((row) => row.amount)).not.toContain(4242);

        const searched = await request(app)
            .post('/client/reports/filter')
            .send({ dateType: 'day', dateValue: DAY, search: VICTIM_NUMBER });
        expect(searched.status).toBe(200);
        expect(beneficiaryNumbers(searched.body.data)).not.toContain(VICTIM_NUMBER);

        const pdf = await reportPdf();
        expect(pdf.status).toBe(200);
        const pdfText = bodyText(pdf);
        expect(pdfText).toContain(INTRUDER_NUMBER);
        expect(pdfText).toContain(INTRUDER_DEPOSIT);
        expect(pdfText).not.toContain(VICTIM_NUMBER);
        expect(pdfText).not.toContain(ORPHAN_NUMBER);
        expect(pdfText).not.toContain('8,800');
        expect(pdfText).not.toContain('4,242');
    });

    test('a client who renamed onto another customer still sees only their own rows', async () => {
        asClient(renamed, 'user');

        const filtered = await filterReport();
        expect(filtered.status).toBe(200);
        const numbers = beneficiaryNumbers(filtered.body.data);
        expect(numbers).toEqual(expect.arrayContaining([RENAMED_PHONE_NUMBER, RENAMED_ACTOR_NUMBER]));
        expect(numbers).not.toContain(VICTIM_NUMBER);
        expect(numbers).not.toContain(ORPHAN_NUMBER);
        expect(filtered.body.data.entityInfo.name).toBe(SHARED_NAME);

        const pdf = await reportPdf();
        expect(pdf.status).toBe(200);
        const pdfText = bodyText(pdf);
        expect(pdfText).toContain(RENAMED_PHONE_NUMBER);
        expect(pdfText).toContain(RENAMED_ACTOR_NUMBER);
        expect(pdfText).not.toContain(VICTIM_NUMBER);
        expect(pdfText).not.toContain(ORPHAN_NUMBER);
    });

    test('a same-name client with no transactions gets an empty report', async () => {
        asClient(emptyTwin, 'user');

        const filtered = await filterReport();
        expect(filtered.status).toBe(200);
        expect(filtered.body.data.currentTransactions).toEqual([]);
        expect(filtered.body.data.operations).toEqual([]);
        expect(filtered.body.data.deposits).toEqual([]);
        expect(beneficiaryNumbers(filtered.body.data)).not.toContain(VICTIM_NUMBER);

        const pdf = await reportPdf();
        expect(pdf.status).toBe(200);
        const pdfText = bodyText(pdf);
        expect(pdfText).toContain('لا توجد تحويلات ناجحة');
        expect(pdfText).not.toContain(VICTIM_NUMBER);
        expect(pdfText).not.toContain(ORPHAN_NUMBER);
    });

    test('a sub-client sees only their child account, including an empty sibling', async () => {
        asClient(subOwn, 'sub_client');

        const filtered = await filterReport();
        expect(filtered.status).toBe(200);
        const numbers = beneficiaryNumbers(filtered.body.data);
        expect(numbers).toContain(SUB_OWN_NUMBER);
        expect(numbers).not.toContain(SUB_OTHER_NUMBER);
        expect(numbers).not.toContain(MASTER_NUMBER);

        const pdf = await reportPdf();
        expect(pdf.status).toBe(200);
        const pdfText = bodyText(pdf);
        expect(pdfText).toContain(SUB_OWN_NUMBER);
        expect(pdfText).not.toContain(SUB_OTHER_NUMBER);
        expect(pdfText).not.toContain(MASTER_NUMBER);

        asClient(subEmpty, 'sub_client');
        const emptyFilter = await filterReport();
        expect(emptyFilter.status).toBe(200);
        expect(emptyFilter.body.data.currentTransactions).toEqual([]);
        const emptyPdf = await reportPdf();
        expect(emptyPdf.status).toBe(200);
        expect(bodyText(emptyPdf)).not.toContain(SUB_OTHER_NUMBER);
        expect(bodyText(emptyPdf)).toContain('لا توجد تحويلات ناجحة');
    });

    test('a restricted company employee does not inherit a colleague report by name', async () => {
        asClient(companyEmployee, 'company');
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        const filtered = await filterReport(todayKey);
        expect(filtered.status).toBe(200);
        const numbers = beneficiaryNumbers(filtered.body.data);
        expect(numbers).toContain(COMPANY_OWN_NUMBER);
        expect(numbers).not.toContain(COMPANY_OTHER_NUMBER);
        expect(numbers).not.toContain(COMPANY_NAME_ONLY_NUMBER);

        const pdf = await reportPdf(todayKey);
        expect(pdf.status).toBe(200);
        const pdfText = bodyText(pdf);
        expect(pdfText).toContain(COMPANY_OWN_NUMBER);
        expect(pdfText).not.toContain(COMPANY_OTHER_NUMBER);
        expect(pdfText).not.toContain(COMPANY_NAME_ONLY_NUMBER);
    });

    test('an agent staff report export does not include a colleague matched only by name', async () => {
        const workspace = {
            type: 'agent',
            isCompany: false,
            isAgent: true,
            actor: agentStaff.toObject(),
            entity: agent.toObject(),
            permissions: resolveAgentPermissions(agentStaff.toObject()),
            forceToday: true
        };
        const report = await loadReports(workspace, {});
        const numbers = (report.reportTransactions || []).map((row) => row.vodafoneNumber);
        expect(numbers).toContain(STAFF_OWN_NUMBER);
        expect(numbers).not.toContain(STAFF_NAME_ONLY_NUMBER);
        expect(numbers).not.toContain(STAFF_OTHER_NUMBER);
        expect(JSON.stringify(report.reportSummary)).not.toContain('6700');
        expect(JSON.stringify(report.reportSummary)).not.toContain('6800');

        const req = {
            session: {
                isClientLoggedIn: true,
                clientId: String(agentStaff._id),
                accountType: 'agent_staff'
            },
            query: {},
            headers: {},
            method: 'GET',
            originalUrl: '/client/reports/export.csv',
            ip: '127.0.0.1'
        };
        const res = {
            headers: {},
            statusCode: 200,
            body: '',
            setHeader(name, value) { this.headers[name] = value; },
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
        await exportReportCsv(req, res);
        expect(res.statusCode).toBe(200);
        expect(String(res.body)).not.toContain('6700');
        expect(String(res.body)).not.toContain('6800');
        expect(String(res.body)).toContain('2100');
    });

    test('reading reports does not change balances, ledger rows, or transactions', async () => {
        expect(await balanceSnapshot()).toEqual(openingBalances);
    });
});
