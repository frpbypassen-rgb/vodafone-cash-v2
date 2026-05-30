const express = require('express');
const router = express.Router();
const axios = require('axios'); 
const { Telegram } = require('telegraf');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const fs = require('fs');
const path = require('path');

const Transaction = require('../models/Transaction');
const ExecutorBot = require('../models/ExecutorBot');
const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const SupportTicket = require('../models/SupportTicket');
const { requireAuth } = require('../middlewares/auth');

const apiTransferQueue = require('../services/queueService');
const { updateBalanceWithLedger } = require('../services/walletService');

router.use(requireAuth);

// ===============================================
// 🖼️ عرض صور الإثباتات (Proxy API) - القراءة المباشرة من السيرفر 🚀
// ===============================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id).lean();
        if (!tx) return res.status(404).send('لا توجد عملية');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        
        if (tx.proofImages && tx.proofImages.length > index) photoId = tx.proofImages[index];
        else if (tx.proofImage && index === 0) photoId = tx.proofImage; 

        // 🟢 تغطية فورية: لو photoId غير موجود، لكن localProofImage موجود، نستخدمه فوراً
        if (!photoId && tx.localProofImage) {
            photoId = tx.localProofImage;
        }

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        // 1️⃣ الحل النهائي القاطع: قراءة من الهارد ديسك
        if (photoId.startsWith('/uploads') || (tx.localProofImage && tx.localProofImage.startsWith('/uploads'))) {
            const targetPath = photoId.startsWith('/uploads') ? photoId : tx.localProofImage;
            const fullPath = path.join(process.cwd(), targetPath);
            
            if (fs.existsSync(fullPath)) {
                res.set('Cache-Control', 'public, max-age=31536000');
                return res.sendFile(fullPath); 
            }
        }

        // 2️⃣ --- (دعم الصور القديمة جداً المحفوظة Base64) ---
        if (photoId.startsWith('data:image')) {
            const base64Data = photoId.replace(/^data:image\/\w+;base64,/, "");
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(base64Data, 'base64'));
        }

        // 3️⃣ --- (دعم الصور القديمة المحفوظة روابط) ---
        if (photoId.startsWith('http')) {
            const response = await axios.get(photoId, { responseType: 'arraybuffer' });
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(response.data));
        }

        // 4️⃣ --- (دعم الصور القديمة المحفوظة كـ File ID في تيليجرام) ---
        let tokensToTry = [];
        if (tx.executorBotId) { const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot && execBot.token) tokensToTry.push(execBot.token); }
        if (process.env.ADMIN_BOT_TOKEN) tokensToTry.push(process.env.ADMIN_BOT_TOKEN);
        if (process.env.CLIENT_BOT_TOKEN) tokensToTry.push(process.env.CLIENT_BOT_TOKEN);
        
        let fileLink = null;
        for (const token of [...new Set(tokensToTry)]) {
            try { const api = new Telegram(token); const link = await api.getFileLink(photoId); if (link && link.href) { fileLink = link.href; break; } } catch (e) {}
        }
        
        if (!fileLink) return res.status(404).send('تعذر الوصول للصورة القديمة في تيليجرام');
        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
        res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
        return res.send(Buffer.from(response.data));

    } catch (error) { 
        console.error('[Web Proxy Error]:', error.message);
        res.status(500).send('خطأ داخلي'); 
    }
});

// ===============================================
// 🔔 الإشعارات وسجل العمليات
// ===============================================
router.get('/api/notifications/unread', async (req, res) => {
    try { const notifs = await Notification.find({ isRead: false }).sort({ createdAt: -1 }); res.json({ count: notifs.length, notifications: notifs }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/:id/read', async (req, res) => {
    try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/read-all', async (req, res) => {
    try { await Notification.updateMany({ isRead: false }, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.get('/', async (req, res) => {
    try {
        const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
        const usersCount = await User.countDocuments(); const companiesCount = await ClientBot.countDocuments(); const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' }); const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } }); const completedTxs = await Transaction.countDocuments({ status: 'completed', updatedAt: { $gte: startOfDay } });
        res.render('index', { usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs, adminName: req.session.adminName });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.get('/transactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1; const limit = 25; const search = req.query.search || ''; const statusFilter = req.query.status || ''; const fromDate = req.query.fromDate || ''; const toDate = req.query.toDate || '';
        let query = {};
        if (search) { query.$or = [{ customId: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { companyName: { $regex: search, $options: 'i' } }, { employeeName: { $regex: search, $options: 'i' } }]; }
        if (statusFilter) query.status = statusFilter;
        if (fromDate || toDate) { query.createdAt = {}; if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`); if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`); }

        const totalTxs = await Transaction.countDocuments(query); const totalPages = Math.ceil(totalTxs / limit);
        const transactions = await Transaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
        
        const allFilteredTxs = await Transaction.find(query);
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        allFilteredTxs.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        const executorBots = await ExecutorBot.find({ status: 'active', isManagerBot: false }); 
        const allBots = await ExecutorBot.find({}); const allBotsMap = {}; allBots.forEach(b => { allBotsMap[b._id.toString()] = b.name; });
        
        res.render('transactions', { transactions, executorBots, allBotsMap, currentPage: page, totalPages, search, statusFilter, fromDate, toDate, totals });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.get('/transactions/print', async (req, res) => {
    try {
        const search = req.query.search || ''; const statusFilter = req.query.status || ''; const fromDate = req.query.fromDate || ''; const toDate = req.query.toDate || '';
        let query = {};
        if (search) { query.$or = [{ customId: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { companyName: { $regex: search, $options: 'i' } }, { employeeName: { $regex: search, $options: 'i' } }]; }
        if (statusFilter) query.status = statusFilter;
        if (fromDate || toDate) { query.createdAt = {}; if (fromDate) query.createdAt.$gte = new Date(`${fromDate}T00:00:00.000Z`); if (toDate) query.createdAt.$lte = new Date(`${toDate}T23:59:59.999Z`); }

        const transactions = await Transaction.find(query).sort({ createdAt: -1 });
        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0, deductionsEGP: 0 };
        transactions.forEach(tx => {
            if (tx.status === 'completed') { totals.transfersEGP += (tx.amount || 0); totals.transfersLYD += (tx.costLYD || 0); } 
            else if (tx.status === 'deposit') { totals.depositsEGP += (tx.amount || 0); } 
            else if (tx.status === 'deduction') { totals.deductionsEGP += (tx.amount || 0); }
        });

        res.render('print_report', { transactions, fromDate, toDate, totals });
    } catch (e) { res.status(500).send('حدث خطأ أثناء إعداد التقرير.'); }
});

// ===============================================
// 🚀 توجيه الطلبات (آلياً للبوت API وبشرياً)
// ===============================================
router.post('/transaction/:id/assign-executor', async (req, res) => {
    try {
        const txId = req.params.id; const executorBotId = req.body.executorBotId; const tx = await Transaction.findById(txId);
        if (!tx || tx.status !== 'pending') return res.redirect('/transactions');

        const executorBot = await ExecutorBot.findById(executorBotId);

        if (executorBot && !executorBot.isManagerBot) { 
            
            if (tx.adminMessages && tx.adminMessages.length > 0) {
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                for (const adminMsg of tx.adminMessages) await adminAPI.deleteMessage(adminMsg.telegramId, adminMsg.messageId).catch(() => {});
                tx.adminMessages = []; 
            }

            if (executorBot.isApiBot) {
                tx.status = 'processing';
                tx.executorBotId = executorBot._id;
                tx.executorBotName = executorBot.name;
                tx.managerBotId = executorBot.parentBotId || null; 
                await tx.save();

                if (executorBot.parentBotId) {
                    try {
                        const monitorBot = await ExecutorBot.findById(executorBot.parentBotId);
                        if (monitorBot && monitorBot.token) {
                            const monitorAPI = new Telegram(monitorBot.token);
                            const monitorStaff = await Employee.find({ botId: monitorBot._id, status: 'active' });
                            const startMsg = `🟡 <b>سجل API (في انتظار الطابور)</b>\n\n🤖 <b>البوت:</b> ${executorBot.name}\n🧾 <b>الطلب:</b> <code>${tx.customId}</code>\n📞 <b>الرقم:</b> <code>${tx.vodafoneNumber || tx.accountNumber}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n⏳ <i>جاري الانتظار في طابور التنفيذ...</i>`;
                            for (const staff of monitorStaff) {
                                if (staff.telegramId) await monitorAPI.sendMessage(staff.telegramId, startMsg, { parse_mode: 'HTML' }).catch(()=>{});
                            }
                        }
                    } catch(e){}
                }

                await apiTransferQueue.addJob(tx._id, executorBot._id);
                return res.redirect('/transactions');
            }

            tx.executorBotId = executorBot._id; tx.managerBotId = executorBot.parentBotId || null; tx.executorBotName = executorBot.name; tx.status = 'processing'; tx.broadcastMessages = []; 

            const employees = await Employee.find({ botId: executorBot._id, status: 'active' });
            const execBotAPI = new Telegram(executorBot.token); 
            
            let typeLabel = '📱 فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = '📮 حساب بريد'; if(tx.transferType === 'post_card') typeLabel = '💳 بطاقة عميل';
            let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`; if(tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

            const noteDisplay = tx.notes ? `\n📝 <b>الملاحظة:</b> ${tx.notes}` : '';
            const msg = `🔔 <b>مهمة تحويل جديدة من الإدارة! (${typeLabel})</b>\n\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>${noteDisplay}`;
            
            let idUrl = null;
            if (tx.transferType === 'post_card' && tx.idCardImage) {
                try { let cToken = process.env.CLIENT_BOT_TOKEN; if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) cToken = comp.token; } const tempApi = new Telegram(cToken); idUrl = (await tempApi.getFileLink(tx.idCardImage)).href; } catch(e){}
            }

            for (const emp of employees) {
                if (emp.telegramId) {
                    try {
                        const isManager = emp.role === 'manager'; const btnText = isManager ? '🤝 قبول المهمة (كمدير)' : '🤝 قبول المهمة'; const markup = { inline_keyboard: [[{ text: btnText, callback_data: `accept_task_${tx._id}` }]] };
                        let sentMsg;
                        if (idUrl) sentMsg = await execBotAPI.sendPhoto(emp.telegramId, { url: idUrl }, { caption: msg, parse_mode: 'HTML', reply_markup: markup }).catch(() => execBotAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup }));
                        else sentMsg = await execBotAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML', reply_markup: markup });

                        if (sentMsg) tx.broadcastMessages.push({ telegramId: emp.telegramId, messageId: sentMsg.message_id });
                    } catch (err) {}
                }
            }
            await tx.save();
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/pull-task', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (tx && (tx.status === 'processing' || tx.status === 'accepted')) {
            const oldBotId = tx.executorBotId; const oldOperatorId = tx.operatorId; const displayId = tx.customId || tx._id.toString(); const oldBroadcasts = tx.broadcastMessages || [];

            tx.status = 'pending'; tx.executorBotId = undefined; tx.managerBotId = undefined; tx.executorBotName = undefined; tx.executorName = '---'; tx.operatorId = undefined; tx.broadcastMessages = []; tx.adminMessages = []; tx.emergencyAlert = undefined; 

            if (oldBotId) {
                try {
                    const execBot = await ExecutorBot.findById(oldBotId);
                    if (execBot) {
                        const execAPI = new Telegram(execBot.token);
                        if (oldOperatorId) await execAPI.sendMessage(oldOperatorId, `⚠️ <b>تنبيه من الإدارة العليا:</b>\nتم سحب الطلب رقم <code>${displayId}</code> منك وإعادته للإدارة!`, { parse_mode: 'HTML' }).catch(()=>{});
                        for (const bMsg of oldBroadcasts) await execAPI.deleteMessage(bMsg.telegramId, bMsg.messageId).catch(()=>{});
                    }
                } catch (err) {}
            }

            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN); const allAdmins = await Admin.find({});
            let typeLabel = 'فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = 'حساب بريد'; if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';
            const source = tx.companyName ? `🏢 الشركة: ${tx.companyName}\n👤 الموظف: ${tx.employeeName}` : `👤 العميل: ${tx.employeeName || 'فردي'}`;
            let accDetails = `📞 المحفظة/الرقم: <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>`; if (tx.accountName) accDetails += `\n👤 الاسم: ${tx.accountName}`;

            const msgText = `🔄 <b>تم سحب الطلب للإدارة (${typeLabel}):</b>\n${source}\n${accDetails}\n💵 المبلغ: ${tx.amount} EGP\n💰 التكلفة: ${tx.costLYD} LYD\n🧾 رقم الطلب: <code>${displayId}</code>`;
            const keyboard = { inline_keyboard: [[{ text: '🤖 تحويل لبوت تنفيذي', callback_data: `forward_${tx._id}` }], [{ text: '❌ إلغاء العملية', callback_data: `cancelReq_${tx._id}` }]]};

            let idUrl = null;
            if (tx.transferType === 'post_card' && tx.idCardImage) {
                try { let cToken = process.env.CLIENT_BOT_TOKEN; if (tx.clientBotId) { const comp = await ClientBot.findById(tx.clientBotId); if (comp) cToken = comp.token; } const tempApi = new Telegram(cToken); idUrl = (await tempApi.getFileLink(tx.idCardImage)).href; } catch(e){}
            }

            for (const admin of allAdmins) {
                if (admin.telegramId) {
                    let sentAdminMsg;
                    try {
                        if (idUrl) sentAdminMsg = await adminAPI.sendPhoto(admin.telegramId, { url: idUrl }, { caption: msgText, parse_mode: 'HTML', reply_markup: keyboard });
                        else sentAdminMsg = await adminAPI.sendMessage(admin.telegramId, msgText, { parse_mode: 'HTML', reply_markup: keyboard });
                        if (sentAdminMsg) tx.adminMessages.push({ telegramId: admin.telegramId, messageId: sentAdminMsg.message_id });
                    } catch(e) {}
                }
            }
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

        if (tx.executorBotId) {
            const execBot = await ExecutorBot.findById(tx.executorBotId);
            if (execBot) {
                const execAPI = new Telegram(execBot.token); const displayId = tx.customId || tx._id.toString();
                const teleMsg = `🚨🚨 <b>تـنـبـيـه طـارئ مـن الإدارة الـعـلـيـا (موقع الإدارة)</b> 🚨🚨\n\nالرجاء الإسراع في تنفيذ الطلب رقم <code>${displayId}</code> فوراً!\n\n💬 رسالة الإدارة: <b>${alertMsg}</b>`;
                if (tx.status === 'accepted' && tx.operatorId) execAPI.sendMessage(tx.operatorId, teleMsg, { parse_mode: 'HTML' }).catch(()=>{});
                else if (tx.status === 'processing') { const operators = await Employee.find({ botId: execBot._id, status: 'active' }); for (const op of operators) execAPI.sendMessage(op.telegramId, teleMsg, { parse_mode: 'HTML' }).catch(()=>{}); }
            }
        }
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

// ===============================================
// ⚙️ معالجة التسويات والتعديلات مدمجة بدفتر الأستاذ
// ===============================================
router.post('/transaction/:id/accept-deposit-web', async (req, res) => {
    try {
        const { imageBase64 } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.json({success: false, error: 'الطلب غير متاح'});

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, ""); const imageBuffer = Buffer.from(base64Data, 'base64');
        const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN); let fileId = null;
        try { const sentMsg = await adminAPI.sendPhoto(process.env.ADMIN_TELEGRAM_ID, { source: imageBuffer }, { caption: `✅ إيصال إيداع (مقبول) للطلب ${tx.customId}` }); fileId = sentMsg.photo[sentMsg.photo.length - 1].file_id; } catch(err) { return res.json({success: false, error: 'حدث خطأ أثناء رفع الصورة لتيليجرام'}); }

        tx.status = 'deposit'; tx.proofImage = fileId; tx.updatedAt = new Date();
        const execBot = await ExecutorBot.findById(tx.executorBotId);
        
        if (execBot) { 
            const execAPI = new Telegram(execBot.token); 
            await execAPI.sendPhoto(tx.operatorId, fileId, { caption: `✅ <b>تمت الموافقة على طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP`, parse_mode: 'HTML' }).catch(()=>{}); 
            
            await updateBalanceWithLedger('ExecutorBot', execBot._id, tx.amount, 'DEPOSIT', tx.customId, 'موافقة الإدارة على إيداع عهدة');
        }
        
        await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: 'success', text: `تم قبول طلب الإيداع بقيمة ${tx.amount} EGP وتمت إضافة الرصيد لحسابك بنجاح.`, imageUrl: `/proxy/image/${tx._id}/0` } } }, { strict: false });
        await tx.save(); 
        res.json({success: true});
    } catch(e) { res.json({success: false, error: e.message}); }
});

router.post('/transaction/:id/reject-deposit-web', async (req, res) => {
    try {
        const { reason } = req.body; const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'deposit_pending') return res.redirect('/transactions');

        tx.status = 'rejected'; tx.notes = `سبب الرفض: ${reason}`; tx.updatedAt = new Date();
        const execBot = await ExecutorBot.findById(tx.executorBotId);
        if (execBot) { const execAPI = new Telegram(execBot.token); await execAPI.sendMessage(tx.operatorId, `❌ <b>تم رفض طلب الإيداع!</b>\nالمبلغ: ${tx.amount} EGP\nالسبب: ${reason}`, { parse_mode: 'HTML' }).catch(()=>{}); }
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

        const oldCost = tx.costLYD || 0; const newCost = tx.amount / newRate; const diff = newCost - oldCost; 
        
        if (tx.clientBotId) { 
            await updateBalanceWithLedger('ClientBot', tx.clientBotId, -diff, 'ADJUSTMENT', tx.customId, `تعديل سعر الصرف لعملية إلى ${newRate}`);
        } else if (tx.userId) { 
            const user = await User.findOne({ telegramId: tx.userId }); 
            if (user) await updateBalanceWithLedger('User', user._id, -diff, 'ADJUSTMENT', tx.customId, `تعديل سعر الصرف لعملية إلى ${newRate}`);
        }

        const adminName = req.session.adminName || 'الإدارة';
        tx.costLYD = newCost; tx.exchangeRate = newRate;
        const oldRate = oldCost > 0 ? (tx.amount / oldCost).toFixed(3) : '0';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل السعر من ${oldRate} إلى ${newRate} بواسطة: ${adminName}]`;
        await tx.save(); res.redirect('/transactions'); 
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/edit-data', async (req, res) => {
    try {
        const txId = req.params.id; const newAmount = parseFloat(req.body.newAmount); const newDateStr = req.body.newDate;
        if (isNaN(newAmount) || newAmount <= 0 || !newDateStr) return res.redirect('/transactions');
        const tx = await Transaction.findById(req.params.id);
        if (!tx || ['rejected', 'cancelled_by_admin'].includes(tx.status)) return res.redirect('/transactions');

        const oldAmountEGP = tx.amount; const newDate = new Date(newDateStr); const adminName = req.session.adminName || 'الإدارة';

        if (tx.status === 'deposit' || tx.status === 'deduction') {
            const diffAmount = newAmount - oldAmountEGP; const diffDeposit = (tx.status === 'deposit') ? diffAmount : -diffAmount;
            if (tx.userId === 'admin' && tx.executorBotId) {
                await updateBalanceWithLedger('ExecutorBot', tx.executorBotId, diffDeposit, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الإيداع/الخصم`);
            } else {
                if (tx.clientBotId) { 
                    await updateBalanceWithLedger('ClientBot', tx.clientBotId, diffDeposit, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الإيداع/الخصم`);
                } else if (tx.userId) { 
                    const user = await User.findOne({ telegramId: tx.userId }); 
                    if (user) await updateBalanceWithLedger('User', user._id, diffDeposit, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الإيداع/الخصم`);
                }
            }
        } else {
            const oldCostLYD = tx.costLYD; const newCostLYD = parseFloat((newAmount / tx.exchangeRate).toFixed(3));
            const diffEGP = newAmount - oldAmountEGP; const diffLYD = newCostLYD - oldCostLYD;

            if (tx.clientBotId) { 
                await updateBalanceWithLedger('ClientBot', tx.clientBotId, -diffLYD, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الحوالة`);
            } else if (tx.userId) { 
                const user = await User.findOne({ telegramId: tx.userId }); 
                if (user) await updateBalanceWithLedger('User', user._id, -diffLYD, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الحوالة`);
            }

            if (tx.status === 'completed' && tx.executorBotId) {
                await updateBalanceWithLedger('ExecutorBot', tx.executorBotId, -diffEGP, 'ADJUSTMENT', tx.customId, `تعديل مبلغ الحوالة (منفذ)`);
            }
        }

        const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل (المبلغ: ${newAmount}، التاريخ: ${newDate.toLocaleString('en-GB')}) بواسطة: ${adminName}]`;
        await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, costLYD: tx.status==='deposit'||tx.status==='deduction'? 0 : newCostLYD, createdAt: newDate, updatedAt: newDate, notes: newNotes } }, { timestamps: false });

        if (['processing', 'accepted'].includes(tx.status) && tx.executorBotId) {
            try {
                const execBot = await ExecutorBot.findById(tx.executorBotId);
                if (execBot) {
                    const execAPI = new Telegram(execBot.token);
                    const alertMsg = `⚠️ <b>تنبيه من الإدارة:</b>\nتم تعديل بيانات الحوالة للطلب <code>${tx.customId}</code>\nالمبلغ القديم: <b>${oldAmountEGP} EGP</b>\nالمبلغ الجديد: <b>${newAmount} EGP</b>\nالرجاء الانتباه!`;
                    if (tx.status === 'accepted' && tx.operatorId) await execAPI.sendMessage(tx.operatorId, alertMsg, { parse_mode: 'HTML' }).catch(()=>{});
                    else if (tx.status === 'processing' && tx.broadcastMessages) for (const msg of tx.broadcastMessages) await execAPI.sendMessage(msg.telegramId, alertMsg, { parse_mode: 'HTML' }).catch(()=>{});
                }
            } catch(e) {}
        }
        res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/global-cancel', async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (tx) {
            if (tx.status === 'completed' || tx.status === 'processing' || tx.status === 'accepted' || tx.status === 'pending') {
                if (tx.clientBotId) await updateBalanceWithLedger('ClientBot', tx.clientBotId, tx.costLYD || 0, 'REFUND', tx.customId, 'حذف نهائي');
                else if (tx.userId) {
                    const user = await User.findOne({ telegramId: tx.userId });
                    if (user) await updateBalanceWithLedger('User', user._id, tx.costLYD || 0, 'REFUND', tx.customId, 'حذف نهائي');
                }
            }
            if (tx.status === 'completed' && tx.executorBotId) {
                await updateBalanceWithLedger('ExecutorBot', tx.executorBotId, tx.amount, 'REFUND', tx.customId, 'حذف نهائي (إرجاع للعهدة)');
            }
            
            await Transaction.findByIdAndDelete(tx._id);
        }
        res.redirect('/transactions');
    } catch (e) { res.redirect('/transactions'); }
});

router.post('/transaction/:id/change-bot', async (req, res) => {
    try {
        const txId = req.params.id; const newBotId = req.body.newBotId;
        if (!newBotId) return res.redirect('/transactions');
        const tx = await Transaction.findById(req.params.id);
        if (!tx || tx.status !== 'completed') return res.redirect('/transactions');
        if (tx.executorBotId && tx.executorBotId.toString() === newBotId.toString()) return res.redirect('/transactions');

        if (tx.executorBotId) { 
            await updateBalanceWithLedger('ExecutorBot', tx.executorBotId, tx.amount, 'REFUND', tx.customId, 'نقل محاسبي לבوت آخر');
        }
        
        const newBot = await ExecutorBot.findById(newBotId); let newManagerId = null;
        if (newBot) {
            await updateBalanceWithLedger('ExecutorBot', newBot._id, -tx.amount, 'TRANSFER', tx.customId, 'نقل محاسبي من بوت آخر');
            newManagerId = newBot.parentBotId || null;
        }

        tx.executorBotId = newBotId; tx.managerBotId = newManagerId; tx.executorBotName = newBot ? newBot.name : 'غير محدد';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم النقل محاسبياً إلى بوت: ${newBot ? newBot.name : 'غير معروف'}]`;
        await tx.save(); res.redirect('/transactions');
    } catch (error) { res.redirect('/transactions'); }
});

router.get('/executors', async (req, res) => {
    try {
        const bots = await ExecutorBot.find({}).sort({ createdAt: -1 });
        const botsWithStats = await Promise.all(bots.map(async (bot) => {
            let txCount = 0; 
            if (bot.isManagerBot) txCount = await Transaction.countDocuments({ managerBotId: bot._id, status: 'completed' }); 
            else txCount = await Transaction.countDocuments({ executorBotId: bot._id, status: 'completed' });
            return { ...bot._doc, balance: bot.balance, txCount };
        }));
        res.render('executors', { bots: botsWithStats, adminName: req.session.adminName });
    } catch (e) { res.redirect('/'); }
});

router.get('/executor/:id', async (req, res) => {
    try {
        const bot = await ExecutorBot.findById(req.params.id).populate('parentBotId');
        let queryFilter = bot.isManagerBot ? { managerBotId: bot._id } : { executorBotId: bot._id };
        const transactions = await Transaction.find(queryFilter).sort({ updatedAt: -1 }).limit(100);
        
        const managerBots = await ExecutorBot.find({ isManagerBot: true, status: 'active', _id: { $ne: bot._id } });

        if (bot.isApiBot) {
            const stats = {
                successCount: transactions.filter(t => t.status === 'completed').length,
                failedCount: transactions.filter(t => t.status === 'pending' && t.notes && t.notes.includes('فشل')).length,
            };
            return res.render('api_room', { bot, transactions, stats, managerBots, adminName: req.session.adminName });
        }

        res.render('executor_details', { bot, transactions, managerBots, adminName: req.session.adminName });
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/settle', async (req, res) => {
    try {
        const bot = await ExecutorBot.findById(req.params.id); const amount = parseFloat(req.body.amount); const notes = req.body.notes ? req.body.notes.trim() : ''; 
        let targetBotId = bot._id; let targetBotName = bot.name; let targetToken = bot.token;

        if (!bot.isManagerBot && bot.parentBotId) { targetBotId = bot.parentBotId; const parentBot = await ExecutorBot.findById(targetBotId); if (parentBot) { targetBotName = parentBot.name; targetToken = parentBot.token; } }
        
        if (!isNaN(amount) && amount !== 0) {
            const txId = `SETTLE-${Date.now().toString().slice(-6)}`;
            
            await updateBalanceWithLedger('ExecutorBot', targetBotId, amount, amount > 0 ? 'DEPOSIT' : 'DEDUCTION', txId, notes || 'تسوية نقدية');

            const tx = await Transaction.create({
                userId: 'admin', executorBotId: targetBotId, amount: Math.abs(amount), costLYD: 0, vodafoneNumber: 'تسديد حساب',
                status: amount > 0 ? 'deposit' : 'deduction', customId: txId, companyName: 'الإدارة المركزية', employeeName: amount > 0 ? 'تسديد نقدية (إيداع)' : 'خصم من المنفذ', executorName: targetBotName, notes: notes 
            });

            if (!bot.isApiBot) {
                const execAPI = new Telegram(targetToken); const emps = await Employee.find({ botId: targetBotId, status: 'active' });
                const actionType = amount > 0 ? 'إيداع نقدية/تسديد' : 'خصم من الرصيد'; const msgText = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 الطلب: <code>${tx.customId}</code>`;
                for(const e of emps) execAPI.sendMessage(e.telegramId, msgText, { parse_mode: 'HTML' }).catch(()=>{});
                await Transaction.updateOne({ _id: tx._id }, { $set: { executorWebAlert: { type: amount > 0 ? 'success' : 'error', text: msgText.replace(/\n/g, '<br>') } } }, { strict: false });
            }
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/link-manager', async (req, res) => {
    try {
        const botId = req.params.id; const parentId = req.body.parentBotId; const bot = await ExecutorBot.findById(botId);
        if (bot) { if (parentId === 'none') { bot.parentBotId = null; } else { bot.parentBotId = parentId; } await bot.save(); }
        res.redirect(`/executor/${botId}`);
    } catch (e) { res.redirect('/executors'); }
});

router.post('/executor/:id/toggle-status', async (req, res) => {
    try {
        const botId = req.params.id; const bot = await ExecutorBot.findById(botId); if (!bot) return res.redirect('/executors');
        bot.status = bot.status === 'active' ? 'paused' : 'active'; await bot.save();
        
        if (!bot.isApiBot) {
            try {
                const botEmployees = await Employee.find({ botId: bot._id, telegramId: { $exists: true, $ne: null } });
                if (botEmployees.length > 0 && bot.token) {
                    const botAPI = new Telegram(bot.token);
                    let message = bot.status === 'paused' ? `🔴 <b>إشعار إداري هام:</b>\n\nتم <b>إيقاف</b> هذا البوت مؤقتاً من قبل الإدارة المركزية.\nلا يمكنك استقبال أو تنفيذ أي عمليات حالياً حتى يتم تفعيله مجدداً.` : `🟢 <b>إشعار إداري:</b>\n\nتم <b>إعادة تشغيل وتفعيل</b> البوت بنجاح.\nيمكنك الآن استئناف عملك واستقبال الطلبات.`;
                    for (const emp of botEmployees) await botAPI.sendMessage(emp.telegramId, message, { parse_mode: 'HTML' }).catch(()=>{});
                }
            } catch (tgError) {}
        }
        res.redirect(`/executor/${bot._id}`);
    } catch (e) { res.redirect('/executors'); }
});

router.get('/clients', async (req, res) => {
    const users = await User.find({}).sort({ createdAt: -1 }); const companies = await ClientBot.find({}).sort({ createdAt: -1 });
    res.render('clients', { users, companies });
});

router.get('/user/:id', async (req, res) => {
    const user = await User.findById(req.params.id); const transactions = await Transaction.find({ userId: user.telegramId, clientBotId: null }).sort({ createdAt: -1 }).limit(50);
    res.render('user_details', { user, transactions });
});

router.get('/company/:id', async (req, res) => {
    const company = await ClientBot.findById(req.params.id); const transactions = await Transaction.find({ clientBotId: company._id }).sort({ createdAt: -1 }).limit(50);
    res.render('company_details', { company, transactions });
});

router.post('/user/:id/add-balance', async (req, res) => {
    try {
        const user = await User.findById(req.params.id); const amount = parseFloat(req.body.amount); const notes = req.body.notes ? req.body.notes.trim() : ''; 
        if (!isNaN(amount) && amount !== 0) {
            const txId = `DEP-${Date.now().toString().slice(-6)}`;
            
            await updateBalanceWithLedger('User', user._id, amount, amount > 0 ? 'DEPOSIT' : 'DEDUCTION', txId, notes || 'تسوية نقدية');

            const tx = await Transaction.create({ userId: user.telegramId, amount: Math.abs(amount), costLYD: 0, vodafoneNumber: '01000000000', status: amount > 0 ? 'deposit' : 'deduction', customId: txId, companyName: 'عميل فردي', employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)', notes: notes });
            const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد'; const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
            const mainAPI = new Telegram(process.env.CLIENT_BOT_TOKEN); mainAPI.sendMessage(user.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{});
        }
        res.redirect(`/user/${user._id}`);
    } catch (e) { res.redirect('/'); }
});

router.post('/user/:id/toggle-status', async (req, res) => {
    const user = await User.findById(req.params.id); user.status = user.status === 'active' ? 'banned' : 'active'; await user.save(); res.redirect(`/user/${user._id}`);
});

router.post('/user/:id/change-level', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/user/${req.params.id}`);
});

router.post('/user/:id/update-limit', async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await User.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/user/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

router.post('/company/:id/add-balance', async (req, res) => {
    try {
        const comp = await ClientBot.findById(req.params.id); const amount = parseFloat(req.body.amount); const notes = req.body.notes ? req.body.notes.trim() : '';
        if (!isNaN(amount) && amount !== 0) {
            const txId = `DEP-${Date.now().toString().slice(-6)}`;
            
            await updateBalanceWithLedger('ClientBot', comp._id, amount, amount > 0 ? 'DEPOSIT' : 'DEDUCTION', txId, notes || 'تسوية نقدية');

            const tx = await Transaction.create({ userId: 'admin', clientBotId: comp._id, amount: Math.abs(amount), costLYD: 0, vodafoneNumber: '01000000000', status: amount > 0 ? 'deposit' : 'deduction', customId: txId, companyName: comp.name, employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)', notes: notes });
            const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد'; const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
            const compAPI = new Telegram(comp.token); const emps = await ClientEmployee.find({ clientBotId: comp._id, status: 'active' }); for(const emp of emps) compAPI.sendMessage(emp.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{});
        }
        res.redirect(`/company/${comp._id}`);
    } catch (e) { res.redirect('/'); }
});

router.post('/company/:id/update-rate', async (req, res) => {
    try { 
        const rate = Math.abs(parseFloat(req.body.exchangeRate) || 0); 
        await ClientBot.findByIdAndUpdate(req.params.id, { exchangeRate: rate }, { strict: false }); 
        res.redirect(`/company/${req.params.id}`); 
    } catch (e) { res.redirect('/clients'); }
});

router.post('/company/:id/toggle-status', async (req, res) => {
    const comp = await ClientBot.findById(req.params.id); comp.status = comp.status === 'active' ? 'inactive' : 'active'; await comp.save(); res.redirect(`/company/${comp._id}`);
});

router.post('/company/:id/change-level', async (req, res) => {
    await ClientBot.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/company/${req.params.id}`);
});

router.post('/company/:id/update-limit', async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await ClientBot.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/company/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

module.exports = router;