'use strict';

const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const { tenantMode, tenantIsolationRequired } = require('./tenantResolver');
const { tenantScope } = require('../utils/tenantScope');

const stringId = (value) => String(value?._id || value || '');
const COMPANY_DEPOSIT_ROLES = new Set(['manager', 'accountant']);
const EXECUTOR_ROLES = new Set(['operator', 'external', 'manager', 'accountant']);

const uploadRelativePath = (url) => {
    try {
        const decoded = decodeURIComponent(String(url || '').split('?')[0]);
        if (!decoded.startsWith('/') || decoded.length > 512) return null;
        const segments = decoded.slice(1).split('/');
        if (!segments.every((segment) => (
            /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(segment) && !segment.endsWith('.')
        ))) return null;
        if (segments[0].toLowerCase() === 'account-documents') return null;
        return segments.join('/');
    } catch (_error) {
        return null;
    }
};

const fileReferences = (relativePath) => [
    relativePath,
    `/uploads/${relativePath}`,
    `uploads/${relativePath}`
];

const transactionFileFilter = (relativePath, employee, scope) => {
    const groupId = employee.groupId;
    const references = fileReferences(relativePath).filter((reference) => (
        relativePath.includes('/') || reference !== relativePath
    ));
    // Legacy bare proof IDs map only to uploads/proofs, never to another folder.
    if (/^proofs\/[^/]+$/.test(relativePath)) references.push(relativePath.slice('proofs/'.length));
    const fields = ['proofImage', 'proofImages'];
    if (employee.role === 'manager') {
        fields.push('executorProofImages', 'executorSenderEntries.proofImage', 'executorSenderEntries.customerProof.imageId');
    }
    const filter = [
        scope,
        { $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }] },
        { $or: fields.map((field) => ({ [field]: { $in: references } })) }
    ];
    if (COMPANY_DEPOSIT_ROLES.has(employee.role)) {
        filter[2].$or.push({ 'depositRequest.receiptImages': { $in: references } });
    } else {
        filter.push({
            status: { $nin: ['deposit_pending', 'deposit', 'deduction'] },
            'depositRequest.submittedById': null,
            'depositRequest.supportTicketId': null
        });
    }
    return { $and: filter };
};

const supportFileFilter = (relativePath, employee) => {
    const groupId = employee.groupId;
    const ownTicket = {
        entityType: 'executor',
        entityId: employee._id,
        'metadata.executorGroupId': { $in: [stringId(groupId), null] }
    };
    const ticketScopes = [
        ownTicket,
        {
            entityType: 'executor_group', entityId: groupId,
            groupChatKey: `executor-group:${stringId(groupId)}`,
            'metadata.conversationType': 'execution_group'
        }
    ];
    if (employee.role === 'manager') {
        ticketScopes.push({ entityType: 'executor', 'metadata.executorGroupId': stringId(groupId) });
    }
    if (COMPANY_DEPOSIT_ROLES.has(employee.role)) {
        ticketScopes.push({ entityType: 'executor_group', entityId: groupId, 'metadata.type': 'executor_deposit' });
    }
    return {
        $and: [
            { $or: ticketScopes },
            {
                messages: {
                    $elemMatch: {
                        imageUrl: { $in: fileReferences(relativePath) },
                        // Legacy web support accepts arbitrary imageUrl strings. Only
                        // server-created image messages or admin attachments can grant access.
                        $or: [{ messageType: 'image' }, { sender: 'admin' }]
                    }
                }
            }
        ]
    };
};

const tenantMatches = (record, tenantId, multiTenant) => (
    multiTenant
        ? stringId(record.tenantId) === tenantId
        : !record.tenantId || !tenantId || stringId(record.tenantId) === tenantId
);

module.exports = async (req, res, next) => {
    if (req.session?.isLoggedIn) return next();
    if (!req.session?.isExecutorLoggedIn || !mongoose.isValidObjectId(req.session.executorId)) {
        return res.status(403).send('Forbidden');
    }
    const relativePath = uploadRelativePath(req.url);
    if (!relativePath || !['GET', 'HEAD'].includes(req.method) || req.session.mfaEnrollmentRequired) {
        return res.status(403).send('Forbidden');
    }
    try {
        const multiTenant = tenantMode() === 'multi';
        const resolvedTenantId = stringId(req.tenantId || req.tenant);
        if (!resolvedTenantId && (multiTenant || tenantIsolationRequired())) {
            return res.status(403).send('Forbidden');
        }
        const employee = await Employee.findById(req.session.executorId)
            .select('_id role status groupId sessionVersion tenantId').lean();
        if (!employee || employee.status !== 'active' || !EXECUTOR_ROLES.has(employee.role)
            || !mongoose.isValidObjectId(employee.groupId)
            || Number(employee.sessionVersion || 0) !== Number(req.session.executorSessionVersion || 0)) {
            return res.status(403).send('Forbidden');
        }
        const group = await ExecutorGroup.findById(employee.groupId).select('_id status tenantId').lean();
        const tenantId = resolvedTenantId || stringId(group?.tenantId || employee.tenantId);
        if (!group || group.status !== 'active'
            || !tenantMatches(employee, tenantId, multiTenant) || !tenantMatches(group, tenantId, multiTenant)) {
            return res.status(403).send('Forbidden');
        }
        const scope = tenantScope(tenantId);
        if (await Transaction.exists(transactionFileFilter(relativePath, employee, scope))
            || await SupportTicket.exists(supportFileFilter(relativePath, employee))) {
            return next();
        }
        return res.status(403).send('Forbidden');
    } catch (_error) {
        return res.status(503).send('Upload access unavailable');
    }
};
