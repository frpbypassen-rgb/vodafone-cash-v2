'use strict';

const mongoose = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const Admin = require('../models/Admin');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');

const SUPPORT_STATUSES = ['open', 'answered', 'pending_internal', 'resolved', 'closed'];
const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SUPPORT_CATEGORIES = [
    'general',
    'transfer',
    'deposit',
    'account',
    'whatsapp',
    'technical',
    'password_reset',
    'transaction',
    'pending_transaction',
    'balance',
    'report',
    'receipt',
    'cancellation',
    'application',
    'notifications',
    'employee_account',
    'api',
    'execution_group',
    'other'
];
const ACTIVE_SUPPORT_STATUSES = ['open', 'answered', 'pending_internal'];
const SUPPORT_PRESENCE_MS = 60 * 1000;

const SLA_TARGETS = Object.freeze({
    low: { responseMinutes: 30, resolutionMinutes: 720 },
    normal: { responseMinutes: 20, resolutionMinutes: 480 },
    high: { responseMinutes: 10, resolutionMinutes: 180 },
    urgent: { responseMinutes: 5, resolutionMinutes: 60 }
});

const cleanText = (value, maxLength = 180) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const toId = (value) => value == null ? '' : String(value);

const getAdminIdentity = (req) => ({
    id: toId(req.session?.adminId || req.session?.adminName || 'admin'),
    name: cleanText(req.session?.adminName || 'الإدارة', 120),
    role: cleanText(req.session?.adminRole || 'admin', 40)
});

const isAwaitingAdminReply = (ticket) => {
    if (ticket.status !== 'open') return false;
    const customerAt = toDate(ticket.lastCustomerMessageAt || ticket.waitingSince);
    const adminAt = toDate(ticket.lastAdminMessageAt);
    if (!customerAt) return !ticket.firstResponseAt;
    return !adminAt || customerAt.getTime() > adminAt.getTime();
};

const computeSupportSla = (ticket, nowValue = new Date()) => {
    const now = toDate(nowValue) || new Date();
    const priority = SUPPORT_PRIORITIES.includes(ticket.priority) ? ticket.priority : 'normal';
    const targets = SLA_TARGETS[priority];
    const createdAt = toDate(ticket.createdAt) || now;
    const waitingSince = toDate(ticket.waitingSince || ticket.lastCustomerMessageAt || ticket.createdAt) || createdAt;
    const closed = ticket.status === 'closed' || ticket.status === 'resolved';
    const awaitingReply = !closed && isAwaitingAdminReply(ticket);
    const responseDueAt = awaitingReply
        ? new Date(waitingSince.getTime() + targets.responseMinutes * 60 * 1000)
        : null;
    const resolutionDueAt = closed
        ? null
        : new Date(createdAt.getTime() + targets.resolutionMinutes * 60 * 1000);
    const dueDates = [responseDueAt, resolutionDueAt].filter(Boolean).sort((a, b) => a - b);
    const nextDueAt = dueDates[0] || null;
    const remainingMs = nextDueAt ? nextDueAt.getTime() - now.getTime() : null;

    return {
        priority,
        awaitingReply,
        responseMinutes: targets.responseMinutes,
        resolutionMinutes: targets.resolutionMinutes,
        responseDueAt,
        resolutionDueAt,
        nextDueAt,
        remainingMs,
        overdue: remainingMs != null && remainingMs < 0
    };
};

const ticketLastMessage = (ticket) => {
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    return messages[messages.length - 1] || null;
};

const serializeTicketSummary = (ticket, adminIdentity, now = new Date()) => {
    const lastMessage = ticketLastMessage(ticket);
    const handlerExpiresAt = toDate(ticket.activeHandlerExpiresAt);
    const handlerActive = Boolean(handlerExpiresAt && handlerExpiresAt.getTime() > now.getTime());
    const lastMessageAt = toDate(ticket.lastMessageAt || lastMessage?.createdAt || ticket.updatedAt || ticket.createdAt);

    return {
        _id: toId(ticket._id),
        ticketId: ticket.ticketId,
        entityType: ticket.entityType,
        name: ticket.name,
        phone: ticket.phone || ticket.phoneNormalized || '',
        phoneNormalized: ticket.phoneNormalized || '',
        channel: ticket.channel || 'portal',
        status: ticket.status || 'open',
        priority: SUPPORT_PRIORITIES.includes(ticket.priority) ? ticket.priority : 'normal',
        category: ticket.category || 'general',
        tags: Array.isArray(ticket.tags) ? ticket.tags : [],
        assignedToId: ticket.assignedToId || '',
        assignedToName: ticket.assignedToName || '',
        unreadAdmin: Number(ticket.unreadAdmin || 0),
        lastMessageAt,
        lastMessagePreview: cleanText(ticket.lastMessagePreview || lastMessage?.text || (lastMessage?.imageUrl ? 'مرفق صورة' : ''), 180),
        lastMessageSender: ticket.lastMessageSender || lastMessage?.sender || '',
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        lock: {
            active: handlerActive,
            mine: handlerActive && toId(ticket.activeHandlerId) === adminIdentity.id,
            holderId: handlerActive ? toId(ticket.activeHandlerId) : '',
            holderName: handlerActive ? ticket.activeHandlerName || '' : '',
            expiresAt: handlerActive ? handlerExpiresAt : null
        },
        sla: computeSupportSla(ticket, now)
    };
};

const buildTicketFilter = (query = {}, adminIdentity = { id: '' }) => {
    const filter = {};
    const search = cleanText(query.search, 80);

    if (search) {
        const pattern = new RegExp(escapeRegExp(search), 'i');
        filter.$or = [
            { ticketId: pattern },
            { name: pattern },
            { phone: pattern },
            { phoneNormalized: pattern },
            { lastMessagePreview: pattern }
        ];
    }

    const status = cleanText(query.status, 30);
    if (!status || status === 'active') filter.status = { $in: ACTIVE_SUPPORT_STATUSES };
    else if (SUPPORT_STATUSES.includes(status)) filter.status = status;

    const priority = cleanText(query.priority, 20);
    if (SUPPORT_PRIORITIES.includes(priority)) filter.priority = priority;

    const channel = cleanText(query.channel, 20);
    if (['portal', 'whatsapp'].includes(channel)) filter.channel = channel;

    const assigned = cleanText(query.assigned, 80);
    if (assigned === 'mine') filter.assignedToId = adminIdentity.id;
    else if (assigned === 'unassigned') filter.assignedToId = { $in: [null, ''] };
    else if (assigned) filter.assignedToId = assigned;

    if (String(query.unread || '') === 'true') filter.unreadAdmin = { $gt: 0 };
    return filter;
};

const listSupportTickets = async ({ query = {}, adminIdentity }) => {
    const filter = buildTicketFilter(query, adminIdentity);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(query.limit, 10) || 50));
    const fields = [
        'ticketId', 'entityType', 'name', 'phone', 'phoneNormalized', 'channel', 'status', 'priority',
        'category', 'tags', 'assignedToId', 'assignedToName', 'unreadAdmin', 'lastMessageAt',
        'lastMessagePreview', 'lastMessageSender', 'lastCustomerMessageAt', 'lastAdminMessageAt',
        'waitingSince', 'firstResponseAt', 'activeHandlerId', 'activeHandlerName', 'activeHandlerExpiresAt',
        'createdAt', 'updatedAt', 'messages'
    ].join(' ');

    const [documents, total] = await Promise.all([
        SupportTicket.find(filter)
            .select(fields)
            .slice('messages', -1)
            .sort({ unreadAdmin: -1, lastMessageAt: -1, updatedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
        SupportTicket.countDocuments(filter)
    ]);
    const now = new Date();

    return {
        tickets: documents.map((ticket) => serializeTicketSummary(ticket, adminIdentity, now)),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
    };
};

const getSupportSummary = async () => {
    const [summary] = await SupportTicket.aggregate([
        { $match: { status: { $in: ACTIVE_SUPPORT_STATUSES } } },
        {
            $set: {
                responseBase: { $ifNull: ['$waitingSince', { $ifNull: ['$lastCustomerMessageAt', '$createdAt'] }] },
                responseMs: {
                    $switch: {
                        branches: [
                            { case: { $eq: ['$priority', 'urgent'] }, then: 5 * 60 * 1000 },
                            { case: { $eq: ['$priority', 'high'] }, then: 10 * 60 * 1000 },
                            { case: { $eq: ['$priority', 'low'] }, then: 30 * 60 * 1000 }
                        ],
                        default: 20 * 60 * 1000
                    }
                },
                resolutionMs: {
                    $switch: {
                        branches: [
                            { case: { $eq: ['$priority', 'urgent'] }, then: 60 * 60 * 1000 },
                            { case: { $eq: ['$priority', 'high'] }, then: 180 * 60 * 1000 },
                            { case: { $eq: ['$priority', 'low'] }, then: 720 * 60 * 1000 }
                        ],
                        default: 480 * 60 * 1000
                    }
                },
                awaitingReply: {
                    $and: [
                        { $eq: ['$status', 'open'] },
                        {
                            $or: [
                                { $eq: [{ $ifNull: ['$lastAdminMessageAt', null] }, null] },
                                { $gt: [{ $ifNull: ['$lastCustomerMessageAt', '$waitingSince'] }, '$lastAdminMessageAt'] }
                            ]
                        }
                    ]
                }
            }
        },
        {
            $group: {
                _id: null,
                active: { $sum: 1 },
                unread: { $sum: { $ifNull: ['$unreadAdmin', 0] } },
                urgent: { $sum: { $cond: [{ $eq: ['$priority', 'urgent'] }, 1, 0] } },
                unassigned: {
                    $sum: {
                        $cond: [{ $eq: [{ $ifNull: ['$assignedToId', ''] }, ''] }, 1, 0]
                    }
                },
                overdue: {
                    $sum: {
                        $cond: [{
                            $or: [
                                { $and: ['$awaitingReply', { $lt: [{ $add: ['$responseBase', '$responseMs'] }, '$$NOW'] }] },
                                { $lt: [{ $add: ['$createdAt', '$resolutionMs'] }, '$$NOW'] }
                            ]
                        }, 1, 0]
                    }
                }
            }
        },
        { $project: { _id: 0, active: 1, unread: 1, urgent: 1, unassigned: 1, overdue: 1 } }
    ]);

    return summary || { active: 0, unread: 0, urgent: 0, unassigned: 0, overdue: 0 };
};

const listSupportAgents = async (adminIdentity) => {
    const admins = await Admin.find({}).select('_id name role').sort({ name: 1 }).lean();
    const agents = [{ id: adminIdentity.id, name: adminIdentity.name, role: adminIdentity.role }];
    for (const admin of admins) {
        const id = toId(admin._id);
        if (agents.some((agent) => agent.id === id)) continue;
        agents.push({ id, name: admin.name || 'مدير', role: admin.role || 'admin' });
    }
    return agents;
};

const validObjectId = (value) => Boolean(value && mongoose.isValidObjectId(value));

const leanById = async (Model, id, fields) => {
    if (!validObjectId(id)) return null;
    return Model.findById(id).select(fields).lean();
};

const accountSummary = (account, type, parent = null) => account ? {
    id: toId(account._id),
    type,
    name: account.name || '',
    phone: account.phone || '',
    username: account.webUsername || '',
    accountCode: account.accountCode || '',
    status: account.status || '',
    balance: Number(account.balance || 0),
    creditLimit: Number(account.creditLimit || 0),
    address: account.address || account.city || '',
    createdAt: account.createdAt || null,
    parent
} : null;

const resolveAccountContext = async (ticket) => {
    const id = ticket.entityId;
    const baseFields = '_id name phone webUsername accountCode status balance creditLimit address city createdAt';

    if (ticket.entityType === 'client_company') {
        const employee = await leanById(ClientEmployee, id, `${baseFields} companyId role permissions`);
        if (employee) {
            const company = await leanById(ClientCompany, employee.companyId, baseFields);
            return {
                account: accountSummary(employee, 'client_company_employee', company ? accountSummary(company, 'company') : null),
                transactionOwner: { companyId: employee.companyId, userId: toId(employee._id) }
            };
        }
        const company = await leanById(ClientCompany, id, baseFields);
        return {
            account: accountSummary(company, 'company'),
            transactionOwner: company ? { companyId: company._id } : null
        };
    }

    if (ticket.entityType === 'sub_client') {
        const subAccount = await leanById(SubAccount, id, `${baseFields} masterType masterId`);
        let parent = null;
        if (subAccount?.masterType === 'company') parent = await leanById(ClientCompany, subAccount.masterId, baseFields);
        if (subAccount?.masterType === 'user') parent = await leanById(User, subAccount.masterId, baseFields);
        return {
            account: accountSummary(subAccount, 'sub_client', parent ? accountSummary(parent, subAccount.masterType) : null),
            transactionOwner: subAccount ? { subAccountId: subAccount._id, userId: toId(subAccount._id) } : null
        };
    }

    if (ticket.entityType === 'executor') {
        const employee = await leanById(Employee, id, `${baseFields} groupId role`);
        const group = employee ? await leanById(ExecutorGroup, employee.groupId, '_id name balance status type') : null;
        return {
            account: accountSummary(employee, 'executor', group ? {
                id: toId(group._id), name: group.name || '', balance: Number(group.balance || 0), status: group.status || '', type: 'executor_group'
            } : null),
            transactionOwner: employee ? { executorId: toId(employee._id) } : null
        };
    }

    if (ticket.entityType === 'client_user') {
        const user = await leanById(User, id, `${baseFields} role agentCode`);
        if (user) {
            return {
                account: accountSummary(user, user.role === 'agent' ? 'agent' : 'client_user'),
                transactionOwner: { userId: toId(user._id) }
            };
        }
        const employee = await leanById(AgentEmployee, id, `${baseFields} agentId role permissions`);
        const agent = employee ? await leanById(User, employee.agentId, `${baseFields} role agentCode`) : null;
        return {
            account: accountSummary(employee, 'agent_employee', agent ? accountSummary(agent, 'agent') : null),
            transactionOwner: employee ? { userId: toId(employee._id) } : null
        };
    }

    return {
        account: {
            id: toId(ticket.entityId),
            type: 'whatsapp',
            name: ticket.name || '',
            phone: ticket.phone || ticket.phoneNormalized || '',
            username: '', accountCode: '', status: '', balance: 0, creditLimit: 0, address: '', createdAt: ticket.createdAt, parent: null
        },
        transactionOwner: null
    };
};

const buildTransactionFilter = (owner) => {
    if (!owner) return null;
    const filters = [];
    if (owner.companyId) filters.push({ companyId: owner.companyId });
    if (owner.subAccountId) filters.push({ subAccountId: owner.subAccountId });
    if (owner.userId) filters.push({ userId: owner.userId });
    if (owner.executorId) {
        filters.push({ operatorId: owner.executorId });
        filters.push({ assignedExecutorId: owner.executorId });
    }
    if (!filters.length) return null;
    return filters.length === 1 ? filters[0] : { $or: filters };
};

const getSupportTicketWorkspace = async (ticketId, adminIdentity) => {
    const ticket = await SupportTicket.findById(ticketId).lean();
    if (!ticket) return null;

    const context = await resolveAccountContext(ticket);
    const transactionFilter = buildTransactionFilter(context.transactionOwner);
    const previousFilter = validObjectId(ticket.entityId)
        ? { _id: { $ne: ticket._id }, entityType: ticket.entityType, entityId: ticket.entityId }
        : { _id: { $ne: ticket._id }, phoneNormalized: ticket.phoneNormalized || '__missing__' };

    const [transactions, previousTickets] = await Promise.all([
        transactionFilter
            ? Transaction.find(transactionFilter)
                .select('customId transferType amount costLYD status vodafoneNumber accountNumber accountName cancellationReason createdAt completedAt')
                .sort({ createdAt: -1 })
                .limit(8)
                .lean()
            : [],
        SupportTicket.find(previousFilter)
            .select('ticketId status priority category lastMessageAt lastMessagePreview createdAt updatedAt messages')
            .slice('messages', -1)
            .sort({ updatedAt: -1 })
            .limit(5)
            .lean()
    ]);

    return {
        ticket,
        summary: serializeTicketSummary(ticket, adminIdentity),
        account: context.account,
        recentTransactions: transactions,
        previousTickets: previousTickets.map((item) => serializeTicketSummary(item, adminIdentity))
    };
};

const acquireTicketPresence = async (ticketId, adminIdentity) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SUPPORT_PRESENCE_MS);
    const ticket = await SupportTicket.findOneAndUpdate({
        _id: ticketId,
        $or: [
            { activeHandlerId: adminIdentity.id },
            { activeHandlerId: { $exists: false } },
            { activeHandlerId: '' },
            { activeHandlerExpiresAt: { $lte: now } },
            { activeHandlerExpiresAt: { $exists: false } }
        ]
    }, {
        $set: {
            activeHandlerId: adminIdentity.id,
            activeHandlerName: adminIdentity.name,
            activeHandlerExpiresAt: expiresAt
        }
    }, { returnDocument: 'after', timestamps: false }).select('activeHandlerId activeHandlerName activeHandlerExpiresAt');

    if (ticket) return { acquired: true, holderId: adminIdentity.id, holderName: adminIdentity.name, expiresAt };
    const current = await SupportTicket.findById(ticketId).select('activeHandlerId activeHandlerName activeHandlerExpiresAt').lean();
    if (!current) return null;
    return {
        acquired: false,
        holderId: current.activeHandlerId || '',
        holderName: current.activeHandlerName || '',
        expiresAt: current.activeHandlerExpiresAt || null
    };
};

const heartbeatTicketPresence = async (ticketId, adminIdentity) => {
    const expiresAt = new Date(Date.now() + SUPPORT_PRESENCE_MS);
    const result = await SupportTicket.updateOne(
        { _id: ticketId, activeHandlerId: adminIdentity.id },
        { $set: { activeHandlerName: adminIdentity.name, activeHandlerExpiresAt: expiresAt } },
        { timestamps: false }
    );
    return { acquired: Number(result.matchedCount || 0) > 0, holderId: adminIdentity.id, holderName: adminIdentity.name, expiresAt };
};

const releaseTicketPresence = async (ticketId, adminIdentity) => {
    const result = await SupportTicket.updateOne(
        { _id: ticketId, activeHandlerId: adminIdentity.id },
        { $unset: { activeHandlerId: 1, activeHandlerName: 1, activeHandlerExpiresAt: 1 } },
        { timestamps: false }
    );
    return { released: Number(result.matchedCount || 0) > 0 };
};

const assertTicketWritableByAdmin = (ticket, adminIdentity, now = new Date()) => {
    const expiresAt = toDate(ticket.activeHandlerExpiresAt);
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) return;
    if (toId(ticket.activeHandlerId) === adminIdentity.id) return;

    const error = new Error(`هذه التذكرة قيد المعالجة الآن بواسطة ${ticket.activeHandlerName || 'مدير آخر'}.`);
    error.status = 409;
    error.code = 'SUPPORT_TICKET_LOCKED';
    throw error;
};

module.exports = {
    SUPPORT_STATUSES,
    SUPPORT_PRIORITIES,
    SUPPORT_CATEGORIES,
    ACTIVE_SUPPORT_STATUSES,
    SUPPORT_PRESENCE_MS,
    SLA_TARGETS,
    getAdminIdentity,
    computeSupportSla,
    serializeTicketSummary,
    buildTicketFilter,
    listSupportTickets,
    getSupportSummary,
    listSupportAgents,
    getSupportTicketWorkspace,
    acquireTicketPresence,
    heartbeatTicketPresence,
    releaseTicketPresence,
    assertTicketWritableByAdmin
};
