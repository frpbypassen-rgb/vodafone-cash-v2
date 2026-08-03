'use strict';

const Notification = require('../models/Notification');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');

const unique = (values) => [...new Set(values.filter(Boolean).map(String))];

const accountLabel = (account) => account?.name || account?.webUsername || account?.phone || 'client';

const primaryClientUserId = (account) => (
    account?.phone || account?.webUsername || (account?._id ? String(account._id) : null)
);

const clientUserIdsForAccount = async (accountModel, account) => {
    if (!account) return [];

    if (accountModel === 'ClientCompany') {
        const employees = await ClientEmployee
            .find({ companyId: account._id, status: 'active' })
            .select('_id webUsername phone')
            .lean();

        return unique(employees.map((employee) => (
            employee.webUsername || employee.phone || String(employee._id)
        )));
    }

    if (accountModel === 'SubAccount') {
        return unique([account.webUsername, account.phone, account._id]);
    }

    return unique([primaryClientUserId(account)]);
};

const resolveClientNotificationUserIds = async ({ accountType, clientId }) => {
    if (!clientId) return [];

    if (accountType === 'company' || accountType === 'client_company') {
        const employee = await ClientEmployee.findById(clientId).select('_id webUsername phone companyId').lean();
        if (!employee) return [];
        return unique([employee.webUsername, employee.phone, employee._id, employee.companyId]);
    }

    if (accountType === 'sub_client') {
        const subAccount = await SubAccount.findById(clientId).select('_id webUsername phone').lean();
        if (!subAccount) return [];
        return unique([subAccount.webUsername, subAccount.phone, subAccount._id]);
    }

    if (accountType === 'agent_staff') {
        const employee = await AgentEmployee.findById(clientId).select('_id webUsername phone agentId').lean();
        if (!employee) return [];
        return unique([employee.webUsername, employee.phone, employee._id, employee.agentId]);
    }

    const user = await User.findById(clientId).select('_id phone webUsername').lean();
    if (!user) return [];
    return unique([user.phone, user.webUsername, user._id]);
};

const createClientNotifications = async ({
    accountModel,
    account,
    title,
    message,
    type = 'system_alert',
    txId,
    metadata = {}
}) => {
    const userIds = await clientUserIdsForAccount(accountModel, account);
    const docs = await Promise.all(userIds.map((userId) => Notification.create({
        userId,
        audience: 'client',
        targetModel: accountModel,
        targetId: account._id,
        title,
        message,
        type,
        txId,
        metadata
    }).catch(() => null)));

    return docs.filter(Boolean);
};

const buildBalanceAdjustmentMessage = ({ amount, balanceAfter, customId, notes }) => {
    const absoluteAmount = Math.abs(Number(amount || 0)).toFixed(2);
    const action = amount >= 0 ? 'تم إيداع' : 'تم خصم';
    const balanceText = Number.isFinite(Number(balanceAfter))
        ? ` رصيدك الحالي: ${Number(balanceAfter).toFixed(2)} LYD.`
        : '';
    const notesText = notes ? ` ملاحظة: ${notes}` : '';
    return `${action} ${absoluteAmount} LYD في حسابك.${balanceText} رقم العملية: ${customId}.${notesText}`;
};

const notifyBalanceAdjustment = async ({ accountModel, account, amount, balanceAfter, customId, notes }) => {
    return createClientNotifications({
        accountModel,
        account,
        title: amount >= 0 ? 'إيداع رصيد' : 'خصم رصيد',
        message: buildBalanceAdjustmentMessage({ amount, balanceAfter, customId, notes }),
        type: amount >= 0 ? 'deposit' : 'deduction',
        txId: customId,
        metadata: {
            accountName: accountLabel(account),
            amount: Math.abs(Number(amount || 0)),
            balanceAfter
        }
    });
};

module.exports = {
    createClientNotifications,
    notifyBalanceAdjustment,
    resolveClientNotificationUserIds
};
