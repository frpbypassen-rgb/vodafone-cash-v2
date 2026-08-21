'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Admin = require('../models/Admin');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const Transaction = require('../models/Transaction');

const ACTIVE_STATUSES = ['open', 'answered', 'pending_internal'];
const CLOSED_STATUSES = ['resolved', 'closed'];
const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SUPPORT_CATEGORIES = Object.freeze({
    execution_group: 'مجموعة شركة التنفيذ',
    transaction: 'مشكلة في عملية',
    pending_transaction: 'عملية متأخرة',
    balance: 'الرصيد والمطابقة',
    report: 'التقارير',
    receipt: 'الإيصال أو الإثبات',
    cancellation: 'إلغاء عملية',
    application: 'مشكلة في التطبيق',
    notifications: 'الإشعارات',
    employee_account: 'حساب موظف',
    api: 'منفذ API',
    other: 'طلب آخر'
});

const ROLE_CATEGORIES = Object.freeze({
    manager: Object.keys(SUPPORT_CATEGORIES),
    operator: [
        'transaction',
        'pending_transaction',
        'receipt',
        'cancellation',
        'application',
        'notifications',
        'other'
    ],
    accountant: [
        'balance',
        'report',
        'employee_account',
        'application',
        'notifications',
        'other'
    ]
});

const IMAGE_LIMIT = 3;
const IMAGE_BYTES_LIMIT = 2 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
});

const cleanText = (value, maxLength = 2000) => String(value || '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);

const toId = (value) => String(value?._id || value || '');

const supportError = (code, message, status = 400) => {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
};

const allowedCategoriesForRole = (role) => [
    ...(ROLE_CATEGORIES[role] || ROLE_CATEGORIES.operator)
];

const normalizeCategory = (category, role) => {
    const value = cleanText(category, 40) || 'other';
    if (!Object.hasOwn(SUPPORT_CATEGORIES, value)) {
        throw supportError('INVALID_SUPPORT_CATEGORY', 'نوع طلب الدعم غير صالح.');
    }
    if (!allowedCategoriesForRole(role).includes(value)) {
        throw supportError('FORBIDDEN_SUPPORT_CATEGORY', 'نوع الطلب غير متاح لصلاحية هذا الحساب.', 403);
    }
    return value;
};

const normalizePriority = (priority, category) => {
    const requested = cleanText(priority, 20);
    const defaultPriority = ['pending_transaction', 'cancellation', 'api'].includes(category)
        ? 'high'
        : 'normal';
    if (!requested) return defaultPriority;
    if (!SUPPORT_PRIORITIES.includes(requested)) return defaultPriority;
    return requested;
};

const buildExecutorTicketScope = (employee) => {
    const own = { entityType: 'executor', entityId: employee._id };
    if (employee.role !== 'manager') return own;

    return {
        entityType: 'executor',
        $or: [
            { entityId: employee._id },
            { 'metadata.executorGroupId': toId(employee.groupId) }
        ]
    };
};

const parseSupportImage = (imageBase64) => {
    const value = cleanText(imageBase64, 8 * 1024 * 1024);
    const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || !IMAGE_TYPES[match[1]]) {
        throw supportError('INVALID_IMAGE', 'الصورة المرفقة غير صالحة أو نوعها غير مدعوم.');
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) throw supportError('INVALID_IMAGE', 'الصورة المرفقة فارغة.');
    if (buffer.length > IMAGE_BYTES_LIMIT) {
        throw supportError('IMAGE_TOO_LARGE', 'حجم الصورة أكبر من 2 ميجابايت.');
    }
    return { buffer, ext: IMAGE_TYPES[match[1]] };
};

const saveSupportImages = async (imagesBase64 = []) => {
    if (!Array.isArray(imagesBase64)) {
        throw supportError('INVALID_ATTACHMENTS', 'صيغة المرفقات غير صالحة.');
    }
    if (imagesBase64.length > IMAGE_LIMIT) {
        throw supportError('ATTACHMENT_LIMIT', `يمكن إرفاق ${IMAGE_LIMIT} صور بحد أقصى.`);
    }

    const parsed = imagesBase64.filter(Boolean).map(parseSupportImage);
    if (!parsed.length) return [];

    const uploadDir = path.join(process.cwd(), 'uploads', 'support');
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const urls = [];
    for (const image of parsed) {
        const fileName = `support_executor_${crypto.randomBytes(18).toString('hex')}.${image.ext}`;
        await fs.promises.writeFile(path.join(uploadDir, fileName), image.buffer);
        urls.push(`/uploads/support/${fileName}`);
    }
    return urls;
};

const getExecutorIdentity = async (executorId) => {
    if (!mongoose.isValidObjectId(executorId)) {
        throw supportError('UNAUTHORIZED', 'جلسة المنفذ غير صالحة.', 401);
    }
    const employee = await Employee.findById(executorId).lean();
    if (!employee || employee.status !== 'active') {
        throw supportError('UNAUTHORIZED', 'حساب المنفذ غير نشط أو غير موجود.', 401);
    }
    const group = await ExecutorGroup.findById(employee.groupId).lean();
    if (!group || group.status !== 'active') {
        throw supportError('EXECUTOR_GROUP_INACTIVE', 'شركة التنفيذ غير نشطة حالياً.', 403);
    }
    return { employee, group };
};

const resolveLinkedTransaction = async ({ employee, transactionRef }) => {
    const reference = cleanText(transactionRef, 80);
    if (!reference) return null;

    const identityFilter = mongoose.isValidObjectId(reference)
        ? { $or: [{ _id: reference }, { customId: reference }] }
        : { customId: reference };
    const accessFilter = employee.role === 'manager'
        ? {
            $or: [
                { executorGroupId: employee.groupId },
                { managerGroupId: employee.groupId },
                { assignedExecutorId: toId(employee._id) },
                { operatorId: toId(employee._id) }
            ]
        }
        : {
            $or: [
                { assignedExecutorId: toId(employee._id) },
                { operatorId: toId(employee._id) }
            ]
        };
    const transaction = await Transaction.findOne({ $and: [identityFilter, accessFilter] })
        .select('_id customId status transferType amount vodafoneNumber accountNumber accountName createdAt completedAt')
        .lean();
    if (!transaction) {
        throw supportError('TRANSACTION_NOT_ACCESSIBLE', 'العملية غير موجودة أو لا تتبع حساب التنفيذ الحالي.', 404);
    }
    return {
        id: toId(transaction._id),
        customId: transaction.customId || '',
        status: transaction.status || '',
        transferType: transaction.transferType || '',
        amount: Number(transaction.amount || 0),
        recipient: transaction.vodafoneNumber || transaction.accountNumber || transaction.accountName || '',
        createdAt: transaction.createdAt || null,
        completedAt: transaction.completedAt || null
    };
};

const serializeMessage = (message) => ({
    id: toId(message._id),
    sender: message.sender || 'user',
    senderName: message.senderName || '',
    text: message.text || '',
    imageUrl: message.imageUrl || '',
    messageType: message.messageType || (message.imageUrl ? 'image' : 'text'),
    createdAt: message.createdAt || null
});

const serializeTicket = (ticket, { includeMessages = false } = {}) => {
    const metadata = ticket.metadata && typeof ticket.metadata === 'object' ? ticket.metadata : {};
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    const lastMessage = messages[messages.length - 1];
    const lastTextMessage = [...messages].reverse().find((message) => cleanText(message?.text, 200));
    const storedPreview = cleanText(ticket.lastMessagePreview, 200);
    const category = ticket.category || metadata.category || 'other';
    const result = {
        id: toId(ticket._id),
        ticketId: ticket.ticketId || '',
        status: ticket.status || 'open',
        priority: ticket.priority || 'normal',
        category,
        categoryLabel: SUPPORT_CATEGORIES[category] || SUPPORT_CATEGORIES.other,
        subject: metadata.subject || SUPPORT_CATEGORIES[category] || 'طلب دعم',
        requester: {
            id: toId(ticket.entityId),
            name: metadata.executorName || ticket.name || '',
            role: metadata.executorRole || 'operator'
        },
        group: {
            id: metadata.executorGroupId || '',
            name: metadata.executorGroupName || ''
        },
        transaction: metadata.transaction || null,
        diagnostics: metadata.diagnostics || null,
        lastMessage: storedPreview && storedPreview !== 'مرفق صورة'
            ? storedPreview
            : (lastTextMessage?.text || lastMessage?.text || (lastMessage?.imageUrl ? 'مرفق صورة' : '')),
        unreadCount: Number(ticket.unreadUser || 0),
        createdAt: ticket.createdAt || null,
        updatedAt: ticket.updatedAt || null
    };
    if (includeMessages) result.messages = messages.map(serializeMessage);
    return result;
};

const listExecutionGroupMembers = async (groupId) => {
    const employees = await Employee.find({ groupId, status: 'active' })
        .select('_id name role phone webUsername status')
        .sort({ role: 1, name: 1 })
        .lean();
    return [
        { id: 'administration', name: 'الإدارة', role: 'admin', status: 'active' },
        ...employees.map((employee) => ({
            id: toId(employee._id),
            name: employee.name || employee.webUsername || 'موظف تنفيذ',
            role: employee.role || 'operator',
            status: employee.status || 'active'
        }))
    ];
};

const getOrCreateExecutionGroupChat = async ({ employee, group }) => {
    const groupChatKey = `executor-group:${toId(group._id)}`;
    const filter = { groupChatKey };
    let ticket = await SupportTicket.findOne(filter).sort({ updatedAt: -1 });
    if (ticket) return ticket;

    const createdAt = new Date();
    try {
        ticket = await SupportTicket.create({
            entityType: 'executor_group',
            entityId: group._id,
            groupChatKey,
            name: group.name || 'شركة التنفيذ',
            channel: 'portal',
            status: 'open',
            priority: 'normal',
            category: 'execution_group',
            unreadAdmin: 0,
            unreadUser: 0,
            messages: [{
                sender: 'system',
                senderName: 'النظام',
                text: `تم إنشاء مجموعة الدعم الخاصة بشركة ${group.name || 'التنفيذ'}.`,
                channel: 'portal',
                direction: 'inbound',
                messageType: 'text',
                createdAt
            }],
            metadata: {
                conversationType: 'execution_group',
                subject: `مجموعة دعم ${group.name || 'شركة التنفيذ'}`,
                executorGroupId: toId(group._id),
                executorGroupName: group.name || '',
                createdByExecutorId: toId(employee._id)
            }
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        ticket = await SupportTicket.findOne(filter).sort({ updatedAt: -1 });
        if (!ticket) throw error;
    }
    return ticket;
};

const serializeExecutionGroupChat = async ({ ticket, group }) => ({
    ticket: {
        ...serializeTicket(ticket.toObject ? ticket.toObject() : ticket, { includeMessages: true }),
        isGroupChat: true,
        subject: `مجموعة دعم ${group.name || 'شركة التنفيذ'}`,
        category: 'execution_group',
        categoryLabel: SUPPORT_CATEGORIES.execution_group
    },
    members: await listExecutionGroupMembers(group._id)
});

const getExecutorGroupChat = async ({ executorId }) => {
    const { employee, group } = await getExecutorIdentity(executorId);
    const ticket = await getOrCreateExecutionGroupChat({ employee, group });
    return serializeExecutionGroupChat({ ticket, group });
};

const replyToExecutorGroupChat = async ({ executorId, payload = {} }) => {
    const { employee, group } = await getExecutorIdentity(executorId);
    const ticket = await getOrCreateExecutionGroupChat({ employee, group });
    const text = cleanText(payload.message || payload.text, 2000);
    const imageUrls = await saveSupportImages(payload.imagesBase64 || []);
    if (!text && !imageUrls.length) throw supportError('VALIDATION_ERROR', 'اكتب رسالة أو أرفق صورة واحدة على الأقل.');

    const createdAt = new Date();
    if (text) {
        ticket.messages.push({
            sender: 'user', senderName: employee.name, text, channel: 'portal',
            direction: 'inbound', messageType: 'text', createdAt
        });
    }
    imageUrls.forEach((imageUrl) => ticket.messages.push({
        sender: 'user', senderName: employee.name, text: '', imageUrl, channel: 'portal',
        direction: 'inbound', messageType: 'image', createdAt
    }));
    ticket.status = 'open';
    ticket.unreadAdmin = Number(ticket.unreadAdmin || 0) + 1;
    await ticket.save();
    await notifyAdmins({
        title: `رسالة في مجموعة ${group.name || 'التنفيذ'}`,
        message: `${employee.name}: ${text || 'أرفق صورة جديدة'}`
    });
    return serializeExecutionGroupChat({ ticket, group });
};

const listExecutorTickets = async ({ executorId, status = 'active', category, search, page = 1, limit = 30 }) => {
    const { employee } = await getExecutorIdentity(executorId);
    const scope = buildExecutorTicketScope(employee);
    const filters = [scope];

    if (status === 'active') filters.push({ status: { $in: ACTIVE_STATUSES } });
    else if (status === 'closed') filters.push({ status: { $in: CLOSED_STATUSES } });
    else if (status && status !== 'all' && [...ACTIVE_STATUSES, ...CLOSED_STATUSES].includes(status)) {
        filters.push({ status });
    }

    const categoryValue = cleanText(category, 40);
    if (categoryValue && Object.hasOwn(SUPPORT_CATEGORIES, categoryValue)) {
        filters.push({ category: categoryValue });
    }
    const searchValue = cleanText(search, 80);
    if (searchValue) {
        const escaped = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(escaped, 'i');
        filters.push({
            $or: [
                { ticketId: pattern },
                { name: pattern },
                { lastMessagePreview: pattern },
                { 'metadata.subject': pattern },
                { 'metadata.transaction.customId': pattern }
            ]
        });
    }

    const query = filters.length === 1 ? filters[0] : { $and: filters };
    const pageValue = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitValue = Math.min(50, Math.max(10, Number.parseInt(limit, 10) || 30));
    const activeScope = { $and: [scope, { status: { $in: ACTIVE_STATUSES } }] };
    const closedScope = { $and: [scope, { status: { $in: CLOSED_STATUSES } }] };

    const [tickets, total, active, closed, unread] = await Promise.all([
        SupportTicket.find(query)
            .sort({ unreadUser: -1, updatedAt: -1 })
            .skip((pageValue - 1) * limitValue)
            .limit(limitValue)
            .lean(),
        SupportTicket.countDocuments(query),
        SupportTicket.countDocuments(activeScope),
        SupportTicket.countDocuments(closedScope),
        SupportTicket.countDocuments({ $and: [scope, { unreadUser: { $gt: 0 } }] })
    ]);

    return {
        tickets: tickets.map((ticket) => serializeTicket(ticket)),
        summary: { active, closed, unread },
        permissions: {
            role: employee.role,
            canViewGroupTickets: employee.role === 'manager',
            categories: allowedCategoriesForRole(employee.role)
        },
        pagination: {
            page: pageValue,
            limit: limitValue,
            total,
            pages: Math.max(1, Math.ceil(total / limitValue))
        }
    };
};

const createExecutorTicket = async ({ executorId, payload = {} }) => {
    const { employee, group } = await getExecutorIdentity(executorId);
    const category = normalizeCategory(payload.category, employee.role);
    const subject = cleanText(payload.subject, 120);
    const message = cleanText(payload.message || payload.text, 2000);
    if (subject.length < 4) throw supportError('VALIDATION_ERROR', 'عنوان الطلب يجب ألا يقل عن 4 أحرف.');
    if (message.length < 5) throw supportError('VALIDATION_ERROR', 'اشرح المشكلة في 5 أحرف على الأقل.');

    const [imageUrls, transaction] = await Promise.all([
        saveSupportImages(payload.imagesBase64 || []),
        resolveLinkedTransaction({ employee, transactionRef: payload.transactionRef })
    ]);
    const createdAt = new Date();
    const messages = [{
        sender: 'user',
        senderName: employee.name,
        text: message,
        channel: 'portal',
        direction: 'inbound',
        messageType: 'text',
        createdAt
    }];
    for (const imageUrl of imageUrls) {
        messages.push({
            sender: 'user',
            senderName: employee.name,
            text: '',
            imageUrl,
            channel: 'portal',
            direction: 'inbound',
            messageType: 'image',
            createdAt
        });
    }

    const diagnostics = payload.diagnostics && typeof payload.diagnostics === 'object'
        ? {
            appVersion: cleanText(payload.diagnostics.appVersion, 40),
            platform: cleanText(payload.diagnostics.platform, 40),
            apiBaseUrl: cleanText(payload.diagnostics.apiBaseUrl, 200),
            notificationPermission: cleanText(payload.diagnostics.notificationPermission, 40),
            backgroundService: cleanText(payload.diagnostics.backgroundService, 40),
            networkStatus: cleanText(payload.diagnostics.networkStatus, 40)
        }
        : null;

    const ticket = await SupportTicket.create({
        entityType: 'executor',
        entityId: employee._id,
        telegramId: employee.phone || employee.webUsername,
        name: employee.name,
        phone: employee.phone || '',
        channel: 'portal',
        status: 'open',
        priority: normalizePriority(payload.priority, category),
        category,
        unreadAdmin: 1,
        unreadUser: 0,
        messages,
        metadata: {
            subject,
            category,
            executorName: employee.name,
            executorRole: employee.role,
            executorGroupId: toId(group._id),
            executorGroupName: group.name || '',
            transaction,
            diagnostics
        }
    });

    await notifyAdmins({
        title: 'طلب دعم جديد من منفذ',
        message: `${employee.name} - ${group.name}: ${subject}`
    });
    return serializeTicket(ticket.toObject ? ticket.toObject() : ticket, { includeMessages: true });
};

const getExecutorTicket = async ({ executorId, ticketId }) => {
    const { employee } = await getExecutorIdentity(executorId);
    if (!mongoose.isValidObjectId(ticketId)) throw supportError('NOT_FOUND', 'طلب الدعم غير موجود.', 404);
    const ticket = await SupportTicket.findOne({ $and: [{ _id: ticketId }, buildExecutorTicketScope(employee)] });
    if (!ticket) throw supportError('NOT_FOUND', 'طلب الدعم غير موجود أو لا تملك صلاحية عرضه.', 404);
    if (ticket.unreadUser > 0 && toId(ticket.entityId) === toId(employee._id)) {
        ticket.unreadUser = 0;
        await ticket.save();
    }
    return serializeTicket(ticket.toObject ? ticket.toObject() : ticket, { includeMessages: true });
};

const replyToExecutorTicket = async ({ executorId, ticketId, payload = {} }) => {
    const { employee } = await getExecutorIdentity(executorId);
    if (!mongoose.isValidObjectId(ticketId)) throw supportError('NOT_FOUND', 'طلب الدعم غير موجود.', 404);
    const ticket = await SupportTicket.findOne({ $and: [{ _id: ticketId }, buildExecutorTicketScope(employee)] });
    if (!ticket) throw supportError('NOT_FOUND', 'طلب الدعم غير موجود أو لا تملك صلاحية الرد عليه.', 404);
    if (CLOSED_STATUSES.includes(ticket.status)) {
        throw supportError('TICKET_CLOSED', 'هذا الطلب مغلق. افتح طلباً جديداً للمتابعة.', 409);
    }

    const text = cleanText(payload.message || payload.text, 2000);
    const imageUrls = await saveSupportImages(payload.imagesBase64 || []);
    if (!text && !imageUrls.length) throw supportError('VALIDATION_ERROR', 'اكتب رداً أو أرفق صورة واحدة على الأقل.');
    const createdAt = new Date();
    if (text) {
        ticket.messages.push({
            sender: 'user',
            senderName: employee.name,
            text,
            channel: 'portal',
            direction: 'inbound',
            messageType: 'text',
            createdAt
        });
    }
    for (const imageUrl of imageUrls) {
        ticket.messages.push({
            sender: 'user',
            senderName: employee.name,
            text: '',
            imageUrl,
            channel: 'portal',
            direction: 'inbound',
            messageType: 'image',
            createdAt
        });
    }
    ticket.status = 'open';
    ticket.unreadAdmin = Number(ticket.unreadAdmin || 0) + 1;
    await ticket.save();
    await notifyAdmins({
        title: 'رد جديد من منفذ',
        message: `${employee.name}: ${text || 'أرفق صورة جديدة'}`
    });
    return serializeTicket(ticket.toObject ? ticket.toObject() : ticket, { includeMessages: true });
};

const getExecutorDiagnostics = async ({ executorId }) => {
    const { employee, group } = await getExecutorIdentity(executorId);
    return {
        server: 'online',
        database: mongoose.connection.readyState === 1 ? 'connected' : 'degraded',
        account: employee.status,
        executorGroup: group.status,
        role: employee.role,
        serverTime: new Date().toISOString()
    };
};

async function notifyAdmins({ title, message }) {
    const admins = await Admin.find({}).select('webUsername').lean().catch(() => []);
    await Promise.all(admins.map((admin) => Notification.create({
        userId: admin.webUsername || 'admin',
        title,
        message,
        type: 'support_message'
    }).catch(() => null)));
}

module.exports = {
    ACTIVE_STATUSES,
    CLOSED_STATUSES,
    SUPPORT_CATEGORIES,
    allowedCategoriesForRole,
    normalizeCategory,
    normalizePriority,
    buildExecutorTicketScope,
    parseSupportImage,
    serializeTicket,
    listExecutorTickets,
    createExecutorTicket,
    getExecutorTicket,
    replyToExecutorTicket,
    getExecutorGroupChat,
    replyToExecutorGroupChat,
    getExecutorDiagnostics
};
