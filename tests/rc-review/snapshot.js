'use strict';

const round = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return value === undefined || value === null ? null : value;
    return Math.round(number * 1000000) / 1000000;
};

const sortBy = (rows, fields) => rows.slice().sort((left, right) => {
    for (const field of fields) {
        const a = String(left[field] ?? '');
        const b = String(right[field] ?? '');
        if (a < b) return -1;
        if (a > b) return 1;
    }
    return 0;
});

const accountKey = (kind, doc) => {
    if (kind === 'user') return doc.phone || doc.webUsername || String(doc._id);
    if (kind === 'company') return doc.accountCode || doc.name || String(doc._id);
    if (kind === 'sub') return doc.webUsername || doc.accountCode || String(doc._id);
    if (kind === 'executor') return doc.name || String(doc._id);
    if (kind === 'employee') return doc.webUsername || String(doc._id);
    return String(doc._id);
};

const serviceBalancesOf = (doc) => {
    const raw = doc.serviceBalances;
    if (!raw) return null;
    const source = typeof raw.entries === 'function'
        ? Object.fromEntries(raw.entries())
        : (raw instanceof Map ? Object.fromEntries(raw.entries()) : raw);
    const normalized = {};
    Object.keys(source).sort().forEach((key) => {
        normalized[key] = round(source[key]);
    });
    return normalized;
};

const senderParts = (tx) => (Array.isArray(tx.executorSenderEntries) ? tx.executorSenderEntries : []).map((entry) => ({
    phone: entry.phone || null,
    amount: round(entry.amount)
}));

const senderPartMeta = (tx) => (Array.isArray(tx.executorSenderEntries) ? tx.executorSenderEntries : []).map((entry) => ({
    phone: entry.phone || null,
    amount: round(entry.amount),
    partId: entry.partId || null,
    status: entry.status || null,
    proofStatus: entry.customerProof && entry.customerProof.status ? entry.customerProof.status : null,
    proofKey: entry.customerProof && entry.customerProof.key ? entry.customerProof.key : null
}));

const stableTransactionId = (customId, tx) => {
    const text = String(customId || '');
    const prefix = text.match(/^(DEP|DED|SETTLE)-/);
    if (!prefix) return text;
    return `${prefix[1]}:${tx ? tx.status : ''}:${tx ? round(tx.amount) : ''}`;
};

const financialAudit = (log) => {
    const action = String(log.action || '');
    return /BALANCE|TRANSFER|DEPOSIT|DEDUCT|CANCEL|REFUND|REVERS|ROUTED|COMPLETED|LEDGER|SETTLE|ADJUST|VOID/i.test(action);
};

const stripVolatile = (value) => {
    if (Array.isArray(value)) return value.map(stripVolatile);
    if (!value || typeof value !== 'object') return value;
    if (value._bsontype === 'ObjectId' || typeof value.toHexString === 'function') return String(value);
    const out = {};
    Object.keys(value).sort().forEach((key) => {
        if (/At$|_id$|timestamp|createdAt|updatedAt|ipAddress|userAgent|sessionId|device|proof|receipt|partId|senderEntry|dedupe/i.test(key)) return;
        out[key] = stripVolatile(value[key]);
    });
    return out;
};

const takeSnapshot = async (models) => {
    const [users, companies, subs, executors, employees, ledgers, transactions, audits, journals] = await Promise.all([
        models.User.find({}).select('phone webUsername role balance accountCode').lean(),
        models.ClientCompany.find({}).select('name balance accountCode exchangeRate').lean(),
        models.SubAccount.find({}).select('webUsername name balance accountCode masterProfit').lean(),
        models.ExecutorGroup.find({}).select('name balance serviceBalances').lean(),
        models.Employee.find({}).select('webUsername balance').lean(),
        models.Ledger.find({}).select('entityId entityModel transactionId type amount balanceBefore balanceAfter description').lean(),
        models.Transaction.find({}).select('customId status amount costLYD commission exchangeRate subAccountCostLYD masterProfit subClientRate transferType agencyPricing executorSenderEntries manualExecutorReceiptReference proofImage proofImages apiResultData.completionClaimedAt apiResultData.completionMode apiResultData.waitingApiAutoCompletion').lean(),
        models.AuditLog.find({}).select('action oldData newData metadata performedByModel success').lean(),
        models.AgencyJournal ? models.AgencyJournal.find({}).select('transactionId eventType status pricing lines debitTotal creditTotal').lean() : []
    ]);

    const balances = [
        ...users.map((doc) => ({ kind: 'user', key: accountKey('user', doc), role: doc.role || null, balance: round(doc.balance) })),
        ...companies.map((doc) => ({ kind: 'company', key: accountKey('company', doc), balance: round(doc.balance) })),
        ...subs.map((doc) => ({ kind: 'sub', key: accountKey('sub', doc), balance: round(doc.balance) })),
        ...executors.map((doc) => ({
            kind: 'executor',
            key: accountKey('executor', doc),
            balance: round(doc.balance),
            serviceBalances: serviceBalancesOf(doc)
        })),
        ...employees.map((doc) => ({ kind: 'employee', key: accountKey('employee', doc), balance: round(doc.balance) }))
    ];

    const idMap = new Map(transactions.map((tx) => [tx.customId, stableTransactionId(tx.customId, tx)]));
    const mappedId = (value) => idMap.get(value) || stableTransactionId(value);

    const ledgerRows = ledgers.map((row) => ({
        entityModel: row.entityModel,
        transactionId: mappedId(row.transactionId),
        type: row.type,
        amount: round(row.amount),
        balanceBefore: round(row.balanceBefore),
        balanceAfter: round(row.balanceAfter),
        description: row.description || ''
    }));

    const txs = transactions.map((tx) => ({
        customId: mappedId(tx.customId),
        status: tx.status,
        transferType: tx.transferType || null,
        amount: round(tx.amount),
        costLYD: round(tx.costLYD),
        commission: round(tx.commission),
        exchangeRate: round(tx.exchangeRate),
        subAccountCostLYD: round(tx.subAccountCostLYD),
        masterProfit: round(tx.masterProfit),
        subClientRate: round(tx.subClientRate),
        agencyProfitLYD: round(tx.agencyPricing && tx.agencyPricing.profitLYD),
        agencyAgentCostLYD: round(tx.agencyPricing && tx.agencyPricing.agentCostLYD),
        agencyCustomerChargeLYD: round(tx.agencyPricing && tx.agencyPricing.customerChargeLYD),
        senderParts: senderParts(tx)
    }));

    const nonFinancialTransactions = transactions.map((tx) => ({
        customId: mappedId(tx.customId),
        manualExecutorReceiptReference: tx.manualExecutorReceiptReference || null,
        proofCount: Array.isArray(tx.proofImages) ? tx.proofImages.length : 0,
        completionClaimedAt: Boolean(tx.apiResultData && tx.apiResultData.completionClaimedAt),
        completionMode: tx.apiResultData && tx.apiResultData.completionMode ? tx.apiResultData.completionMode : null,
        senderParts: senderPartMeta(tx)
    }));

    const auditRows = audits.filter(financialAudit).map((log) => ({
        action: log.action,
        performedByModel: log.performedByModel || null,
        success: log.success !== false,
        oldData: stripVolatile(log.oldData || null),
        newData: stripVolatile(log.newData || null),
        metadata: stripVolatile({
            ...(log.metadata || {}),
            transactionId: mappedId(log.metadata && log.metadata.transactionId)
        })
    }));

    const journalRows = (journals || []).map((row) => ({
        transactionId: mappedId(row.transactionId),
        eventType: row.eventType,
        status: row.status,
        debitTotal: round(row.debitTotal),
        creditTotal: round(row.creditTotal),
        profitLYD: round(row.pricing && row.pricing.profitLYD),
        agentCostLYD: round(row.pricing && row.pricing.agentCostLYD),
        customerChargeLYD: round(row.pricing && row.pricing.customerChargeLYD),
        lines: (row.lines || []).map((line) => ({
            accountCode: line.accountCode,
            side: line.side,
            amount: round(line.amount),
            entityModel: line.entityModel || null
        }))
    }));

    return {
        financial: {
            balances: sortBy(balances, ['kind', 'key']),
            ledgers: sortBy(ledgerRows, ['transactionId', 'entityModel', 'type', 'amount', 'description']),
            transactions: sortBy(txs, ['customId']),
            audits: sortBy(auditRows, ['action', 'performedByModel']).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            journals: sortBy(journalRows, ['transactionId', 'eventType'])
        },
        nonFinancial: {
            transactions: sortBy(nonFinancialTransactions, ['customId'])
        }
    };
};

const summarize = (snapshot) => {
    const financial = snapshot.financial || snapshot;
    const ledgerByType = {};
    (financial.ledgers || []).forEach((row) => {
        const key = row.type;
        if (!ledgerByType[key]) ledgerByType[key] = { count: 0, amount: 0 };
        ledgerByType[key].count += 1;
        ledgerByType[key].amount = round(ledgerByType[key].amount + Number(row.amount || 0));
    });
    return {
        balances: financial.balances,
        ledgerByType,
        ledgerCount: financial.ledgers.length,
        transactions: financial.transactions.map((tx) => ({
            customId: tx.customId,
            status: tx.status,
            amount: tx.amount,
            costLYD: tx.costLYD,
            commission: tx.commission,
            exchangeRate: tx.exchangeRate,
            masterProfit: tx.masterProfit,
            subAccountCostLYD: tx.subAccountCostLYD
        })),
        journalCount: financial.journals.length,
        auditCount: financial.audits.length
    };
};

module.exports = { takeSnapshot, summarize, round };
