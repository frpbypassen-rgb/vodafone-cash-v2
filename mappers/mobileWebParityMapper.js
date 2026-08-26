// mappers/mobileWebParityMapper.js
'use strict';

const { getTransferServiceLabel } = require('../utils/mobileTransferServiceCatalog');
const { buildExecutorTaskRecipient } = require('../utils/executorTaskPrivacy');
const { createReceiptImageUrl } = require('../services/receiptShareService');

const receiptFields = (tx) => {
    const hasProofImage = Boolean(tx.proofImage || (tx.proofImages && tx.proofImages.length > 0));
    return {
        hasProofImage,
        receiptUrl: hasProofImage ? createReceiptImageUrl({ transactionId: tx._id, index: 0 }) : null,
        cancellationNumber: tx.cancellationNumber || null,
        cancellationReason: tx.cancellationReason || null
    };
};

const mapSenderEntries = (tx) => (
    Array.isArray(tx.executorSenderEntries)
        ? tx.executorSenderEntries.map((entry) => ({
            phone: entry.phone || null,
            amount: entry.amount === undefined || entry.amount === null ? null : Number(entry.amount),
            proofImage: entry.proofImage || null,
            proofImageUrl: entry.proofImage ? `/executor-portal/proxy/image/${entry.proofImage}` : null
        }))
        : []
);

const managerExecutorEvidence = (tx, canView) => {
    if (!canView) return {};
    const executorProofImages = Array.isArray(tx.executorProofImages) ? tx.executorProofImages : [];
    return {
        executorExecutionNumber: tx.executorExecutionNumber || null,
        executorSenderPhone: tx.executorSenderPhone || null,
        executorProofCount: executorProofImages.length,
        executorProofImageUrls: executorProofImages.map((_, index) =>
            `/executor-portal/proxy/executor-image/${tx._id}/${index}`
        )
    };
};

const toClientReportDto = (data) => {
    const isPersonalReport = data.scope === 'employee';
    const isExternalPersonalReport = isPersonalReport && data.role === 'external';
    const canViewExecutorEvidence = data.role === 'manager';
    return {
        previousBalance: Number(data.previousBalance || 0),
        periodBalance: Number(data.periodBalance || 0),
        currentBalance: Number(data.currentBalance || data.companyBalance || 0),
        operationCount: Number(data.operationCount || (data.operations || []).length),
        totalLYD: Number(data.totalLYD || 0),
        operations: (data.operations || []).map((tx, index) => ({
            serialNumber: index + 1,
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
            executorReceivedAt: tx.executorReceivedAt ? new Date(tx.executorReceivedAt).toISOString() : null,
            completedAt: tx.completedAt ? new Date(tx.completedAt).toISOString() : null,
            executionDurationSeconds: tx.executorReceivedAt && tx.completedAt
                ? Math.max(0, Math.floor((new Date(tx.completedAt) - new Date(tx.executorReceivedAt)) / 1000))
                : null,
            notes: tx.notes || null,
            executorName: isPersonalReport ? null : (tx.executorName || null),
            executorRating: tx.executorRating || null,
            executorRatingNote: tx.executorRatingNote || null,
            executorRatedAt: tx.executorRatedAt ? new Date(tx.executorRatedAt).toISOString() : null,
            voiceNote: tx.voiceNote || null,
            executorSenderEntries: mapSenderEntries(tx),
            ...receiptFields(tx),
            ...managerExecutorEvidence(tx, canViewExecutorEvidence)
        })),
        pendingOperations: (data.pendingOperations || []).map((tx, index) => ({
            serialNumber: index + 1,
            id: String(tx._id),
            customId: tx.customId,
            transferType: tx.transferType,
            transferTypeLabel: getTransferServiceLabel(tx.transferType),
            recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
            recipientName: tx.accountName || null,
            amount: Number(tx.amount || 0),
            status: tx.status,
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
            executorReceivedAt: tx.executorReceivedAt ? new Date(tx.executorReceivedAt).toISOString() : null,
            completedAt: tx.completedAt ? new Date(tx.completedAt).toISOString() : null,
            executionDurationSeconds: tx.executorReceivedAt
                ? Math.max(0, Math.floor((Date.now() - new Date(tx.executorReceivedAt).getTime()) / 1000))
                : null,
            notes: tx.notes || null,
            executorName: isPersonalReport ? null : (tx.executorName || tx.assignedExecutorName || null),
            executorRating: tx.executorRating || null,
            executorRatingNote: tx.executorRatingNote || null,
            executorRatedAt: tx.executorRatedAt ? new Date(tx.executorRatedAt).toISOString() : null,
            voiceNote: tx.voiceNote || null,
            executorSenderEntries: mapSenderEntries(tx),
            ...receiptFields(tx),
            ...managerExecutorEvidence(tx, canViewExecutorEvidence)
        })),
        cancelledOperations: (data.cancelledOperations || []).map((tx, index) => ({
            serialNumber: index + 1,
            id: String(tx._id),
            customId: tx.customId,
            transferType: tx.transferType,
            transferTypeLabel: getTransferServiceLabel(tx.transferType),
            recipientNumber: tx.vodafoneNumber || tx.accountNumber || null,
            recipientName: tx.accountName || null,
            amount: Number(tx.amount || 0),
            status: tx.status,
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
            completedAt: tx.completedAt ? new Date(tx.completedAt).toISOString() : null,
            notes: tx.notes || null,
            executorName: isPersonalReport ? null : (tx.executorName || null),
            executorRating: tx.executorRating || null,
            executorRatingNote: tx.executorRatingNote || null,
            executorRatedAt: tx.executorRatedAt ? new Date(tx.executorRatedAt).toISOString() : null,
            voiceNote: tx.voiceNote || null,
            executorSenderEntries: mapSenderEntries(tx),
            ...receiptFields(tx),
            ...managerExecutorEvidence(tx, canViewExecutorEvidence)
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
            createdAt: tx.createdAt ? new Date(tx.createdAt).toISOString() : null,
            executorName: isPersonalReport ? null : (tx.executorName || null)
        })),
        totalEGP: Number(data.totalEGP || 0),
        completedCount: Number(data.completedCount || 0),
        rejectedCount: Number(data.rejectedCount || 0),
        totalDeposits: Number(data.totalDeposits || 0),
        summary: {
            totalEGP: Number(data.summary?.totalEGP || data.totalEGP || 0),
            completedCount: Number(data.summary?.completedCount || data.completedCount || 0),
            cancelledCount: Number(data.summary?.cancelledCount || data.rejectedCount || 0),
            pendingCount: Number(data.summary?.pendingCount || 0),
            averageDurationSeconds: data.summary?.averageDurationSeconds === null || data.summary?.averageDurationSeconds === undefined
                ? null
                : Number(data.summary.averageDurationSeconds),
            fastestDurationSeconds: data.summary?.fastestDurationSeconds === null || data.summary?.fastestDurationSeconds === undefined
                ? null
                : Number(data.summary.fastestDurationSeconds)
        },
        role: data.role || null,
        scope: data.scope || 'group',
        reportPeriod: data.reportPeriod ? {
            type: data.reportPeriod.type || 'day',
            value: data.reportPeriod.value || null,
            start: data.reportPeriod.start ? new Date(data.reportPeriod.start).toISOString() : null,
            end: data.reportPeriod.end ? new Date(data.reportPeriod.end).toISOString() : null
        } : null,
        company: !isPersonalReport && data.company ? {
            id: data.company.id ? String(data.company.id) : null,
            name: data.company.name || '---',
            serviceKey: data.company.serviceKey || null
        } : null,
        companyBalance: isPersonalReport || data.companyBalance === null || data.companyBalance === undefined
            ? null
            : Number(data.companyBalance),
        capabilities: {
            canViewCompanyBalance: !isPersonalReport && !!data.capabilities?.canViewCompanyBalance,
            canViewTeamPerformance: !isPersonalReport && !!data.capabilities?.canViewTeamPerformance,
            canViewReconciliation: isExternalPersonalReport || (!isPersonalReport && !!data.capabilities?.canViewReconciliation),
            canFilterEmployee: !!data.capabilities?.canFilterEmployee
        },
        financialSummary: (!isPersonalReport || isExternalPersonalReport) && data.financialSummary ? {
            openingBalance: Number(data.financialSummary.openingBalance || 0),
            additions: Number(data.financialSummary.additions || 0),
            deductions: Number(data.financialSummary.deductions || 0),
            executedAmount: Number(data.financialSummary.executedAmount || 0),
            netMovement: Number(data.financialSummary.netMovement || 0),
            closingBalance: Number(data.financialSummary.closingBalance || 0)
        } : null,
        teamPerformance: !isPersonalReport && Array.isArray(data.teamPerformance)
            ? data.teamPerformance.map(item => ({
                employeeId: item.employeeId ? String(item.employeeId) : null,
                employeeName: item.employeeName || '---',
                completedCount: Number(item.completedCount || 0),
                cancelledCount: Number(item.cancelledCount || 0),
                totalEGP: Number(item.totalEGP || 0),
                averageDurationSeconds: item.averageDurationSeconds === null || item.averageDurationSeconds === undefined
                    ? null
                    : Number(item.averageDurationSeconds)
            }))
            : [],
        myPerformance: !isPersonalReport && data.myPerformance ? {
            totalEGP: Number(data.myPerformance.totalEGP || 0),
            completedCount: Number(data.myPerformance.completedCount || 0)
        } : null,
        targetEmployee: data.targetEmployee ? {
            id: data.targetEmployee.id ? String(data.targetEmployee.id) : null,
            name: data.targetEmployee.name || '---',
            role: data.targetEmployee.role || null
        } : null,
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

const toExecutorTaskDto = (tx, currentExecutorId = null) => {
    const recipient = buildExecutorTaskRecipient(tx, currentExecutorId);
    return {
        id: tx._id ? String(tx._id) : null,
        txId: tx.customId || null,
        transferType: tx.transferType || null,
        transferTypeLabel: getTransferServiceLabel(tx.transferType),
        amount: Number(tx.amount || 0),
        ...recipient,
        recipientName: tx.accountName || null,
        status: tx.status || 'unknown',
        operatorId: tx.operatorId ? String(tx.operatorId) : null,
        acceptedByName: tx.status === 'accepted' ? (tx.executorName || null) : null,
        isOwnedByCurrentExecutor: recipient.recipientRevealed,
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
    const metrics = emp.metrics || {};
    const presence = emp.presence || {};
    const currentTask = emp.currentTask || null;
    return {
        id: String(emp._id),
        name: emp.name,
        phone: emp.phone || '',
        role: emp.role,
        status: emp.status,
        webUsername: emp.webUsername,
        canViewAllReports: !!emp.canViewAllReports,
        createdAt: emp.createdAt ? new Date(emp.createdAt).toISOString() : null,
        metrics: {
            completedCount: Number(metrics.completedCount || 0),
            cancelledCount: Number(metrics.cancelledCount || 0),
            pendingCount: Number(metrics.pendingCount || 0),
            totalEGP: Number(metrics.totalEGP || 0),
            averageDurationSeconds: metrics.averageDurationSeconds == null
                ? null
                : Number(metrics.averageDurationSeconds),
            successRate: metrics.successRate == null ? null : Number(metrics.successRate)
        },
        presence: {
            isOnline: !!presence.isOnline,
            lastSeenAt: presence.lastSeenAt ? new Date(presence.lastSeenAt).toISOString() : null,
            deviceName: presence.deviceName || '',
            pushReady: !!presence.pushReady,
            lastSuccessfulPushAt: presence.lastSuccessfulPushAt
                ? new Date(presence.lastSuccessfulPushAt).toISOString()
                : null
        },
        currentTask: currentTask ? {
            id: String(currentTask.id || ''),
            customId: currentTask.customId || '',
            status: currentTask.status || '',
            transferType: currentTask.transferType || '',
            recipient: currentTask.recipient || '',
            amount: Number(currentTask.amount || 0),
            receivedAt: currentTask.receivedAt ? new Date(currentTask.receivedAt).toISOString() : null
        } : null,
        ...(emp.role === 'external' ? { balance: Number(emp.balance || 0) } : {})
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
