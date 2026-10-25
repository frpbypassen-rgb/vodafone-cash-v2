'use strict';

const ClientEmployee = require('../../models/ClientEmployee');
const Transaction = require('../../models/Transaction');
const SupportTicket = require('../../models/SupportTicket');
const { ownershipFilter } = require('./transactions');

const parseCompanyDepositSupportMessage = (text, meta = {}) => {
    const value = String(text || '');
    if (!value.includes('طلب إيداع رصيد')) return null;
    const amountMatch = value.match(/القيمة:\s*([0-9]+(?:\.[0-9]+)?)\s*LYD/i);
    const noteMatch = value.match(/الملاحظة:\s*([\s\S]+)$/i);
    const closed = ['closed', 'resolved'].includes(String(meta.status || ''));
    return {
        customId: meta.ticketId || 'TCK',
        amount: amountMatch ? Number(amountMatch[1]) : 0,
        status: closed ? 'deposit' : 'deposit_pending',
        createdAt: meta.createdAt || new Date(),
        source: 'support',
        note: String(noteMatch?.[1] || '').trim(),
    };
};

const COMPANY_DEPOSIT_FOLLOW_UP = /حالة|متابعة|وضع|ما\s*وصل|تم\s*اعتماد|رُفض|رفض|رقم\s*الطلب/u;

const COMPANY_DEPOSIT_CREATE_PHRASE =
    /طلب\s*إيداع(?:\s+رصيد)?|أريد\s*(?:أن\s*)?إيداع|اريد\s*(?:ان\s*)?ايداع|اعمل(?:ي|وا)?\s*إيداع|أضف(?:وا)?\s*رصيد|اضف(?:وا)?\s*رصيد|شحن(?:وا)?\s*(?:الرصيد|الحساب)|مول(?:وا)?\s*الحساب|إضافة\s*رصيد|اضافة\s*رصيد/u;

const isCompanyDepositCreateIntent = (text) => {
    if (parseCompanyDepositSupportMessage(text)) return true;
    const value = String(text || '').trim();
    if (!value || !COMPANY_DEPOSIT_CREATE_PHRASE.test(value)) return false;
    if (COMPANY_DEPOSIT_FOLLOW_UP.test(value) && !/(جديد|أريد|اريد|اعمل|أضف|اضف|شحن|مول)/u.test(value)) {
        return false;
    }
    return true;
};

const canCreateCompanyDepositRequest = (workspace) =>
    Boolean(workspace?.isCompany && workspace.permissions?.manager);

const countPendingCompanyDeposits = async (workspace, ownershipFilterValue) => {
    const ownership = ownershipFilterValue || (await ownershipFilter(workspace));
    const staffIds = await ClientEmployee.find({ companyId: workspace.entity._id }).distinct('_id');
    const [txCount, tickets] = await Promise.all([
        Transaction.countDocuments({ $and: [ownership, { status: 'deposit_pending' }] }),
        staffIds.length
            ? SupportTicket.find({
                  entityType: 'client_company',
                  entityId: { $in: staffIds },
                  status: { $nin: ['closed', 'resolved'] },
                  'messages.text': { $regex: 'طلب إيداع رصيد' },
              })
                  .select('messages status')
                  .lean()
            : [],
    ]);
    const supportPending = tickets.reduce(
        (count, ticket) =>
            count +
            (ticket.messages || []).filter((message) => String(message.text || '').includes('طلب إيداع رصيد'))
                .length,
        0
    );
    return txCount + supportPending;
};

const loadCompanyDeposits = async (workspace) => {
    const ownership = await ownershipFilter(workspace);
    const staffIds = await ClientEmployee.find({ companyId: workspace.entity._id }).distinct('_id');
    const [requests, tickets] = await Promise.all([
        Transaction.find({
            $and: [ownership, { status: { $in: ['deposit_pending', 'deposit', 'deduction'] } }],
        })
            .sort({ createdAt: -1 })
            .limit(25)
            .lean(),
        staffIds.length
            ? SupportTicket.find({
                  entityType: 'client_company',
                  entityId: { $in: staffIds },
                  'messages.text': { $regex: 'طلب إيداع رصيد' },
              })
                  .select('ticketId status messages updatedAt')
                  .sort({ updatedAt: -1 })
                  .limit(20)
                  .lean()
            : [],
    ]);
    const supportRows = [];
    tickets.forEach((ticket) => {
        (ticket.messages || []).forEach((message) => {
            const row = parseCompanyDepositSupportMessage(message.text, {
                ticketId: ticket.ticketId,
                status: ticket.status,
                createdAt: message.createdAt || ticket.updatedAt,
            });
            if (row) supportRows.push(row);
        });
    });
    const depositRequests = [...supportRows, ...requests]
        .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
        .slice(0, 25);
    return {
        depositRequests,
        pendingDepositCount: depositRequests.filter((item) => item.status === 'deposit_pending').length,
    };
};

module.exports = {
    parseCompanyDepositSupportMessage,
    COMPANY_DEPOSIT_FOLLOW_UP,
    COMPANY_DEPOSIT_CREATE_PHRASE,
    isCompanyDepositCreateIntent,
    canCreateCompanyDepositRequest,
    countPendingCompanyDeposits,
    loadCompanyDeposits,
};
