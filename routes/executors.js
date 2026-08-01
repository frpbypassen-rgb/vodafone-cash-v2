const express = require('express');
const router = express.Router();
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const Notification = require('../models/Notification');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { syncBotBalance } = require('../utils/helpers');
const { DEFAULT_API_PROVIDER_KEY, getApiProviderPreset, getApiProviderPresets } = require('../utils/apiProviderPresets');
const { getApiProviderBalance } = require('../services/externalApiService');

const normalizeText = (value) => String(value || '').trim();
const parseNumberOrDefault = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

router.get('/executors', requireAuth, async (req, res) => {
    try {
        const groups = await ExecutorGroup.find({}).sort({ createdAt: -1 });
        const groupsWithStats = await Promise.all(groups.map(async (group) => {
            const syncedBalance = await syncBotBalance(group._id); 
            let txCount = 0; if (group.isManagerBot) txCount = await Transaction.countDocuments({ managerGroupId: group._id, status: 'completed' }); else txCount = await Transaction.countDocuments({ executorGroupId: group._id, status: 'completed' });
            return { ...group._doc, balance: syncedBalance, txCount };
        }));
        res.render('executors', { bots: groupsWithStats, apiProviderPresets: getApiProviderPresets(), adminName: req.session.adminName, query: req.query });
    } catch (e) { res.redirect('/'); }
});

router.post('/executors/add', requireAuth, requireMaster, async (req, res) => {
    try {
        const body = req.body || {};
        const name = normalizeText(body.name);
        if (!name) return res.redirect('/executors?createError=missing');

        const botType = normalizeText(body.botType) || 'normal';
        const isApiBot = botType === 'api' || body.isApiBot === 'on' || body.isApiBot === 'true';
        const isManagerBot = !isApiBot && (botType === 'manager' || body.isManagerBot === 'on' || body.isManagerBot === 'true');
        const balance = Number(body.balance || 0);
        const parentId = normalizeText(body.parentGroupId);
        const apiProviderKey = isApiBot ? (normalizeText(body.apiProviderKey) || DEFAULT_API_PROVIDER_KEY) : '';
        const apiPreset = getApiProviderPreset(apiProviderKey);

        const group = await ExecutorGroup.create({
            name,
            status: normalizeText(body.status) || 'active',
            balance: Number.isFinite(balance) ? balance : 0,
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
        });

        const managerName = normalizeText(body.managerName);
        const webUsername = normalizeText(body.webUsername).toLowerCase();
        const webPassword = normalizeText(body.webPassword);
        if (managerName && webUsername && webPassword) {
            await Employee.create({
                name: managerName,
                phone: normalizeText(body.managerPhone),
                role: 'manager',
                status: 'active',
                groupId: group._id,
                webUsername,
                webPassword,
                canViewAllReports: true,
                tenantId: req.tenantId || undefined
            });
        }

        return res.redirect('/executors?created=1');
    } catch (e) {
        console.error('[executors/add] failed:', e.stack || e.message);
        return res.redirect('/executors?createError=1');
    }
});

router.get('/executor/:id', requireAuth, async (req, res) => {
    try {
        await syncBotBalance(req.params.id); 
        const bot = await ExecutorGroup.findById(req.params.id).populate('parentGroupId parentBotId');
        let queryFilter = bot.isManagerBot ? { managerGroupId: bot._id } : { executorGroupId: bot._id };
        const transactions = await Transaction.find(queryFilter).sort({ updatedAt: -1 }).limit(100);
        
        const managerBots = await ExecutorGroup.find({ isManagerBot: true, status: 'active', _id: { $ne: bot._id } });

        if (bot.isApiBot) {
            const stats = {
                successCount: transactions.filter(t => t.status === 'completed').length,
                failedCount: transactions.filter(t => t.status === 'pending' && t.adminNotes && t.adminNotes.includes('فشل')).length,
            };
            return res.render('api_room', { bot, apiProviderPreset: getApiProviderPreset(bot.apiProviderKey), transactions, stats, managerBots, adminName: req.session.adminName });
        }

        res.render('executor_details', { bot, transactions, managerBots, adminName: req.session.adminName });
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/test-api', requireAuth, async (req, res) => {
    try {
        const bot = await ExecutorGroup.findById(req.params.id);
        if (!bot || !bot.isApiBot) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على منفذ API صالح للاختبار' });
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
        if (bot) {
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
