const express = require('express');
const router = express.Router();
const https = require('https');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const { createBalanceTransferReceiptProof } = require('../services/balanceTransferReceiptService');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middlewares/auth');
const { syncBotBalance } = require('../utils/helpers');
const { escapeRegex } = require('../middlewares/sanitize');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');
const { logAction } = require('../services/auditService');

// 🚀 استدعاء محرك الـ API 
const { executeTransferViaApi, saveApiReceiptProof } = require('../services/externalApiService');
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

const appendCustomerReference = (tx, label, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return;
    const line = `[${label}: ${cleanValue}]`;
    if (!String(tx.notes || '').includes(line)) {
        tx.notes = appendNoteText(tx.notes, line);
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
    metadata: reportAuditMetadata(tx, metadata)
});

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



router.get('/transactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 25;
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
            $and: [
                {
                    $or: [
                        { transferType: { $ne: 'balance_transfer' } },
                        { customId: { $not: /-C$/ } }
                    ]
                }
            ]
        };

        // ✅ NoSQL Regex Injection — تعقيم مصطلح البحث
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
            query.createdAt = {};
            if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
            if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
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

        const totalTxs = await Transaction.countDocuments(query);
        const totalPages = Math.ceil(totalTxs / limit);
        const transactions = await Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);

        // ✅ إصلاح الأداء: استخدام Aggregation Pipeline بدل جلب كل السجلات
        const totalsAgg = await Transaction.aggregate([
            { $match: query },
            { $group: {
                _id: '$status',
                totalAmount: { $sum: '$amount' },
                totalCostLYD: { $sum: '$costLYD' }
            }}
        ]);
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        totalsAgg.forEach(row => {
            if (row._id === 'completed') { totals.transfersEGP = row.totalAmount; totals.transfersLYD = row.totalCostLYD; }
            else if (row._id === 'deposit') { totals.depositsEGP = row.totalAmount; }
            else if (row._id === 'deduction') { totals.deductionsEGP = row.totalAmount; }
        });

        const executorGroups = await ExecutorGroup.find({ status: 'active', isManagerBot: { $ne: true } });
        console.log('DEBUG: executorGroups fetched:', executorGroups.map(g => ({ name: g.name, id: g._id, status: g.status })));
        const allGroups = await ExecutorGroup.find({});
        const allGroupsMap = {};
        allGroups.forEach(b => { allGroupsMap[b._id.toString()] = b.name; });

        res.render('transactions', { 
            transactions, 
            executorGroups, 
            executorBots: executorGroups, 
            allGroupsMap, 
            allBotsMap: allGroupsMap, 
            currentPage: page, 
            totalPages, 
            search, 
            statusFilter, 
            fromDate, 
            toDate, 
            filterType,
            totals,
            query: req.query
        });
    } catch (e) {
        console.error('[adminTransactions/GET transactions] خطأ:', e.message);
        res.status(500).send('خطأ داخلي');
    }
});

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
            query.createdAt = {};
            if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
            if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
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

        res.render('print_report', { transactions, fromDate, toDate, filterType, totals });
    } catch (e) {
        console.error('[adminTransactions/print] خطأ:', e.message);
        res.status(500).send('حدث خطأ أثناء إعداد التقرير.');
    }
});

router.post('/transaction/:id/assign-executor', async (req, res) => {
    try {
        const txId = req.params.id; const executorGroupId = req.body.executorGroupId || req.body.executorBotId; const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') return res.redirect('/transactions');

        const executorGroup = await ExecutorGroup.findById(executorGroupId);

        if (executorGroup && executorGroup.status === 'active' && !executorGroup.isManagerBot) {
            
            // 🤖====================================================🤖
            // 🚀 المسار الذكي: إذا كان هذا البوت آلياً (API Integration)
            // 🤖====================================================🤖
            if (executorGroup.isApiBot) {
                tx.status = 'processing';
                tx.executorGroupId = executorGroup._id;
                tx.managerGroupId = getParentGroupId(executorGroup);
                tx.executorName = executorGroup.name;
                await tx.save();

                const { addTransferJob } = require('../services/bullQueueService');
                await addTransferJob(String(tx._id), String(executorGroup._id));
                return res.redirect('/transactions');

                // التخاطب مع سيرفر الشركة الخارجية
                const apiResult = await executeTransferViaApi(tx, executorGroup);

                if (apiResult.success === true) {
                    const exactRefNumber = String(apiResult.reference_number || apiResult.sender_number || apiResult.external_transaction_id || '').trim();

                    if (exactRefNumber) {
                        tx.status = 'completed';
                        tx.executorName = 'تنفيذ آلي (API)';
                        tx.executorSenderPhone = exactRefNumber;
                        appendCustomerReference(tx, 'الرقم المرجعي', exactRefNumber);
                        if (apiResult.external_transaction_id && apiResult.external_transaction_id !== exactRefNumber) {
                            appendCustomerReference(tx, 'رقم عملية المزود', apiResult.external_transaction_id);
                        }
                        appendAdminNote(tx, `[تنفيذ آلي ناجح | الرقم المرجعي: ${exactRefNumber || '---'} | رقم عملية المزود: ${apiResult.external_transaction_id || '---'}]`);
                        
                        try {
                            const receiptProof = await saveApiReceiptProof(tx, apiResult);
                            if (receiptProof) {
                                tx.proofImage = receiptProof;
                                tx.proofImages = [receiptProof];
                            } else {
                                appendAdminNote(tx, '[تنبيه: تم تنفيذ API بنجاح لكن تعذر توليد صورة الإيصال]');
                            }
                        } catch (err) {
                            console.error('[adminTransactions/assign-executor] خطأ في إنشاء إيصال الـ API:', err.message);
                            appendAdminNote(tx, `[تعذر توليد إيصال API: ${err.message}]`);
                        }

                        if (apiResult.processLog) {
                            appendAdminNote(tx, `--- سجل الـ API\n${apiResult.processLog}`);
                        }
                        await tx.save();

                        executorGroup.balance -= tx.amount;
                        await executorGroup.save();

                        // 2. إشعار العميل عبر النظام 
                        // 🟢 تم استبدال التيليجرام بـ Socket.IO لاحقاً

                        // 3. 🟢 إرسال Log النجاح لـ "بوت المراقبة البشري" (إن وجد)
                        const parentGroupId = getParentGroupId(executorGroup);
                        if (parentGroupId) {
                            try {
                                const monitorGroup = await ExecutorGroup.findById(parentGroupId);
                                if (monitorGroup) {
                                    // 🟢 تم استبدال التيليجرام بـ Socket.IO لاحقاً
                                }
                            } catch(e){}
                        }
                    } else {
                        tx.status = 'pending';
                        tx.executorGroupId = executorGroup._id;
                        tx.executorName = 'في انتظار رقم مرجعي (API)';
                        appendCustomerReference(tx, 'رقم المرسل', exactRefNumber);
                        appendAdminNote(tx, '[معلقة - تم تنفيذ طلب API بدون رقم مرجعي واضح]');
                        if (apiResult.processLog) {
                            appendAdminNote(tx, `--- سجل الـ API\n${apiResult.processLog}`);
                        }
                        await tx.save();

                        // إرسال رسالة إلى مجموعة الواتساب
                        try {
                            const { sendWhatsAppAlert } = require('../services/whatsappService');
                            await sendWhatsAppAlert(tx, apiResult);
                        } catch (waErr) {
                            console.error('[adminTransactions/assign-executor] خطأ في إرسال تنبيه الواتساب:', waErr.message);
                        }
                    }

                } else {
                    // 🔴 فشل الـ API -> تحويل الطلب فوراً للبشر (Human Fallback)
                    const parentGroupId = getParentGroupId(executorGroup);
                    if (parentGroupId) {
                        const monitorGroup = await ExecutorGroup.findById(parentGroupId);
                        if (monitorGroup) {
                            // تغيير مسؤولية الطلب ليكون من نصيب الفريق البشري
                            tx.executorGroupId = monitorGroup._id;
                            tx.managerGroupId = getParentGroupId(monitorGroup);
                            tx.executorName = monitorGroup.name;
                            tx.status = 'processing';
                            appendAdminNote(tx, `[فشل API - تم التحويل للمراقبة البشرية | السبب: ${apiResult.message}]`);
                            if (apiResult.processLog) {
                                appendAdminNote(tx, `--- سجل الـ API\n${apiResult.processLog}`);
                            }
                            await tx.save();

                            // 🟢 تم استبدال إشعارات التيليجرام بـ Socket.IO لاحقاً
                        }
                    } else {
                        // لا يوجد فريق بشري مرتبط -> إرجاع الطلب للإدارة
                        tx.status = 'pending'; 
                        appendAdminNote(tx, `[فشل التنفيذ الآلي: ${apiResult.message}]`);
                        if (apiResult.processLog) {
                            appendAdminNote(tx, `--- سجل الـ API\n${apiResult.processLog}`);
                        }
                        tx.executorGroupId = undefined;
                        tx.executorName = undefined;
                        await tx.save();
                    }
                }
                return res.redirect('/transactions');
            }

            // 👨‍💻====================================================👨‍💻
            // المسار الكلاسيكي: للبوت البشري العادي
            // 👨‍💻====================================================👨‍💻
            tx.executorGroupId = executorGroup._id; tx.managerGroupId = getParentGroupId(executorGroup); tx.executorName = executorGroup.name; tx.status = 'processing'; tx.broadcastMessages = []; 

            // 🟢 الإشعارات ستكون عبر Socket.IO

            await tx.save();
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/pull-task', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (tx && (tx.status === 'processing' || tx.status === 'accepted')) {
            const oldGroupId = tx.executorGroupId; const displayId = tx.customId || tx._id.toString();

            tx.status = 'pending'; tx.executorGroupId = undefined; tx.managerGroupId = undefined; tx.executorName = undefined; tx.operatorId = undefined; tx.broadcastMessages = []; tx.adminMessages = []; tx.emergencyAlert = undefined; 

            // 🟢 إشعارات الانسحاب عبر Socket.IO

            await tx.save();
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/emergency-alert', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx || !['processing', 'accepted'].includes(tx.status)) { return res.redirect('/transactions'); }
        const alertMsg = req.body.alertMessage || `تنبيه عاجل من الإدارة للطلب رقم ${tx.customId || tx._id}! يرجى سرعة التنفيذ!`;
        await Transaction.updateOne({ _id: tx._id }, { $set: { emergencyAlert: alertMsg } }, { strict: false });

        // 🟢 الإشعارات عبر Socket.IO

        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/accept-deposit-web', async (req, res) => {
    try {
        const { imageBase64 } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.json({success: false, error: 'الطلب غير متاح'});

        // 🟢 إزالة التيليجرام 
        let fileId = `deposit_${Date.now()}.jpg`;

        tx.status = 'deposit'; tx.proofImage = fileId; tx.updatedAt = new Date();
        
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع بقيمة ${tx.amount} EGP وتمت إضافة الرصيد لحسابك بنجاح.`, imageUrl: `/proxy/image/${tx._id}/0` } } }, { strict: false });
        await tx.save(); if (tx.executorGroupId) await syncBotBalance(tx.executorGroupId); 
        res.json({success: true});
    } catch(e) { res.json({success: false, error: e.message}); }
});

router.post('/transaction/:id/reject-deposit-web', async (req, res) => {
    try {
        const { reason } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.redirect('/transactions');

        tx.status = 'rejected'; appendAdminNote(tx, `[تم رفض الإيداع | السبب: ${reason || '---'}]`); tx.updatedAt = new Date();
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'error', text: `تم رفض طلب الإيداع بقيمة ${tx.amount} EGP.<br><b>السبب:</b> ${reason}` } } }, { strict: false });
        await tx.save(); res.redirect('/transactions');
    } catch(e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-rate', async (req, res) => {
    try {
        const txId = req.params.id; const newRate = parseFloat(req.body.newRate);
        if (isNaN(newRate) || newRate <= 0) return res.redirect('/transactions');
        const tx = await Transaction.findById(txId);
        if (!tx || ['rejected', 'cancelled_by_admin'].includes(tx.status)) return res.redirect('/transactions');

        const oldCost = tx.costLYD || 0;
        const oldRate = tx.exchangeRate || (oldCost > 0 ? tx.amount / oldCost : 0);
        const newCost = tx.amount / newRate;
        const diff = newCost - oldCost;
        if (tx.companyId) { const company = await ClientCompany.findById(tx.companyId); if (company) { company.balance -= diff; await company.save(); } } 
        else if (tx.userId) { const user = await User.findOne({ phone: tx.userId }); if (user) { user.balance -= diff; await user.save(); } }

        const adminName = req.session.adminName || 'الإدارة';
        tx.costLYD = newCost;
        tx.exchangeRate = newRate;
        appendAdminNote(tx, `[تم تعديل السعر من ${Number(oldRate).toFixed(3)} إلى ${newRate} بواسطة: ${adminName}]`);
        await tx.save();
        await logAdminFinancialChange(
            req,
            'TRANSACTION_RATE_EDITED',
            tx,
            { amount: tx.amount, costLYD: oldCost, exchangeRate: oldRate, createdAt: tx.createdAt },
            { amount: tx.amount, costLYD: newCost, exchangeRate: newRate, createdAt: tx.createdAt }
        );
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-data', async (req, res) => {
    try {
        const txId = req.params.id; const newAmount = parseFloat(req.body.newAmount); const newDateStr = req.body.newDate;
        if (isNaN(newAmount) || newAmount <= 0 || !newDateStr) return res.redirect('/transactions');
        const tx = await Transaction.findById(req.params.id);
        if (!tx || ['rejected', 'cancelled_by_admin'].includes(tx.status)) return res.redirect('/transactions');

        const oldAmountEGP = tx.amount;
        const oldCostLYD = tx.costLYD || 0;
        const oldCreatedAt = tx.createdAt;
        const newDate = new Date(newDateStr);
        if (Number.isNaN(newDate.getTime())) return res.redirect('/transactions');
        const changedAt = new Date();
        const adminName = req.session.adminName || 'الإدارة';
        let newCostLYD = oldCostLYD;

        if (tx.status === 'deposit' || tx.status === 'deduction') {
            const diffAmount = newAmount - oldAmountEGP; const diffDeposit = (tx.status === 'deposit') ? diffAmount : -diffAmount;
            if (tx.userId === 'admin' && tx.executorGroupId) {
                const newAdminNotes = appendNoteText(tx.adminNotes, `[تم تعديل (المبلغ: ${newAmount}، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`);
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, createdAt: newDate, updatedAt: changedAt, adminNotes: newAdminNotes } }, { timestamps: false });
                await syncBotBalance(tx.executorGroupId); if (tx.managerGroupId) await syncBotBalance(tx.managerGroupId);
            } else {
                if (tx.companyId) { const comp = await ClientCompany.findById(tx.companyId); if (comp) { comp.balance += diffDeposit; await comp.save(); } } 
                else if (tx.userId) { const user = await User.findOne({ phone: tx.userId }); if (user) { user.balance += diffDeposit; await user.save(); } }
                const newAdminNotes = appendNoteText(tx.adminNotes, `[تم تعديل (المبلغ: ${newAmount}، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`);
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, createdAt: newDate, updatedAt: changedAt, adminNotes: newAdminNotes } }, { timestamps: false });
            }
        } else {
            if (!Number.isFinite(Number(tx.exchangeRate)) || Number(tx.exchangeRate) <= 0) return res.redirect('/transactions');
            newCostLYD = parseFloat((newAmount / tx.exchangeRate).toFixed(3));
            const diffEGP = newAmount - oldAmountEGP; const diffLYD = newCostLYD - oldCostLYD;

            if (tx.companyId) { const comp = await ClientCompany.findById(tx.companyId); if (comp) { comp.balance -= diffLYD; await comp.save(); } } 
            else if (tx.userId) { const user = await User.findOne({ phone: tx.userId }); if (user) { user.balance -= diffLYD; await user.save(); } }

            if (tx.status === 'completed' && tx.executorGroupId) {
                const execGroup = await ExecutorGroup.findById(tx.executorGroupId); if (execGroup) { execGroup.balance -= diffEGP; await execGroup.save(); }
                if (tx.managerGroupId) { const mgrGroup = await ExecutorGroup.findById(tx.managerGroupId); if (mgrGroup) { mgrGroup.balance -= diffEGP; await mgrGroup.save(); } }
            }

            const newAdminNotes = appendNoteText(tx.adminNotes, `[تم تعديل (المبلغ: ${newAmount}EGP، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`);
            await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, costLYD: newCostLYD, createdAt: newDate, updatedAt: changedAt, adminNotes: newAdminNotes } }, { timestamps: false });

            // 🟢 تم إزالة إشعارات التيليجرام للتعديلات
        }
        await logAdminFinancialChange(
            req,
            'TRANSACTION_DATA_EDITED',
            tx,
            { amount: oldAmountEGP, costLYD: oldCostLYD, createdAt: oldCreatedAt, status: tx.status },
            { amount: newAmount, costLYD: newCostLYD, createdAt: newDate, status: tx.status },
            { originalCreatedAt: oldCreatedAt, newCreatedAt: newDate }
        );
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/global-cancel', async (req, res) => {
    try {
        const reason = req.body.reason || 'إلغاء من الإدارة';
        const adminName = req.session.adminName || 'الإدارة';
        const originalTx = await Transaction.findById(req.params.id).lean();
        
        // 🟢 استخدام خدمة الاسترجاع الموحدة لضمان الدبل إنتري والأحداث المتسلسلة
        const result = await reversalService.reverseTransaction(req.params.id, reason, adminName, { status: 'cancelled_by_admin' });
        if (result.success) {
            const tx = await Transaction.findById(req.params.id);
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
        const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'completed') return res.redirect('/transactions');
        if (tx.executorGroupId && tx.executorGroupId.toString() === newGroupId.toString()) return res.redirect('/transactions');
        const oldExecutorGroupId = tx.executorGroupId;
        const oldExecutorName = tx.executorName;

        if (tx.executorGroupId) { const oldGroup = await ExecutorGroup.findById(tx.executorGroupId); if (oldGroup) { oldGroup.balance += tx.amount; await oldGroup.save(); } }
        if (tx.managerGroupId) { const oldManager = await ExecutorGroup.findById(tx.managerGroupId); if (oldManager) { oldManager.balance += tx.amount; await oldManager.save(); } }

        const newGroup = await ExecutorGroup.findById(newGroupId); let newManagerId = null;
        if (newGroup) {
            newGroup.balance -= tx.amount; await newGroup.save();
            const parentGroupId = getParentGroupId(newGroup);
            if (parentGroupId) { const newManager = await ExecutorGroup.findById(parentGroupId); if (newManager) { newManager.balance -= tx.amount; await newManager.save(); newManagerId = newManager._id; } }
        }

        tx.executorGroupId = newGroupId; tx.managerGroupId = newManagerId; tx.executorName = newGroup ? newGroup.name : 'غير محدد';
        appendAdminNote(tx, `[تم النقل محاسبياً إلى بوت: ${newGroup ? newGroup.name : 'غير معروف'}]`);
        await tx.save();
        await logAdminFinancialChange(
            req,
            'TRANSACTION_EXECUTOR_CHANGED',
            tx,
            { executorGroupId: oldExecutorGroupId, executorName: oldExecutorName, createdAt: tx.createdAt },
            { executorGroupId: tx.executorGroupId, executorName: tx.executorName, createdAt: tx.createdAt }
        );
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
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
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ success: false, error: 'العملية غير موجودة' });
        
        let ledgerInfo = null;
        let balanceTransferPair = null;
        if (tx.transferType === 'balance_transfer') {
            const transferId = tx.customId.replace(/-[CD]$/, '');
            ledgerInfo = await Ledger.find({ transactionId: transferId }).lean();
            const pairTransactions = await Transaction.find({
                customId: { $in: [`${transferId}-D`, `${transferId}-C`] }
            }).lean();

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
