'use strict';

const sameId = (left, right) => String(left || '') === String(right || '');

const isVisibleAgencyClient = (subAccount) => (
    Boolean(subAccount)
    && String(subAccount.status || 'active') !== 'deleted'
);

const agentOwnsSubAccount = (agent, subAccount) => (
    isVisibleAgencyClient(subAccount)
    && Boolean(agent)
    && subAccount.masterType === 'user'
    && sameId(subAccount.masterId, agent._id)
);

const companyOwnsSubAccount = (company, subAccount) => (
    isVisibleAgencyClient(subAccount)
    && Boolean(company)
    && subAccount.masterType === 'company'
    && sameId(subAccount.masterId, company._id)
);

module.exports = {
    agentOwnsSubAccount,
    companyOwnsSubAccount,
    isVisibleAgencyClient,
    sameId
};
