'use strict';

const { applyAdminTxPrivacy } = require('./adminAccountVisibilityService');

const FUNDING_STATUSES = Object.freeze(['deposit', 'deduction', 'deposit_pending']);
const DEPOSIT_PARTIES = Object.freeze(['all', 'company', 'executor', 'client']);
const COMPANY_DEPOSIT_TEXT = /طلب إيداع رصيد/;

const normalizeParty = (value) => {
    const party = String(value || 'all').trim().toLowerCase();
    return DEPOSIT_PARTIES.includes(party) ? party : 'all';
};

const normalizeFundingStatus = (value) => {
    const status = String(value || '').trim();
    return FUNDING_STATUSES.includes(status) ? status : '';
};

// Company funding rows carry companyId. Executor funding rows carry
// executorGroupId and no client-company id (admin settlement, deposit
// requests, and external executor funding). Retail client deposits have
// neither. Agency-client funding stays out via applyAdminTxPrivacy.
const buildAdminDepositQuery = ({ party = 'all', scope = {}, status = '' } = {}) => {
    const selectedParty = normalizeParty(party);
    const selectedStatus = normalizeFundingStatus(status);
    const query = applyAdminTxPrivacy({
        ...scope,
        status: { $in: selectedStatus ? [selectedStatus] : FUNDING_STATUSES }
    });

    if (selectedParty === 'company') {
        query.companyId = { $exists: true, $ne: null };
    } else if (selectedParty === 'executor') {
        query.executorGroupId = { $exists: true, $ne: null };
        query.companyId = null;
    } else if (selectedParty === 'client') {
        query.companyId = null;
        query.executorGroupId = null;
    }

    return query;
};

const classifyDepositParty = (transaction = {}) => {
    if (transaction.companyId) return 'company';
    if (transaction.executorGroupId) return 'executor';
    return 'client';
};

const parseCompanyDepositSupportMessage = (text) => {
    const value = String(text || '');
    if (!COMPANY_DEPOSIT_TEXT.test(value)) return null;
    const amountMatch = value.match(/القيمة:\s*([0-9]+(?:\.[0-9]+)?)\s*LYD/i);
    const noteMatch = value.match(/الملاحظة:\s*([\s\S]+)$/i);
    return {
        amount: amountMatch ? Number(amountMatch[1]) : 0,
        note: String(noteMatch?.[1] || '').trim()
    };
};

const companySupportDepositRows = (ticket = {}) => {
    if (String(ticket.entityType || '') !== 'client_company') return [];
    const closed = ['closed', 'resolved'].includes(String(ticket.status || ''));
    return (Array.isArray(ticket.messages) ? ticket.messages : []).flatMap((message, index) => {
        const parsed = parseCompanyDepositSupportMessage(message?.text);
        if (!parsed) return [];
        return [{
            source: 'support',
            party: 'company',
            ticketId: String(ticket._id || ''),
            reference: ticket.ticketId || 'TCK',
            messageIndex: index,
            amount: parsed.amount,
            note: parsed.note,
            status: closed ? 'deposit' : 'deposit_pending',
            companyName: ticket.name || '',
            phone: ticket.phone || '',
            createdAt: message.createdAt || ticket.updatedAt || ticket.createdAt || null
        }];
    });
};

const depositSupportMatch = () => ({
    $or: [
        { category: 'deposit' },
        { 'metadata.type': { $in: ['executor_deposit', 'client_deposit', 'company_deposit'] } },
        { entityType: 'client_company', 'messages.text': { $regex: 'طلب إيداع رصيد' } }
    ]
});

module.exports = {
    COMPANY_DEPOSIT_TEXT,
    DEPOSIT_PARTIES,
    FUNDING_STATUSES,
    buildAdminDepositQuery,
    classifyDepositParty,
    companySupportDepositRows,
    depositSupportMatch,
    normalizeFundingStatus,
    normalizeParty,
    parseCompanyDepositSupportMessage
};
