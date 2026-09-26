'use strict';

const mongoose = require('mongoose');

const id = (hex) => new mongoose.Types.ObjectId(hex);

const IDS = {
    admin: id('64a000000000000000000001'),
    client: id('64a000000000000000000010'),
    poor: id('64a000000000000000000011'),
    company: id('64a000000000000000000020'),
    companyEmployee: id('64a000000000000000000021'),
    agent: id('64a000000000000000000030'),
    agentEmployee: id('64a000000000000000000031'),
    sub: id('64a000000000000000000032'),
    humanGroup: id('64a000000000000000000040'),
    humanEmployee: id('64a000000000000000000041'),
    apiGroup: id('64a000000000000000000050')
};

const seed = async (models) => {
    await models.Admin.create({
        _id: IDS.admin,
        name: 'RC Review Admin',
        role: 'master',
        webUsername: 'rc-review-admin',
        webPassword: 'TestPassw0rd!',
        status: 'active'
    });

    await models.User.create({
        _id: IDS.client,
        name: 'عميل مراجعة',
        phone: '01055550001',
        webUsername: 'rc-client',
        webPassword: 'TestPassw0rd!',
        role: 'user',
        status: 'active',
        tier: 1,
        balance: 5000,
        accountCode: '100001',
        sessionVersion: 0
    });

    await models.User.create({
        _id: IDS.poor,
        name: 'عميل رصيد ضعيف',
        phone: '01055550002',
        webUsername: 'rc-poor',
        webPassword: 'TestPassw0rd!',
        role: 'user',
        status: 'active',
        tier: 1,
        balance: 0.5,
        accountCode: '100002',
        sessionVersion: 0
    });

    await models.ClientCompany.create({
        _id: IDS.company,
        name: 'شركة المراجعة',
        phone: '01055550020',
        status: 'active',
        tier: 1,
        balance: 8000,
        accountCode: '20001',
        token: 'company-token-rc-review',
        exchangeRate: 8,
        creditLimit: 0
    });

    await models.ClientEmployee.create({
        _id: IDS.companyEmployee,
        companyId: IDS.company,
        name: 'موظف الشركة',
        phone: '01055550021',
        webUsername: 'rc-company-owner',
        webPassword: 'TestPassw0rd!',
        role: 'owner',
        status: 'active',
        sessionVersion: 0
    });

    await models.User.create({
        _id: IDS.agent,
        name: 'وكيل المراجعة',
        phone: '01055550030',
        webUsername: 'rc-agent',
        webPassword: 'TestPassw0rd!',
        role: 'agent',
        status: 'active',
        tier: 1,
        balance: 7000,
        accountCode: '3001',
        agentCode: '3001',
        apiToken: 'agent-token-rc-review',
        sessionVersion: 0
    });

    await models.AgentEmployee.create({
        _id: IDS.agentEmployee,
        agentId: IDS.agent,
        name: 'موظف الوكيل',
        phone: '01055550031',
        webUsername: 'rc-agent-staff',
        webPassword: 'TestPassw0rd!',
        role: 'employee',
        status: 'active',
        sessionVersion: 0
    });

    await models.SubAccount.create({
        _id: IDS.sub,
        masterType: 'user',
        masterId: IDS.agent,
        name: 'نقطة بيع المراجعة',
        phone: '01055550032',
        webUsername: 'rc-sub',
        webPassword: 'TestPassw0rd!',
        status: 'active',
        balance: 4000,
        accountCode: '100032',
        marginPiasters: 50,
        pricingVersion: 2,
        sessionVersion: 0
    });

    await models.ExecutorGroup.create({
        _id: IDS.humanGroup,
        name: 'منفذ بشري مراجعة',
        status: 'active',
        balance: 100000,
        serviceKey: 'vodafone',
        manualReceiptPrefix: '481',
        manualProofRequired: false,
        manualAllowedPhoneLengths: [11],
        manualSplitRequiresFullPhone: true,
        isApiBot: false,
        isManagerBot: false
    });

    await models.Employee.create({
        _id: IDS.humanEmployee,
        name: 'منفذ المراجعة',
        phone: '01055550041',
        webUsername: 'rc-executor',
        webPassword: 'TestPassw0rd!',
        role: 'operator',
        status: 'active',
        groupId: IDS.humanGroup,
        sessionVersion: 0
    });

    await models.ExecutorGroup.create({
        _id: IDS.apiGroup,
        name: 'منفذ API مراجعة',
        status: 'active',
        balance: 250000,
        serviceKey: 'vodafone',
        isApiBot: true,
        isApiGroup: true,
        apiProviderKey: 'zayn_external_aggregator',
        apiUrl: 'http://127.0.0.1:3999',
        apiUsername: 'rc-review-user',
        apiPassword: 'rc-review-pass',
        apiServiceId: 85,
        apiProviderId: 16,
        apiFieldId: 5488,
        apiMachineSerial: 'XP1'
    });

    await models.Settings.create({
        isManualClosed: false,
        autoRouteEnabled: false,
        autoRouteStrategy: 'fixed',
        rateLevel1: 6.4,
        cashRateLevel1: 6.4
    });

    return IDS;
};

module.exports = { seed, IDS, id };
