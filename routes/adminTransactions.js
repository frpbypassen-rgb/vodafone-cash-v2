const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const https = require('https');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const { createBalanceTransferReceiptProof } = require('../services/balanceTransferReceiptService');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middlewares/auth');
const { systemDateKey, systemDateRange } = require('../config/systemTime');
const { syncBotBalance } = require('../utils/helpers');
const { escapeRegex } = require('../middlewares/sanitize');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');
const { sanitizeStatementTransaction } = require('../utils/accountStatementPrivacy');
const { logAction } = require('../services/auditService');
const {
    executorSupportsTransferType,
    getExecutorServiceLabel,
    getExecutorSupportedTransferTypes,
    normalizeExecutorServiceKey
} = require('../utils/executorServiceCatalog');
const {
    repriceTransaction,
    editTransactionAmount,
    reassignTransactionExecutor
} = require('../services/adminFinancialMutationService');
const eventBus = require('../services/eventBus');
const { adminVisibleTransactionQuery, applyAdminTxPrivacy } = require('../services/adminAccountVisibilityService');
const { adminAccountScope, tenantScope } = require('../utils/tenantScope');
const {
    emptyPeriodStats,
    loadCentralLedgerOverview
} = require('../services/centralLedgerOverviewService');
const {
    sortTransactionsByStatusQueue,
    transactionStatusQueuePipelineStages
} = require('../utils/transactionStatusQueue');

// 🚀 استدعاء محرك الـ API 
const { getApiProviderBalance } = require('../services/externalApiService');
const { reversalService } = require('../src/Application/Services/ReversalService');

router.use(requireAuth);

const getParentGroupId = (group) => group?.parentGroupId || group?.parentBotId || null;

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const appendAdminNote = (tx, note) => {
    tx.adminNotes = appendNoteText(tx.adminNotes, note);
};

const enqueueApiExecutorTransfer = async (txId, apiGroupId) => {
    try {
        const { addTransferJob } = require('../services/bullQueueService');
        await addTransferJob(String(txId), String(apiGroupId));
        return true;
    } catch (queueError) {
        console.error('[adminTransactions/assign-executor] API queue failed:', queueError.message);
        try {
            const queueService = require('../services/queueService');
            await queueService.addJob(String(txId), String(apiGroupId));
            return true;
        } catch (fallbackError) {
            console.error('[adminTransactions/assign-executor] API in-memory queue failed:', fallbackError.message);
            return false;
        }
    }
};

const reportAuditMetadata = (tx, extra = {}) => ({
    transactionId: tx?.customId,
    originalCreatedAt: tx?.createdAt,
    companyId: tx?.companyId ? String(tx.companyId) : '',
    userId: tx?.userId ? String(tx.userId) : '',
    subAccountId: tx?.subAccountId ? String(tx.subAccountId) : '',
    executorGroupId: tx?.executorGroupId ? String(tx.executorGroupId) : '',
    employeeName: tx?.employeeName || '',
    executorName: tx?.executorName || '',
    ...extra
});

const logAdminFinancialChange = (req, action, tx, oldData, newData, metadata = {}) => logAction({
    action,
    req,
    performedById: req.session.adminId,
    performedByModel: 'Admin',
    performedByName: req.session.adminName || 'الإدارة',
    targetId: tx?._id,
    targetModel: 'Transaction',
    oldData,
    newData,
    metadata: reportAuditMetadata(tx, metadata),
    required: true,
    severity: 'critical'
});

const isAsyncTransactionRequest = (req) => (
    req.get('x-requested-with') === 'XMLHttpRequest'
    || String(req.get('accept') || '').includes('application/json')
);

const respondTransactionAction = (req, res, status, payload, redirectUrl = '/transactions') => {
    if (isAsyncTransactionRequest(req)) return res.status(status).json(payload);
    return res.redirect(redirectUrl);
};

// Task delivery is an asynchronous side effect. A broken mobile push provider
// must never roll back, or falsely report failure for, an already persisted
// executor assignment.
const publishExecutorTaskAvailable = (tx, source) => {
    try {
        eventBus.publish('executor:task-available', { tx, source });
    } catch (error) {
        console.error('[adminTransactions/assign-executor] task notification failed:', error.stack || error.message);
    }
};

const customerFacingNotes = (notes) => {
    const raw = String(notes || '').trim();
    if (!raw) return '';
    const apiSplit = raw.split(/---\s*سجل\s+الـ\s+API/i)[0].trim();
    const legacyBalanceTransferNote = apiSplit.match(/(?:تحويل رصيد صادر إلى|تحويل رصيد وارد من).*\|\s*(.+)$/);
    if (legacyBalanceTransferNote) return legacyBalanceTransferNote[1].trim();
    const lines = apiSplit.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const systemPatterns = [
        /^سبب الرفض:/,
        /^\[تم /,
        /^\[فشل /,
        /^\[معلقة /,
        /^\[رقم الإلغاء:/,
        /^تحويل رصيد صادر إلى/,
        /^تحويل رصيد وارد من/,
        /^تمويل نقطة بيع/,
        /^سحب رصيد من نقطة بيع/,
        /^\[طلب وارد عبر API/
    ];
    return lines.filter((line) => {
        if (/رقم المرسل|الرقم المرجعي|مرجع|reference|ref/i.test(line)) return true;
        return !systemPatterns.some((pattern) => pattern.test(line));
    }).join('\n').trim();
};

const OPERATION_STATUSES = ['pending', 'processing', 'accepted', 'completed', 'rejected', 'cancelled_by_admin'];

const adminTxById = (req, id) => adminVisibleTransactionQuery(adminAccountScope(req), { _id: id });

const transactionLedgerBaseQuery = (source = null) => ({
    ...adminAccountScope(source),
    isSubAccountTx: { $ne: true },
    $and: [
        {
            $or: [
                { transferType: { $ne: 'balance_transfer' } },
                { customId: { $not: /-C$/ } }
            ]
        }
    ]
});

const monthDateRange = (dateKey) => {
    const [year, month] = String(dateKey || '').split('-').map(Number);
    if (!year || !month) return null;
    const lastDay = String(new Date(year, month, 0).getDate()).padStart(2, '0');
    return systemDateRange(`${year}-${String(month).padStart(2, '0')}-01`, `${year}-${String(month).padStart(2, '0')}-${lastDay}`);
};

const transactionSearchMatchReason = (transaction, rawSearch, exactAmount) => {
    const needle = String(rawSearch || '').trim().toLocaleLowerCase();
    const contains = (value) => String(value || '').toLocaleLowerCase().includes(needle);
    if (contains(transaction.customId)) return 'تطابق رقم العملية';
    if (contains(transaction.cancellationNumber)) return 'تطابق رقم الإلغاء';
    if (contains(transaction.settlementDetails?.externalReference)) return 'تطابق رقم الإيداع أو المرجع';
    if (contains(transaction.vodafoneNumber) || contains(transaction.serviceDetails?.clientPhone)) return 'تطابق هاتف المستلم';
    if (contains(transaction.accountNumber)) return 'تطابق رقم الحساب';
    if (contains(transaction.companyName) || contains(transaction.employeeName) || contains(transaction.accountName)) return 'تطابق اسم العميل';
    if (contains(transaction.executorName) || contains(transaction.executorGroupName)) return 'تطابق المنفذ';
    if (Number.isFinite(exactAmount) && Number(transaction.amount) === exactAmount) return 'تطابق مبلغ دقيق';
    return 'تطابق ضمن بيانات العملية';
};

const renderTransactionSearch = async (req, res) => {
    try {
        const search = String(req.query.q || '').trim();
        const mode = ['day', 'month', 'range'].includes(req.query.mode) ? req.query.mode : 'day';
        const todayKey = systemDateKey(new Date());
        const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayKey;
        const selectedMonth = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayKey.slice(0, 7);
        const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fromDate || '') ? req.query.fromDate : '';
        const toDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.toDate || '') ? req.query.toDate : '';
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = 50;
        const query = transactionLedgerBaseQuery(req);
        const range = mode === 'day'
            ? systemDateRange(selectedDate, selectedDate)
            : mode === 'month'
                ? monthDateRange(`${selectedMonth}-01`)
                : systemDateRange(fromDate, toDate);
        if (range) query.createdAt = range;

        if (search) {
            const safeSearch = escapeRegex(search);
            const criteria = [
                { customId: { $regex: safeSearch, $options: 'i' } },
                { cancellationNumber: { $regex: safeSearch, $options: 'i' } },
                { 'settlementDetails.externalReference': { $regex: safeSearch, $options: 'i' } },
                { vodafoneNumber: { $regex: safeSearch, $options: 'i' } },
                { accountNumber: { $regex: safeSearch, $options: 'i' } },
                { 'serviceDetails.clientPhone': { $regex: safeSearch, $options: 'i' } },
                { companyName: { $regex: safeSearch, $options: 'i' } },
                { employeeName: { $regex: safeSearch, $options: 'i' } },
                { accountName: { $regex: safeSearch, $options: 'i' } },
                { executorName: { $regex: safeSearch, $options: 'i' } },
                { executorGroupName: { $regex: safeSearch, $options: 'i' } }
            ];
            const amount = Number(search.replace(/,/g, ''));
            if (Number.isFinite(amount) && search !== '') criteria.push({ amount });
            query.$and.push({ $or: criteria });
        }

        const [total, rawResults] = search
            ? await Promise.all([
                Transaction.countDocuments(query),
                Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
            ])
            : [0, []];
        const exactAmount = Number(search.replace(/,/g, ''));
        const results = rawResults.map((transaction) => ({
            ...transaction,
            matchReason: transactionSearchMatchReason(transaction, search, exactAmount)
        }));
        res.render('transaction_search', {
            activePage: 'transactions_search',
            adminName: req.session.adminName,
            filters: { search, mode, selectedDate, selectedMonth, fromDate, toDate },
            results,
            pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
        });
    } catch (error) {
        console.error('[adminTransactions/search] error:', error.message);
        res.status(500).send('تعذر تنفيذ البحث الشامل');
    }
};

router.get('/transactions/search', renderTransactionSearch);
router.get('/transactions/movements', (req, res) => {
    const params = new URLSearchParams(req.query);
    params.set('source', 'transactions');
    return res.redirect(`/financial-movements?${params.toString()}`);
});


const renderTransactions = async (req, res, operationsWorkspace = false) => {
    try {
        const backgroundRefresh = req.get('X-Requested-With') === 'XMLHttpRequest';
        // أرصدة الـ API لا تُستعلم إلا عند فتح شاشة العمليات أو بطلب يدوي صريح.
        // التحديث الخلفي للجدول يعيد استخدام آخر رصيد محفوظ ولا يضغط على مزود الخدمة.
        const shouldRefreshApiBalances = operationsWorkspace
            && !backgroundRefresh
            && req.query.refreshBalances !== '0';
        const page = parseInt(req.query.page) || 1;
        const limit = 100;
        const search = req.query.search || '';
        const statusFilter = req.query.status || '';
        const executorId = /^[a-f\d]{24}$/i.test(String(req.query.executorId || ''))
            ? String(req.query.executorId)
            : '';
        let fromDate = req.query.fromDate;
        let toDate = req.query.toDate;
        const filterType = req.query.filterType || '';

        // Default to the current full month if fromDate and toDate are not specified.
        if (fromDate === undefined && toDate === undefined) {
            const today = new Date();
            const year = today.getFullYear();
            const monthNumber = today.getMonth() + 1;
            const month = String(monthNumber).padStart(2, '0');
            const lastDay = String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0');
            fromDate = `${year}-${month}-01`;
            toDate = `${year}-${month}-${lastDay}`;
        } else {
            fromDate = fromDate || '';
            toDate = toDate || '';
        }

        let query = transactionLedgerBaseQuery(req);

        // ✅ NoSQL Regex Injection — تعقيم مصطلح البحث
        if (search) {
            const safeSearch = escapeRegex(search);
            query.$and.push({
                $or: [
                    { customId: { $regex: safeSearch, $options: 'i' } },
                    { vodafoneNumber: { $regex: safeSearch, $options: 'i' } },
                    { accountNumber: { $regex: safeSearch, $options: 'i' } },
                    { companyName: { $regex: safeSearch, $options: 'i' } },
                    { employeeName: { $regex: safeSearch, $options: 'i' } }
                ]
            });
        }
        if (statusFilter && (!operationsWorkspace || OPERATION_STATUSES.includes(statusFilter))) query.status = statusFilter;
        else if (operationsWorkspace) query.status = { $in: OPERATION_STATUSES };
        if (operationsWorkspace && executorId) query.executorGroupId = new mongoose.Types.ObjectId(executorId);
        if (fromDate || toDate) {
            const createdAt = systemDateRange(fromDate, toDate);
            if (createdAt) query.createdAt = createdAt;
        }

        // Apply quick category filters
        if (!operationsWorkspace && filterType === 'deposit_deduction') {
            query.transferType = { $ne: 'balance_transfer' };
            query.status = { $in: ['deposit', 'deduction', 'deposit_pending'] };
        } else if (!operationsWorkspace && filterType === 'balance_transfer') {
            query.transferType = 'balance_transfer';
        } else if (!operationsWorkspace && filterType === 'cash_transfer') {
            query.transferType = { $in: ['vodafone', 'post_account', 'post_card'] };
            query.status = { $nin: ['deposit', 'deduction', 'deposit_pending'] };
        } else if ((!operationsWorkspace || filterType === 'cancelled') && filterType === 'cancelled') {
            query.status = { $in: ['cancelled_by_admin', 'rejected'] };
        }

        const totalTxs = await Transaction.countDocuments(query);
        const totalPages = Math.ceil(totalTxs / limit);
        const transactions = sortTransactionsByStatusQueue(
            await Transaction.aggregate([
                { $match: query },
                ...transactionStatusQueuePipelineStages({
                    skip: (page - 1) * limit,
                    limit
                })
            ])
        );

        // هذا الملخص مستقل عن فلاتر السجل: يعرض حركة اليوم دائماً.
        // نستبعد الطرف المقابل لتحويل الرصيد حتى لا تُحسب العملية الداخلية مرتين.
        const dailyTotals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        let periodStats = emptyPeriodStats();
        let activeClientCompanies = [];
        let fundedExecutorCompanies = [];

        const todayKey = systemDateKey(new Date());
        const todayRange = systemDateRange(todayKey, todayKey);
        const executorBalanceQuery = {
            ...adminAccountScope(req),
            status: 'active',
            isManagerBot: { $ne: true },
            $or: [{ balance: { $gt: 0 } }, { isApiBot: true }]
        };
        const [ledgerOverview, dailyTotalsAgg, executorGroups, executorBalanceCandidates] = await Promise.all([
            operationsWorkspace
                ? Promise.resolve(null)
                : loadCentralLedgerOverview({ Transaction, ClientCompany, ExecutorGroup, source: req }),
            operationsWorkspace
                ? Transaction.aggregate([
                    { $match: {
                        ...tenantScope(req),
                        $and: [
                            {
                                $or: [
                                    { transferType: { $ne: 'balance_transfer' } },
                                    { customId: { $not: /-C$/ } }
                                ]
                            }
                        ],
                        ...(todayRange ? { createdAt: todayRange } : {})
                    } },
                    { $group: {
                        _id: '$status',
                        totalAmount: { $sum: '$amount' },
                        totalCostLYD: { $sum: '$costLYD' }
                    }}
                ])
                : Promise.resolve([]),
            ExecutorGroup.find({ ...adminAccountScope(req), status: 'active', isManagerBot: { $ne: true } }),
            operationsWorkspace
                // منفذ API قد يكون رصيده الداخلي سالباً رغم وجود رصيد خدمة فعلي عند المزود.
                ? ExecutorGroup.find(executorBalanceQuery).select('name balance isApiBot updatedAt lastApiBalanceCheckAt lastApiServiceCredit apiProviderKey apiUrl apiToken apiUsername apiPassword apiServiceId apiProviderId apiFieldId apiMachineSerial').lean()
                : Promise.resolve([])
        ]);
        if (ledgerOverview) {
            periodStats = ledgerOverview.periodStats;
            activeClientCompanies = ledgerOverview.activeClientCompanies;
            fundedExecutorCompanies = ledgerOverview.fundedExecutorCompanies;
        }
        dailyTotalsAgg.forEach(row => {
            if (row._id === 'completed') { dailyTotals.transfersEGP = row.totalAmount; dailyTotals.transfersLYD = row.totalCostLYD; }
            else if (row._id === 'deposit') { dailyTotals.depositsEGP = row.totalAmount; }
            else if (row._id === 'deduction') { dailyTotals.deductionsEGP = row.totalAmount; }
        });
        const executorBalanceGroups = (await Promise.all(executorBalanceCandidates.map(async (group) => {
            if (!group.isApiBot) {
                return {
                    id: String(group._id),
                    name: group.name,
                    balance: Number(group.balance),
                    balanceSource: 'internal',
                    checkedAt: group.updatedAt || null
                };
            }

            if (!shouldRefreshApiBalances) {
                if (Number(group.lastApiServiceCredit) <= 0) return null;
                return {
                    id: String(group._id),
                    name: group.name,
                    balance: Number(group.lastApiServiceCredit),
                    balanceSource: 'api_service',
                    checkedAt: group.lastApiBalanceCheckAt || group.updatedAt || null
                };
            }
            try {
                const providerBalance = await getApiProviderBalance(group);
                if (!providerBalance.success || Number(providerBalance.serviceCredit) <= 0) return null;

                const checkedAt = new Date();
                await ExecutorGroup.updateOne({ _id: group._id }, {
                    $set: {
                        lastApiBalanceCheckAt: checkedAt,
                        lastApiBalanceCheckStatus: 'matched',
                        lastApiServiceCredit: providerBalance.serviceCredit,
                        lastApiCashCredit: providerBalance.cashCredit,
                        lastApiAvailableBalance: providerBalance.availableBalance
                    }
                });
                return {
                    id: String(group._id),
                    name: group.name,
                    balance: Number(providerBalance.serviceCredit),
                    balanceSource: 'api_service',
                    checkedAt
                };
            } catch (error) {
                console.error('[adminTransactions/API balance] failed:', error.message);
                return null;
            }
        }))).filter(Boolean).sort((left, right) => right.balance - left.balance || left.name.localeCompare(right.name, 'ar'));
        const executorGroupsForView = executorGroups.map((group) => ({
            ...(typeof group.toObject === 'function' ? group.toObject() : group),
            serviceKey: normalizeExecutorServiceKey(group.serviceKey),
            serviceLabel: getExecutorServiceLabel(group),
            supportedTransferTypes: getExecutorSupportedTransferTypes(group)
        }));
        const allGroups = await ExecutorGroup.find(adminAccountScope(req)).lean();
        const allGroupsMap = {};
        allGroups.forEach((group) => {
            allGroupsMap[group._id.toString()] = group.name;
        });
        const executorDisplayByTransaction = {};
        transactions.forEach((tx) => {
            const executorGroupId = tx.executorGroupId ? String(tx.executorGroupId) : '';
            const managerGroupId = tx.managerGroupId ? String(tx.managerGroupId) : '';
            const executorGroup = executorGroupId
                ? allGroups.find((group) => String(group._id) === executorGroupId)
                : null;
            const parentGroupId = executorGroup
                ? String(executorGroup.parentGroupId || executorGroup.parentBotId || '')
                : '';
            const companyName = allGroupsMap[managerGroupId]
                || allGroupsMap[parentGroupId]
                || (executorGroup ? executorGroup.name : '')
                || '';
            const executorName = tx.executorName
                || (executorGroup ? executorGroup.name : '')
                || '';
            executorDisplayByTransaction[String(tx._id)] = { companyName, executorName };
        });

        res.render('transactions', { 
            transactions, 
            executorGroups: executorGroupsForView,
            executorBots: executorGroupsForView,
            allGroupsMap, 
            allBotsMap: allGroupsMap, 
            executorDisplayByTransaction,
            currentPage: page, 
            totalPages, 
            search, 
            statusFilter, 
            fromDate, 
            toDate, 
            filterType,
            dailyTotals,
            periodStats,
            activeClientCompanies,
            fundedExecutorCompanies,
            executorBalanceGroups,
            executorId,
            operationWorkspace: operationsWorkspace,
            query: req.query
        });
    } catch (e) {
        console.error('[adminTransactions/GET transactions] خطأ:', e.message);
        res.status(500).send('خطأ داخلي');
    }
};

router.get('/transactions', (req, res) => renderTransactions(req, res, false));
router.get('/transactions/operations', (req, res) => renderTransactions(req, res, true));

router.get('/transactions/print', async (req, res) => {
    try {
        const search = req.query.search || '';
        const statusFilter = req.query.status || '';
        let fromDate = req.query.fromDate;
        let toDate = req.query.toDate;
        const filterType = req.query.filterType || '';

        // Default to the current full month if fromDate and toDate are not specified.
        if (fromDate === undefined && toDate === undefined) {
            const today = new Date();
            const year = today.getFullYear();
            const monthNumber = today.getMonth() + 1;
            const month = String(monthNumber).padStart(2, '0');
            const lastDay = String(new Date(year, monthNumber, 0).getDate()).padStart(2, '0');
            fromDate = `${year}-${month}-01`;
            toDate = `${year}-${month}-${lastDay}`;
        } else {
            fromDate = fromDate || '';
            toDate = toDate || '';
        }

        let query = {
            isSubAccountTx: { $ne: true },
            $and: [
                {
                    $or: [
                        { transferType: { $ne: 'balance_transfer' } },
                        { customId: { $not: /-C$/ } }
                    ]
                }
            ]
        };

        // ✅ NoSQL Regex Injection
        if (search) {
            const safeSearch = escapeRegex(search);
            query.$and.push({
                $or: [
                    { customId: { $regex: safeSearch, $options: 'i' } },
                    { vodafoneNumber: { $regex: safeSearch, $options: 'i' } },
                    { companyName: { $regex: safeSearch, $options: 'i' } },
                    { employeeName: { $regex: safeSearch, $options: 'i' } }
                ]
            });
        }
        if (statusFilter) query.status = statusFilter;
        if (fromDate || toDate) {
            const createdAt = systemDateRange(fromDate, toDate);
            if (createdAt) query.createdAt = createdAt;
        }

        // Apply quick category filters
        if (filterType === 'deposit_deduction') {
            query.transferType = { $ne: 'balance_transfer' };
            query.status = { $in: ['deposit', 'deduction', 'deposit_pending'] };
        } else if (filterType === 'balance_transfer') {
            query.transferType = 'balance_transfer';
        } else if (filterType === 'cash_transfer') {
            query.transferType = { $in: ['vodafone', 'post_account', 'post_card'] };
            query.status = { $nin: ['deposit', 'deduction', 'deposit_pending'] };
        } else if (filterType === 'cancelled') {
            query.status = { $in: ['cancelled_by_admin', 'rejected'] };
        }

        const transactions = await Transaction.find(query).sort({ createdAt: -1 });
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        transactions.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); }
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); }
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        res.render('print_report', {
            transactions: transactions.map(sanitizeStatementTransaction),
            fromDate,
            toDate,
            filterType,
            totals
        });
    } catch (e) {
        console.error('[adminTransactions/print] خطأ:', e.message);
        res.status(500).send('حدث خطأ أثناء إعداد التقرير.');
    }
});

router.post('/transaction/:id/assign-executor', async (req, res) => {
    try {
        const txId = req.params.id; const executorGroupId = req.body.executorGroupId || req.body.executorBotId; const tx = await Transaction.findOne(adminTxById(req, txId));
        if (!tx || tx.status !== 'pending') {
            return respondTransactionAction(req, res, 409, {
                success: false,
                message: 'هذه العملية لم تعد متاحة للتوجيه.'
            });
        }

        const executorGroup = await ExecutorGroup.findOne({ _id: executorGroupId, ...adminAccountScope(req) });

        if (
            executorGroup
            && executorGroup.status === 'active'
            && !executorGroup.isManagerBot
            && executorSupportsTransferType(executorGroup, tx.transferType)
        ) {
            const assignment = {
                status: 'processing',
                executorGroupId: executorGroup._id,
                managerGroupId: getParentGroupId(executorGroup),
                executorReceivedAt: new Date(),
                executorName: executorGroup.name,
                updatedAt: new Date()
            };
            // Use MongoDB's native atomic update. This deliberately bypasses
            // Mongoose document validation for legacy transactions whose old
            // fields no longer match the current schema.
            const updateResult = await Transaction.collection.updateOne(
                { _id: tx._id, status: 'pending' },
                { $set: assignment },
            );
            if (!updateResult.acknowledged || updateResult.modifiedCount !== 1) {
                return respondTransactionAction(req, res, 409, {
                    success: false,
                    message: 'تم تحديث العملية بواسطة مستخدم آخر، حدّث القائمة وحاول مرة أخرى.'
                });
            }
            const routedTx = { ...tx.toObject(), ...assignment };
            
            // 🤖====================================================🤖
            // 🚀 المسار الذكي: إذا كان هذا البوت آلياً (API Integration)
            // 🤖====================================================🤖
            if (executorGroup.isApiBot) {
                publishExecutorTaskAvailable(routedTx, 'admin-api-route');

                // Persist routing first, then dispatch. Queueing must never
                // make the administrator see a failed routing action, but the
                // job MUST still reach the in-process worker if Redis/BullMQ
                // is not actually consuming jobs.
                await enqueueApiExecutorTransfer(routedTx._id, executorGroup._id);
                return respondTransactionAction(req, res, 200, {
                    success: true,
                    message: 'تم توجيه العملية إلى منفذ API.',
                    transaction: { id: String(routedTx._id), status: routedTx.status, executorName: routedTx.executorName }
                });
            }

            // 👨‍💻====================================================👨‍💻
            // المسار الكلاسيكي: للبوت البشري العادي
            // 👨‍💻====================================================👨‍💻
            // 🟢 الإشعارات ستكون عبر Socket.IO
            publishExecutorTaskAvailable(routedTx, 'admin-manual-route');
            return respondTransactionAction(req, res, 200, {
                success: true,
                message: 'تم توجيه العملية إلى المنفذ.',
                transaction: { id: String(routedTx._id), status: routedTx.status, executorName: routedTx.executorName }
            });
        } else if (executorGroup) {
            return respondTransactionAction(req, res, 422, {
                success: false,
                message: 'خدمة المنفذ لا تطابق نوع العملية.'
            }, '/transactions?routeError=service_mismatch');
        }
        return respondTransactionAction(req, res, 404, {
            success: false,
            message: 'المنفذ المحدد غير موجود أو غير نشط.'
        });
    } catch (e) {
        const errorId = `assign-${Date.now()}`;
        console.error('[adminTransactions/assign-executor] failed:', {
            errorId,
            transactionId: req.params.id,
            executorGroupId: req.body?.executorGroupId || req.body?.executorBotId,
            error: e.stack || e.message
        });
        return respondTransactionAction(req, res, 500, {
            success: false,
            code: 'EXECUTOR_ASSIGN_FAILED',
            errorId,
            message: `تعذر توجيه العملية حالياً. رمز المتابعة: ${errorId}`
        });
    }
});

router.post('/transaction/:id/pull-task', async (req, res) => {
    try {
        const tx = await Transaction.findOne(adminTxById(req, req.params.id));
        if (!tx || !['processing', 'accepted'].includes(tx.status)) {
            return respondTransactionAction(req, res, 409, {
                success: false,
                message: 'هذه العملية ليست موجهة حالياً ولا يمكن سحبها.'
            });
        }
        const oldGroupId = tx.executorGroupId; const displayId = tx.customId || tx._id.toString();

        tx.status = 'pending'; tx.executorGroupId = undefined; tx.managerGroupId = undefined; tx.executorName = undefined; tx.operatorId = undefined; tx.assignedExecutorId = undefined; tx.assignedExecutorName = undefined; tx.assignedExecutorAt = undefined; tx.broadcastMessages = []; tx.adminMessages = []; tx.emergencyAlert = undefined;

        // 🟢 إشعارات الانسحاب عبر Socket.IO

        await tx.save();
        eventBus.publish('executor:task-withdrawn', {
            tx: { ...tx.toObject(), executorGroupId: oldGroupId },
            source: 'admin-pull'
        });
        return respondTransactionAction(req, res, 200, {
            success: true,
            message: `تم سحب العملية ${displayId} إلى الإدارة.`,
            transaction: { id: String(tx._id), status: tx.status }
        });
    } catch (e) {
        console.error('[adminTransactions/pull-task] failed:', e.message);
        return respondTransactionAction(req, res, 500, { success: false, message: 'تعذر سحب العملية حالياً.' });
    }
});

router.post('/transaction/:id/emergency-alert', async (req, res) => {
    try {
        const tx = await Transaction.findOne(adminTxById(req, req.params.id));
        if (!tx || !['processing', 'accepted'].includes(tx.status)) { return res.redirect('/transactions'); }
        const alertMsg = req.body.alertMessage || `تنبيه عاجل من الإدارة للطلب رقم ${tx.customId || tx._id}! يرجى سرعة التنفيذ!`;
        await Transaction.updateOne({ _id: tx._id }, { $set: { emergencyAlert: alertMsg } }, { strict: false });
        tx.emergencyAlert = alertMsg;
        tx.updatedAt = new Date();
        eventBus.publish('executor:urgent-alert', { tx, message: alertMsg, source: 'admin' });

        // 🟢 الإشعارات عبر Socket.IO

        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/accept-deposit-web', async (req, res) => {
    try {
        const tx = await Transaction.findOne(adminTxById(req, req.params.id));
        if (!tx || tx.status !== 'deposit_pending') return res.json({ success: false, error: 'الطلب غير متاح' });

        if (tx.depositRequest?.submittedByRole === 'client' && tx.depositRequest?.supportTicketId) {
            const { resolveClientDepositTicket } = require('../services/clientDepositRequestService');
            await resolveClientDepositTicket({
                ticketId: String(tx.depositRequest.supportTicketId),
                admin: { id: req.session.adminId || req.session.adminUsername || 'admin', name: req.session.adminName || 'الإدارة' },
                approved: true
            });
            return res.json({ success: true });
        }

        let fileId = `deposit_${Date.now()}.jpg`;
        tx.status = 'deposit'; tx.proofImage = fileId; tx.updatedAt = new Date();
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع بقيمة ${tx.amount} EGP وتمت إضافة الرصيد لحسابك بنجاح.`, imageUrl: `/proxy/image/${tx._id}/0` } } }, { strict: false });
        await tx.save(); if (tx.executorGroupId) await syncBotBalance(tx.executorGroupId);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/transaction/:id/reject-deposit-web', async (req, res) => {
    try {
        const { reason } = req.body; const tx = await Transaction.findOne(adminTxById(req, req.params.id));
        if (!tx || tx.status !== 'deposit_pending') return res.redirect('/transactions');

        if (tx.depositRequest?.submittedByRole === 'client' && tx.depositRequest?.supportTicketId) {
            const { resolveClientDepositTicket } = require('../services/clientDepositRequestService');
            await resolveClientDepositTicket({
                ticketId: String(tx.depositRequest.supportTicketId),
                admin: { id: req.session.adminId || req.session.adminUsername || 'admin', name: req.session.adminName || 'الإدارة' },
                approved: false,
                reason
            });
            return res.redirect('/transactions');
        }

        tx.status = 'rejected'; appendAdminNote(tx, `[تم رفض الإيداع | السبب: ${reason || '---'}]`); tx.updatedAt = new Date();
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'error', text: `تم رفض طلب الإيداع بقيمة ${tx.amount} EGP.<br><b>السبب:</b> ${reason}` } } }, { strict: false });
        await tx.save(); res.redirect('/transactions');
    } catch(e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-rate', async (req, res) => {
    try {
        const txId = req.params.id; const newRate = parseFloat(req.body.newRate);
        if (isNaN(newRate) || newRate <= 0) return res.redirect('/transactions');
        const result = await repriceTransaction({
            transactionId: txId,
            newRate,
            adminName: req.session.adminName || 'الإدارة'
        });
        const tx = result.transaction;
        await logAdminFinancialChange(
            req,
            'TRANSACTION_RATE_EDITED',
            tx,
            { amount: tx.amount, costLYD: result.oldCostLYD, exchangeRate: result.oldRate, createdAt: tx.createdAt },
            { amount: tx.amount, costLYD: result.newCostLYD, exchangeRate: newRate, createdAt: tx.createdAt }
        );
        res.redirect('/transactions');
    } catch (error) {
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') {
            return res.redirect('/transactions?routeError=financial_unavailable');
        }
        if (['TRANSACTION_NOT_FOUND', 'TRANSACTION_NOT_EDITABLE'].includes(error.message)) {
            return res.redirect('/transactions?routeError=transaction_unavailable');
        }
        res.redirect('/transactions?routeError=update_failed');
    }
});

router.post('/transaction/:id/edit-data', async (req, res) => {
    try {
        const txId = req.params.id; const newAmount = parseFloat(req.body.newAmount); const newDateStr = req.body.newDate;
        if (isNaN(newAmount) || newAmount <= 0 || !newDateStr) return res.redirect('/transactions');
        const newDate = new Date(newDateStr);
        if (Number.isNaN(newDate.getTime())) return res.redirect('/transactions');
        const adminName = req.session.adminName || 'الإدارة';
        const result = await editTransactionAmount({
            transactionId: txId,
            newAmount,
            createdAt: newDate,
            adminName
        });
        for (const groupId of result.syncGroupIds) await syncBotBalance(groupId);
        await logAdminFinancialChange(
            req,
            'TRANSACTION_DATA_EDITED',
            result.transaction,
            { amount: result.oldAmountEGP, costLYD: result.oldCostLYD, createdAt: result.oldCreatedAt, status: result.transaction.status },
            { amount: result.newAmount, costLYD: result.newCostLYD, createdAt: newDate, status: result.transaction.status },
            { originalCreatedAt: result.oldCreatedAt, newCreatedAt: newDate }
        );
        res.redirect('/transactions');
    } catch (error) {
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') {
            return res.redirect('/transactions?routeError=financial_unavailable');
        }
        if (['TRANSACTION_NOT_FOUND', 'TRANSACTION_NOT_EDITABLE', 'INVALID_EXCHANGE_RATE'].includes(error.message)) {
            return res.redirect('/transactions?routeError=transaction_unavailable');
        }
        res.redirect('/transactions?routeError=update_failed');
    }
});

router.post('/transaction/:id/global-cancel', async (req, res) => {
    try {
        const reason = req.body.reason || 'إلغاء من الإدارة';
        const adminName = req.session.adminName || 'الإدارة';
        const originalTx = await Transaction.findOne(adminTxById(req, req.params.id)).lean();
        if (!originalTx) return res.redirect('/transactions');
        
        // 🟢 استخدام خدمة الاسترجاع الموحدة لضمان الدبل إنتري والأحداث المتسلسلة
        const result = await reversalService.reverseTransaction(req.params.id, reason, adminName, { status: 'cancelled_by_admin' });
        if (result.success) {
            const tx = await Transaction.findOne(adminTxById(req, req.params.id));
            if (tx) {
                const groupId = tx.executorGroupId; 
                const managerGroupId = tx.managerGroupId;
                if (groupId) await syncBotBalance(groupId); 
                if (managerGroupId) await syncBotBalance(managerGroupId);
                await logAdminFinancialChange(
                    req,
                    'TRANSACTION_CANCELLED_BY_ADMIN',
                    tx,
                    {
                        status: originalTx?.status,
                        amount: originalTx?.amount,
                        costLYD: originalTx?.costLYD,
                        createdAt: originalTx?.createdAt
                    },
                    {
                        status: tx.status,
                        amount: tx.amount,
                        costLYD: tx.costLYD,
                        createdAt: tx.createdAt
                    },
                    { reason, originalCreatedAt: originalTx?.createdAt }
                );
            }
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/change-bot', async (req, res) => {
    try {
        const txId = req.params.id; const newGroupId = req.body.newGroupId;
        if (!newGroupId) return res.redirect('/transactions');
        const result = await reassignTransactionExecutor({ transactionId: txId, newGroupId });
        await logAdminFinancialChange(
            req,
            'TRANSACTION_EXECUTOR_CHANGED',
            result.transaction,
            { executorGroupId: result.oldExecutorGroupId, executorName: result.oldExecutorName, createdAt: result.transaction.createdAt },
            { executorGroupId: result.transaction.executorGroupId, executorName: result.transaction.executorName, createdAt: result.transaction.createdAt }
        );
        res.redirect('/transactions');
    } catch (error) {
        if (error.message === 'EXECUTOR_SERVICE_MISMATCH') return res.redirect('/transactions?routeError=service_mismatch');
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') {
            return res.redirect('/transactions?routeError=financial_unavailable');
        }
        if (['TRANSACTION_NOT_FOUND', 'TRANSACTION_NOT_COMPLETED', 'EXECUTOR_ALREADY_ASSIGNED'].includes(error.message)) {
            return res.redirect('/transactions?routeError=transaction_unavailable');
        }
        res.redirect('/transactions?routeError=update_failed');
    }
});

// 🟢 تحديث حالة التحقق (KYC) للعميل من قبل الإدارة
router.post('/admin/kyc/review', async (req, res) => {
    try {
        const { userId, status, reason } = req.body;
        if (!userId || !['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'بيانات المراجعة غير صالحة' });
        }

        const { kycService } = require('../src/Application/Services/KycService');
        await kycService.updateKycStatus(userId, status, reason);

        return res.status(200).json({ success: true, message: 'تم تحديث حالة KYC بنجاح' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'حدث خطأ داخلي أثناء مراجعة KYC' });
    }
});

// 🔍 الحصول على تفاصيل العملية الشاملة + قيود الدفتر المالي (Ledger)
router.get('/transactions/:id/details', async (req, res) => {
    try {
        const tx = await Transaction.findOne(adminTxById(req, req.params.id)).select('+executorExecutionNumber');
        if (!tx) return res.status(404).json({ success: false, error: 'العملية غير موجودة' });
        
        let ledgerInfo = null;
        let balanceTransferPair = null;
        if (tx.transferType === 'balance_transfer') {
            const transferId = tx.customId.replace(/-[CD]$/, '');
            ledgerInfo = await Ledger.find({ transactionId: transferId }).lean();
            const pairTransactions = await Transaction.find(applyAdminTxPrivacy({
                ...adminAccountScope(req),
                customId: { $in: [`${transferId}-D`, `${transferId}-C`] }
            })).lean();

            const sourceTx = pairTransactions.find((item) => item.status === 'deduction' || String(item.customId).endsWith('-D'));
            const targetTx = pairTransactions.find((item) => item.status === 'deposit' || String(item.customId).endsWith('-C'));
            const sourceLedger = ledgerInfo.find((item) => item.amount < 0);
            const targetLedger = ledgerInfo.find((item) => item.amount > 0);
            let receiptProof = sourceTx?.proofImage || targetTx?.proofImage || tx.proofImage;

            if (sourceTx && targetTx) {
                const generatedReceiptProof = createBalanceTransferReceiptProof({
                    transferId,
                    sourceName: sourceTx.accountName || sourceTx.employeeName || sourceTx.companyName,
                    sourceCode: sourceTx.accountNumber || sourceTx.vodafoneNumber,
                    targetName: targetTx.accountName || targetTx.employeeName || targetTx.companyName,
                    targetCode: targetTx.accountNumber || targetTx.vodafoneNumber,
                    amount: tx.amount,
                    sourceBalanceBefore: sourceLedger?.balanceBefore,
                    sourceBalanceAfter: sourceLedger?.balanceAfter,
                    targetBalanceBefore: targetLedger?.balanceBefore,
                    targetBalanceAfter: targetLedger?.balanceAfter,
                    notes: customerFacingNotes(customerNoteFromTransaction(tx)),
                    createdAt: tx.createdAt
                });

                receiptProof = generatedReceiptProof;
                await Transaction.updateMany(
                    { customId: { $in: [`${transferId}-D`, `${transferId}-C`] } },
                    { $set: { proofImage: receiptProof, proofImages: [receiptProof] } }
                );
                tx.proofImage = receiptProof;
                tx.proofImages = [receiptProof];
            }

            balanceTransferPair = {
                transferId,
                receiptProof,
                source: sourceTx ? {
                    customId: sourceTx.customId,
                    name: sourceTx.accountName || sourceTx.employeeName || sourceTx.companyName || '---',
                    code: sourceTx.accountNumber || sourceTx.vodafoneNumber || '---',
                    balanceBefore: sourceLedger?.balanceBefore,
                    balanceAfter: sourceLedger?.balanceAfter
                } : null,
                target: targetTx ? {
                    customId: targetTx.customId,
                    name: targetTx.accountName || targetTx.employeeName || targetTx.companyName || '---',
                    code: targetTx.accountNumber || targetTx.vodafoneNumber || '---',
                    balanceBefore: targetLedger?.balanceBefore,
                    balanceAfter: targetLedger?.balanceAfter
                } : null
            };
        }
        
        res.json({ success: true, transaction: tx, ledgerInfo, balanceTransferPair });
    } catch (e) {
        console.error('[adminTransactions/GET details] خطأ:', e.message);
        res.status(500).json({ success: false, error: 'حدث خطأ أثناء تحميل تفاصيل العملية.' });
    }
});

module.exports = router;
