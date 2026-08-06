const express = require('express');
const router = express.Router();
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const ApiBalanceAudit = require('../models/ApiBalanceAudit');
const ApiProviderReturn = require('../models/ApiProviderReturn');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { syncBotBalance, escapeRegex } = require('../utils/helpers');
const { DEFAULT_API_PROVIDER_KEY, getApiProviderPreset, getApiProviderPresets } = require('../utils/apiProviderPresets');
const { getApiProviderBalance } = require('../services/externalApiService');
const { syncProviderReturnedOperations } = require('../services/apiProviderReconciliationService');
const { createExecutorAccount, ExecutorAccountError } = require('../services/executorAccountService');
const {
    archiveExecutorAccount,
    ExecutorArchiveError,
    executorTransactionFilter
} = require('../services/executorArchiveService');
const { logAction } = require('../services/auditService');
const { reversalService } = require('../src/Application/Services/ReversalService');

const normalizeText = (value) => String(value || '').trim();
const parseNumberOrDefault = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

router.get('/executors', requireAuth, async (req, res) => {
    try {
        const [groups, archivedGroups] = await Promise.all([
            ExecutorGroup.find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }),
            ExecutorGroup.find({ status: 'archived' }).sort({ archivedAt: -1 })
        ]);
        const groupsWithStats = await Promise.all(groups.map(async (group) => {
            const syncedBalance = await syncBotBalance(group._id); 
            let txCount = 0; if (group.isManagerBot) txCount = await Transaction.countDocuments({ managerGroupId: group._id, status: 'completed' }); else txCount = await Transaction.countDocuments({ executorGroupId: group._id, status: 'completed' });
            return { ...group._doc, balance: syncedBalance, txCount };
        }));
        const archivedGroupsWithStats = await Promise.all(archivedGroups.map(async (group) => {
            const txCount = group.archiveTransactionCount === null || group.archiveTransactionCount === undefined
                ? await Transaction.countDocuments(executorTransactionFilter(group._id))
                : group.archiveTransactionCount;
            return {
                ...group._doc,
                balance: group.archiveBalance === null || group.archiveBalance === undefined
                    ? group.balance
                    : group.archiveBalance,
                txCount
            };
        }));
        const origin = `${req.protocol}://${req.get('host')}`;
        res.render('executors', {
            bots: groupsWithStats,
            archivedBots: archivedGroupsWithStats,
            apiProviderPresets: getApiProviderPresets(),
            adminName: req.session.adminName,
            isMaster: req.session.adminRole === 'master',
            query: req.query,
            executorRegistrationUrl: `${origin}/executor-portal/register`,
            executorLoginUrl: `${origin}/login`
        });
    } catch (e) {
        console.error('[executors/list] failed:', e.stack || e.message);
        res.redirect('/');
    }
});

router.post('/executors/add', requireAuth, requireMaster, async (req, res) => {
    try {
        const body = req.body || {};
        const name = normalizeText(body.name);
        if (!name) return res.redirect('/executors?createError=MISSING_NAME&openCreate=1');

        const botType = normalizeText(body.botType) || 'normal';
        const isApiBot = botType === 'api' || body.isApiBot === 'on' || body.isApiBot === 'true';
        const isManagerBot = !isApiBot && (botType === 'manager' || body.isManagerBot === 'on' || body.isManagerBot === 'true');
        const balance = Number(body.balance || 0);
        const parentId = normalizeText(body.parentGroupId);
        const apiProviderKey = isApiBot ? (normalizeText(body.apiProviderKey) || DEFAULT_API_PROVIDER_KEY) : '';
        const apiPreset = getApiProviderPreset(apiProviderKey);

        const { group, employee } = await createExecutorAccount({
            groupData: {
                name,
                status: normalizeText(body.status) || 'active',
                isManagerGroup: isManagerBot,
                isManagerBot,
                isApiGroup: isApiBot,
                isApiBot,
                parentGroupId: parentId && parentId !== 'none' ? parentId : null,
                parentBotId: parentId && parentId !== 'none' ? parentId : null,
                apiProviderKey: isApiBot ? apiPreset.key : '',
                apiUrl: isApiBot ? (normalizeText(body.apiUrl) || apiPreset.apiUrl) : '',
                apiToken: isApiBot ? normalizeText(body.apiToken) : '',
                apiUsername: isApiBot ? normalizeText(body.apiUsername) : '',
                apiPassword: isApiBot ? normalizeText(body.apiPassword) : '',
                apiServiceId: isApiBot ? parseNumberOrDefault(body.apiServiceId, apiPreset.serviceId) : apiPreset.serviceId,
                apiProviderId: isApiBot ? parseNumberOrDefault(body.apiProviderId, apiPreset.providerId) : apiPreset.providerId,
                apiFieldId: isApiBot ? parseNumberOrDefault(body.apiFieldId, apiPreset.fieldId) : apiPreset.fieldId,
                apiMachineSerial: isApiBot ? (normalizeText(body.apiMachineSerial) || apiPreset.machineSerial) : apiPreset.machineSerial
            },
            managerData: isApiBot ? null : {
                name: body.managerName,
                phone: body.managerPhone,
                webUsername: body.webUsername,
                webPassword: body.webPassword
            },
            openingBalance: Number.isFinite(balance) ? balance : NaN,
            tenantId: req.tenantId
        });

        await logAction({
            action: 'EXECUTOR_CREATED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || 'الإدارة',
            targetId: group._id,
            targetModel: 'ExecutorGroup',
            metadata: {
                executorName: group.name,
                executorType: isApiBot ? 'api' : (isManagerBot ? 'manager' : 'manual'),
                managerId: employee?._id || null,
                openingBalance: balance
            }
        }).catch(() => {});

        return res.redirect('/executors?created=1');
    } catch (e) {
        console.error('[executors/add] failed:', e.stack || e.message);
        const errorCode = e instanceof ExecutorAccountError ? e.code : 'CREATE_FAILED';
        return res.redirect(`/executors?createError=${encodeURIComponent(errorCode)}&openCreate=1`);
    }
});

router.post('/executor/:id/archive', requireAuth, requireMaster, async (req, res) => {
    try {
        const result = await archiveExecutorAccount({
            executorId: req.params.id,
            archivedBy: req.session.adminName || 'الإدارة',
            reason: req.body?.reason
        });

        await logAction({
            action: 'EXECUTOR_ARCHIVED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: req.session.adminName || 'الإدارة',
            targetId: result.group._id,
            targetModel: 'ExecutorGroup',
            oldData: { status: 'paused' },
            newData: { status: 'archived', archivedAt: result.group.archivedAt },
            metadata: {
                executorName: result.group.name,
                reason: result.group.archiveReason,
                archiveBalance: result.archiveBalance ?? result.group.archiveBalance,
                archiveTransactionCount: result.archiveTransactionCount ?? result.group.archiveTransactionCount,
                archiveEmployeeCount: result.archiveEmployeeCount ?? result.group.archiveEmployeeCount,
                alreadyArchived: result.alreadyArchived
            }
        }).catch(() => {});

        const io = req.app?.get('io');
        if (io) io.emit('update_data');

        return res.json({
            success: true,
            message: result.alreadyArchived
                ? 'الحساب موجود بالفعل في الأرشيف.'
                : 'تم حذف حساب المنفذ من التشغيل ونقله إلى الأرشيف مع حفظ عملياته.',
            redirectUrl: '/executors?tab=archive&archived=1'
        });
    } catch (error) {
        if (error instanceof ExecutorArchiveError) {
            const statusCode = error.code === 'EXECUTOR_NOT_FOUND' ? 404 : 409;
            return res.status(statusCode).json({
                success: false,
                code: error.code,
                message: error.message,
                details: error.details
            });
        }
        console.error('[executor/archive] failed:', error.stack || error.message);
        return res.status(500).json({ success: false, message: 'تعذر نقل حساب المنفذ إلى الأرشيف.' });
    }
});

router.get('/executor/:id', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorGroup.findById(req.params.id).populate('parentGroupId parentBotId');
        if (!bot) return res.redirect('/executors');

        if (bot.status === 'archived') {
            const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
            const limit = 50;
            const search = normalizeText(req.query.search);
            const status = normalizeText(req.query.status);
            const fromDate = normalizeText(req.query.fromDate);
            const toDate = normalizeText(req.query.toDate);
            const filters = [executorTransactionFilter(bot._id)];

            if (search) {
                const safeSearch = escapeRegex(search);
                filters.push({
                    $or: [
                        { customId: { $regex: safeSearch, $options: 'i' } },
                        { vodafoneNumber: { $regex: safeSearch, $options: 'i' } },
                        { accountNumber: { $regex: safeSearch, $options: 'i' } },
                        { companyName: { $regex: safeSearch, $options: 'i' } },
                        { employeeName: { $regex: safeSearch, $options: 'i' } }
                    ]
                });
            }
            if (status) filters.push({ status });
            if (fromDate || toDate) {
                const createdAt = {};
                if (fromDate) createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`);
                if (toDate) createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`);
                filters.push({ createdAt });
            }

            const archiveFilter = filters.length === 1 ? filters[0] : { $and: filters };
            const [transactions, totalTransactions] = await Promise.all([
                Transaction.find(archiveFilter)
                    .sort({ updatedAt: -1 })
                    .skip((page - 1) * limit)
                    .limit(limit),
                Transaction.countDocuments(archiveFilter)
            ]);

            return res.render('executor_archive', {
                bot,
                transactions,
                totalTransactions,
                currentPage: page,
                totalPages: Math.max(1, Math.ceil(totalTransactions / limit)),
                filters: { search, status, fromDate, toDate },
                adminName: req.session.adminName
            });
        }

        bot.balance = await syncBotBalance(req.params.id);
        let queryFilter = bot.isManagerBot ? { managerGroupId: bot._id } : { executorGroupId: bot._id };
        const transactions = await Transaction.find(queryFilter).sort({ updatedAt: -1 }).limit(100);
        
        const managerBots = await ExecutorGroup.find({ isManagerBot: true, status: 'active', _id: { $ne: bot._id } });

        if (bot.isApiBot) {
            const [balanceAudits, providerReturns] = await Promise.all([
                ApiBalanceAudit.find({ executorGroupId: bot._id }).sort({ createdAt: -1 }).limit(100).lean(),
                ApiProviderReturn.find({ executorGroupId: bot._id }).sort({ firstDetectedAt: -1 }).limit(100).lean()
            ]);
            const stats = {
                successCount: transactions.filter(t => t.status === 'completed').length,
                failedCount: transactions.filter(t => t.status === 'pending' && t.adminNotes && t.adminNotes.includes('فشل')).length,
                balanceAlertCount: balanceAudits.filter(item => item.reviewStatus === 'pending').length,
                providerReturnCount: providerReturns.filter(item => item.status === 'pending_review').length
            };
            return res.render('api_room', {
                bot,
                apiProviderPreset: getApiProviderPreset(bot.apiProviderKey),
                transactions,
                balanceAudits,
                providerReturns,
                stats,
                managerBots,
                adminName: req.session.adminName,
                query: req.query
            });
        }

        res.render('executor_details', { bot, transactions, managerBots, adminName: req.session.adminName });
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/sync-provider-returns', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorGroup.findById(req.params.id);
        if (!bot || !bot.isApiBot) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على منفذ API صالح للمراجعة' });
        }
        if (bot.status === 'archived') {
            return res.status(409).json({ success: false, message: 'الحساب مؤرشف ومتاح للقراءة فقط.' });
        }

        const result = await syncProviderReturnedOperations(bot, { force: true, limit: 100 });
        return res.status(result.success ? 200 : 502).json({
            ...result,
            message: result.success
                ? `تم فحص ${result.checkedCount} عملية، والعمليات المسترجعة ${result.returnedCount}، والتنبيهات الجديدة ${result.newAlerts}`
                : (result.message || 'تعذر إكمال مراجعة عمليات المزود')
        });
    } catch (error) {
        console.error('[executor/sync-provider-returns] failed:', error.stack || error.message);
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء مراجعة عمليات المزود' });
    }
});

router.post('/executor/:id/balance-audit/:auditId/review', requireAuth, async (req, res) => {
    try {
        const audit = await ApiBalanceAudit.findOneAndUpdate(
            { _id: req.params.auditId, executorGroupId: req.params.id },
            {
                $set: {
                    reviewStatus: 'reviewed',
                    reviewedAt: new Date(),
                    reviewedBy: req.session.adminName || 'الإدارة',
                    reviewNotes: normalizeText(req.body.notes)
                }
            },
            { new: true }
        );
        if (!audit) return res.status(404).json({ success: false, message: 'سجل المطابقة غير موجود' });

        await Notification.updateMany(
            { type: 'api_balance_discrepancy', 'metadata.auditId': String(audit._id) },
            { $set: { isRead: true } }
        ).catch(() => {});
        return res.json({ success: true, message: 'تم تسجيل مراجعة فرق الرصيد' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'تعذر تسجيل مراجعة فرق الرصيد' });
    }
});

router.post('/executor/:id/provider-return/:returnId/review', requireAuth, async (req, res) => {
    try {
        const item = await ApiProviderReturn.findOneAndUpdate(
            { _id: req.params.returnId, executorGroupId: req.params.id, status: { $ne: 'cancelled' } },
            {
                $set: {
                    status: 'reviewed',
                    reviewedAt: new Date(),
                    reviewedBy: req.session.adminName || 'الإدارة',
                    reviewNotes: normalizeText(req.body.notes)
                }
            },
            { new: true }
        );
        if (!item) return res.status(404).json({ success: false, message: 'سجل العملية المسترجعة غير موجود' });
        await Notification.updateMany(
            { type: 'api_provider_return', 'metadata.providerTransactionId': item.providerTransactionId },
            { $set: { isRead: true } }
        ).catch(() => {});
        return res.json({ success: true, message: 'تم تسجيل مراجعة العملية دون إلغائها' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'تعذر تحديث سجل العملية المسترجعة' });
    }
});

router.post('/executor/:id/provider-return/:returnId/cancel', requireAuth, requireMaster, async (req, res) => {
    try {
        const item = await ApiProviderReturn.findOne({
            _id: req.params.returnId,
            executorGroupId: req.params.id
        });
        if (!item || !item.transactionId) {
            return res.status(404).json({ success: false, message: 'لا توجد عملية محلية مرتبطة بهذا الاسترجاع' });
        }

        if (item.status === 'cancelled') {
            return res.json({ success: true, message: 'سبق إلغاء العملية وإرجاع الرصيد', cancellationNumber: item.cancellationNumber });
        }

        const localTransaction = await Transaction.findById(item.transactionId);
        if (!localTransaction) {
            return res.status(404).json({ success: false, message: 'العملية المحلية المرتبطة لم تعد موجودة' });
        }
        if (localTransaction.status === 'cancelled_by_admin') {
            item.status = 'cancelled';
            item.reviewedAt = localTransaction.cancelledAt || new Date();
            item.reviewedBy = localTransaction.cancelledBy || req.session.adminName || 'الإدارة';
            item.cancellationNumber = localTransaction.cancellationNumber || '';
            await item.save();
            return res.json({
                success: true,
                message: 'سبق إلغاء العملية وإرجاع الرصيد',
                cancellationNumber: item.cancellationNumber
            });
        }

        const reason = normalizeText(req.body.reason)
            || `إلغاء بعد تأكيد استرجاع مزود API للعملية ${item.providerTransactionId}`;
        const adminName = req.session.adminName || 'الإدارة';
        const result = await reversalService.reverseTransaction(
            String(item.transactionId),
            reason,
            adminName,
            { status: 'cancelled_by_admin' }
        );
        if (!result.success) {
            return res.status(409).json(result);
        }

        item.status = 'cancelled';
        item.reviewedAt = new Date();
        item.reviewedBy = adminName;
        item.reviewNotes = reason;
        item.cancellationNumber = result.cancellationNumber || '';
        await item.save();
        await syncBotBalance(req.params.id);
        await Notification.updateMany(
            { type: 'api_provider_return', 'metadata.providerTransactionId': item.providerTransactionId },
            { $set: { isRead: true } }
        ).catch(() => {});

        await logAction({
            action: 'API_PROVIDER_RETURN_CANCELLED',
            req,
            performedById: req.session.adminId,
            performedByModel: 'Admin',
            performedByName: adminName,
            targetId: item.transactionId,
            targetModel: 'Transaction',
            metadata: {
                executorGroupId: String(item.executorGroupId),
                providerTransactionId: item.providerTransactionId,
                transactionCustomId: item.transactionCustomId,
                cancellationNumber: result.cancellationNumber,
                reason
            }
        }).catch(() => {});

        return res.json({
            success: true,
            message: 'تم إلغاء العملية وإرجاع رصيد العميل بنجاح',
            cancellationNumber: result.cancellationNumber
        });
    } catch (error) {
        console.error('[executor/provider-return/cancel] failed:', error.stack || error.message);
        return res.status(500).json({ success: false, message: 'تعذر إلغاء العملية المسترجعة' });
    }
});

router.post('/executor/:id/test-api', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorGroup.findById(req.params.id);
        if (!bot || !bot.isApiBot) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على منفذ API صالح للاختبار' });
        }
        if (bot.status === 'archived') {
            return res.status(409).json({ success: false, message: 'الحساب مؤرشف ولا يمكن تشغيل اختبار API عليه.' });
        }

        bot.lastApiTestStatus = 'pending';
        bot.lastApiTestAt = new Date();
        await bot.save();

        const result = await getApiProviderBalance(bot);
        bot.lastApiTestStatus = result.success ? 'success' : 'failed';
        bot.lastApiTestAt = new Date();
        bot.lastApiTestMessage = result.message || '';
        bot.lastApiServiceCredit = result.success ? result.serviceCredit : null;
        bot.lastApiCashCredit = result.success ? result.cashCredit : null;
        bot.lastApiAvailableBalance = result.success ? result.availableBalance : null;
        await bot.save();

        return res.status(result.success ? 200 : 502).json(result);
    } catch (e) {
        console.error('[executor/test-api] failed:', e.stack || e.message);
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء اختبار منفذ API' });
    }
});

router.post('/executor/:id/settle', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorGroup.findById(req.params.id); const amount = parseFloat(req.body.amount); const notes = req.body.notes ? req.body.notes.trim() : ''; 
        if (!bot || bot.status === 'archived') return res.redirect('/executors?tab=archive&archiveError=READ_ONLY');
        let targetBotId = bot._id; let targetBotName = bot.name;

        const parentGroupId = bot.parentGroupId || bot.parentBotId;
        if (!bot.isManagerBot && parentGroupId) { targetBotId = parentGroupId; const parentBot = await ExecutorGroup.findById(targetBotId); if (parentBot) { targetBotName = parentBot.name; } }
        
        if (!isNaN(amount) && amount !== 0) {
            const tx = await Transaction.create({
                userId: 'admin', executorGroupId: targetBotId, amount: Math.abs(amount), costLYD: 0, vodafoneNumber: 'تسديد حساب',
                status: amount > 0 ? 'deposit' : 'deduction', customId: `SETTLE-${Date.now().toString().slice(-6)}`, companyName: 'الإدارة المركزية', employeeName: amount > 0 ? 'تسديد نقدية (إيداع)' : 'خصم من المنفذ', executorName: targetBotName, notes: '', adminNotes: notes
            });
            await syncBotBalance(targetBotId); if(targetBotId.toString() !== bot._id.toString()) await syncBotBalance(bot._id); 

            if (!bot.isApiBot) {
                const emps = await Employee.find({ groupId: targetBotId, status: 'active' });
                const actionType = amount > 0 ? 'إيداع نقدية/تسديد' : 'خصم من الرصيد'; const msgText = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 الطلب: <code>${tx.customId}</code>`;
                
                for(const e of emps) {
                    try {
                        await Notification.create({
                            userId: e.webUsername,
                            title: 'إشعار مالي',
                            message: msgText,
                            type: amount > 0 ? 'deposit' : 'deduction'
                        });
                    } catch(err) {}
                }
                
                await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: amount > 0 ? 'success' : 'error', text: msgText.replace(/\n/g, '<br>') } } }, { strict: false });
            }
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/link-manager', requireAuth, async (req, res) => {
    try {
        const botId = req.params.id; const parentId = req.body.parentGroupId || req.body.parentBotId; const bot = await ExecutorGroup.findById(botId);
        if (bot && bot.status !== 'archived') {
            if (parentId === 'none') {
                bot.parentGroupId = null;
                bot.parentBotId = null;
            } else {
                bot.parentGroupId = parentId;
                bot.parentBotId = parentId;
            }
            await bot.save();
        }
        res.redirect(`/executor/${botId}`);
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/toggle-status', requireAuth, async (req, res) => {
    try {
        const botId = req.params.id; const bot = await ExecutorGroup.findById(botId); if (!bot) return res.redirect('/executors');
        if (bot.status === 'archived') return res.redirect('/executors?tab=archive&archiveError=READ_ONLY');
        bot.status = bot.status === 'active' ? 'paused' : 'active'; await bot.save();
        
        if (!bot.isApiBot) {
            try {
                const botEmployees = await Employee.find({ groupId: bot._id });
                if (botEmployees.length > 0) {
                    let message = bot.status === 'paused' ? `🔴 <b>إشعار إداري هام:</b>\n\nتم <b>إيقاف</b> هذا البوت مؤقتاً من قبل الإدارة المركزية.\nلا يمكنك استقبال أو تنفيذ أي عمليات حالياً حتى يتم تفعيله مجدداً.` : `🟢 <b>إشعار إداري:</b>\n\nتم <b>إعادة تشغيل وتفعيل</b> البوت بنجاح.\nيمكنك الآن استئناف عملك واستقبال الطلبات.`;
                    for (const emp of botEmployees) {
                        try {
                            await Notification.create({
                                userId: emp.webUsername,
                                title: 'حالة الحساب',
                                message: message,
                                type: 'system_alert'
                            });
                        } catch(e) {}
                    }
                }
            } catch (error) {}
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

module.exports = router;
