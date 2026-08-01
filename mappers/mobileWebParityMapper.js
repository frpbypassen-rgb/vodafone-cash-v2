// mappers/mobileWebParityMapper.js
'use strict';

const { getTransferServiceLabel } = require('../utils/mobileTransferServiceCatalog');

const toClientReportDto = (data) => {
    return {
        previousBalance: Number(data.previousBalance || 0),
        operations: (data.operations || []).map(tx => ({
            id: String(tx._id),
            customId: tx.customId,
            transferType: tx.transferType,
            transferTypeLabel: getTransferServiceLabel(tx.transferType),
            recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
            recipientName: tx.accountName || null,
            amount: Number(tx.amount || 0),
            costLYD: Number(tx.costLYD || 0),
            exchangeRate: Number(tx.exchangeRate || 0),
            status: tx.status,
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
            notes: tx.notes || null,
            hasProofImage: !!(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0))
        })),
        deposits: (data.deposits || []).map(tx => ({
            id: String(tx._id),
            customId: tx.customId,
            transferType: tx.transferType,
            transferTypeLabel: getTransferServiceLabel(tx.transferType),
            amount: Number(tx.amount || 0),
            status: tx.status,
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
            notes: tx.notes || null
        })),
        currentTransactions: (data.currentTransactions || []).map(tx => ({
            id: String(tx._id),
            customId: tx.customId,
            transferType: tx.transferType,
            transferTypeLabel: getTransferServiceLabel(tx.transferType),
            amount: Number(tx.amount || 0),
            costLYD: Number(tx.costLYD || 0),
            status: tx.status,
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null
        })),
        totalLYD: Number(data.totalLYD || 0),
        totalEGP: Number(data.totalEGP || 0),
        completedCount: Number(data.completedCount || 0),
        rejectedCount: Number(data.rejectedCount || 0),
        totalDeposits: Number(data.totalDeposits || 0),
        entityInfo: {
            name: data.entityInfo?.name || '---',
            phone: data.entityInfo?.phone || '---',
            username: data.entityInfo?.username || '---',
            joinDate: data.entityInfo?.joinDate ? new Date(data.entityInfo.joinDate).toISOString() : null,
            status: data.entityInfo?.status || '---'
        }
    };
};

const toBalanceTransferLookupDto = (target) => {
    return {
        accountCode: target.doc.accountCode,
        name: target.doc.name || target.doc.webUsername || target.doc.phone || 'حساب بدون اسم',
        type: target.label || 'حساب'
    };
};

const toBalanceTransferExecuteDto = (result) => {
    return {
        transferId: result.transferId,
        amount: Number(result.amount || 0),
        newBalance: Number(result.sourceBalance || 0),
        targetName: result.targetName,
        targetCode: result.targetCode,
        targetType: result.targetType
    };
};

const toComplaintDto = (tx) => {
    return {
        id: String(tx._id),
        customId: tx.customId,
        complaintText: tx.complaintText,
        status: tx.status,
        updatedAt: tx.updatedAt.toISOString()
    };
};

const toExecutorTaskDto = (tx) => {
    return {
        id: tx._id ? String(tx._id) : null,
        txId: tx.customId || null,
        transferType: tx.transferType || null,
        transferTypeLabel: getTransferServiceLabel(tx.transferType),
        amount: Number(tx.amount || 0),
        recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
        recipientName: tx.accountName || null,
        status: tx.status || 'unknown',
        createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
        emergencyAlert: tx.emergencyAlert || null
    };
};

const toExecutorSupportTicketDto = (ticket) => {
    return {
        id: String(ticket._id),
        ticketId: ticket.ticketId,
        name: ticket.name,
        phone: ticket.phone,
        status: ticket.status,
        unreadCount: ticket.unreadUser || 0,
        messages: (ticket.messages || []).map(m => ({
            sender: m.sender,
            text: m.text,
            imageUrl: m.imageUrl || null,
            createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null
        })),
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString()
    };
};

const toEmployeeDto = (emp) => {
    return {
        id: String(emp._id),
        name: emp.name,
        phone: emp.phone || '',
        role: emp.role,
        status: emp.status,
        webUsername: emp.webUsername,
        canViewAllReports: !!emp.canViewAllReports,
        createdAt: emp.createdAt ? new Date(emp.createdAt).toISOString() : null
    };
};

module.exports = {
    toClientReportDto,
    toBalanceTransferLookupDto,
    toBalanceTransferExecuteDto,
    toComplaintDto,
    toExecutorTaskDto,
    toExecutorSupportTicketDto,
    toEmployeeDto
};
