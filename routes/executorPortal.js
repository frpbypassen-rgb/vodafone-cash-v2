const express = require('express');
const router = express.Router();
const axios = require('axios'); 
const { Telegram } = require('telegraf');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const ExecutorBot = require('../models/ExecutorBot');
const User = require('../models/User');
const ClientBot = require('../models/ClientBot');
const ClientEmployee = require('../models/ClientEmployee');
const Admin = require('../models/Admin');
const SupportTicket = require('../models/SupportTicket'); 
const { updateClientTracking } = require('../services/clientTrackingService');

// 🟢 التأكد من وجود مجلد الصور
const uploadDir = path.join(process.cwd(), 'uploads', 'proofs');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const requireExecutorAuth = (req, res, next) => {
    if (req.session.isExecutorLoggedIn && req.session.executorId) return next();
    res.redirect('/executor-portal/login');
};

const notifyAdmins = async (message) => {
    try {
        const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
        const admins = await Admin.find({});
        for (const admin of admins) {
            if (admin.telegramId) await adminAPI.sendMessage(admin.telegramId, message, { parse_mode: 'HTML' }).catch(()=>{});
        }
    } catch (e) {}
};

// ===============================================
// ⚡ نظام تسجيل دخول المنفذين
// ===============================================
router.get('/login', (req, res) => {
    if (req.session.isExecutorLoggedIn) return res.redirect('/executor-portal/dashboard');
    res.render('executor/login', { error: null });
});

router.post('/login', async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) return res.render('executor/login', { error: 'يرجى إدخال البيانات.' });

        const safeUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');
        const todayStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });

        const executor = await Employee.findOne({ 
            $or: [{ webUsername: usernameRegex }, { phone: username }]
        }).populate('botId').lean();

        if (executor) {
            let isMatch = false;
            if (executor.webPassword && executor.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, executor.webPassword);
            } else {
                isMatch = (password === executor.webPassword);
                if (isMatch) await Employee.updateOne({ _id: executor._id }, { webPassword: await bcrypt.hash(password, 12) });
            }

            if (isMatch) {
                if (executor.status !== 'active') return res.render('executor/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });

                if (executor.lastOtpDate === todayStr) {
                    req.session.isExecutorLoggedIn = true; req.session.executorId = executor._id; req.session.executorBotId = executor.botId ? executor.botId._id : null;
                    return req.session.save(() => res.redirect('/executor-portal/dashboard')); 
                }

                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                const otpExpires = new Date(Date.now() + 5 * 60000);
                
                await Employee.updateOne({ _id: executor._id }, { $set: { otpCode: otp, otpExpires: otpExpires } }, { strict: false });

                if (executor.botId && executor.botId.token && executor.telegramId) {
                    const execAPI = new Telegram(executor.botId.token);
                    execAPI.sendMessage(executor.telegramId, `🔐 <b>رمز تأكيد الدخول لغرفة العمليات:</b>\n\nكود التحقق الخاص بك هو:\n<code>${otp}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
                }

                req.session.tempExecutorId = executor._id;
                return req.session.save(() => res.redirect('/executor-portal/verify')); 
            }
        }

        return res.render('executor/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    } catch (e) {
        console.error(e);
        res.render('executor/login', { error: 'حدث خطأ في النظام.' });
    }
});

router.get('/verify', (req, res) => {
    if (!req.session.tempExecutorId) return res.redirect('/executor-portal/login');
    res.render('executor/verify', { error: null });
});

router.post('/verify', async (req, res) => {
    try {
        const { otp } = req.body;
        const account = await Employee.findById(req.session.tempExecutorId).lean();
        
        if (!account || account.otpCode !== otp?.trim() || new Date(account.otpExpires) < new Date()) {
            return res.render('executor/verify', { error: 'الرمز غير صحيح أو انتهت صلاحيته.' });
        }

        const todayStr = new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' });
        await Employee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false });

        req.session.isExecutorLoggedIn = true; req.session.executorId = account._id; req.session.executorBotId = account.botId;
        req.session.tempExecutorId = null;
        res.redirect('/executor-portal/dashboard');
    } catch (e) { res.redirect('/executor-portal/login'); }
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/executor-portal/login'); });

// ===============================================
// 🖼️ عرض صور الإثباتات (Proxy API) للموظفين 🚀
// ===============================================
router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireExecutorAuth, async (req, res) => {
    try {
        // 🟢 استخدام .lean() ضروري لجلب كل الحقول
        const tx = await Transaction.findById(req.params.id).lean();
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const emp = await Employee.findById(req.session.executorId);
        if (!emp || (tx.executorBotId && tx.executorBotId.toString() !== emp.botId.toString() && (!tx.managerBotId || tx.managerBotId.toString() !== emp.botId.toString()))) {
             return res.status(403).send('غير مصرح لك بعرض هذه الصورة');
        }

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) photoId = tx.proofImages[index];
        else if (tx.proofImage && index === 0) photoId = tx.proofImage; 

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        // 1️⃣ الحل النهائي القاطع: إذا كان النص يبدأ بـ /uploads إذن هو ملف في السيرفر!
        if (photoId.startsWith('/uploads') || (tx.localProofImage && tx.localProofImage.startsWith('/uploads'))) {
            const targetPath = photoId.startsWith('/uploads') ? photoId : tx.localProofImage;
            const fullPath = path.join(process.cwd(), targetPath);
            
            if (fs.existsSync(fullPath)) {
                res.set('Cache-Control', 'public, max-age=31536000');
                return res.sendFile(fullPath);
            }
        }

        if (photoId.startsWith('data:image')) {
            const base64Data = photoId.replace(/^data:image\/\w+;base64,/, "");
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(base64Data, 'base64'));
        }

        if (photoId.startsWith('http')) {
            const response = await axios.get(photoId, { responseType: 'arraybuffer' });
            res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
            return res.send(Buffer.from(response.data));
        }

        let tokensToTry = [];
        if (tx.executorBotId) { const execBot = await ExecutorBot.findById(tx.executorBotId); if (execBot && execBot.token) tokensToTry.push(execBot.token); }
        if (process.env.ADMIN_BOT_TOKEN) tokensToTry.push(process.env.ADMIN_BOT_TOKEN);
        if (process.env.CLIENT_BOT_TOKEN) tokensToTry.push(process.env.CLIENT_BOT_TOKEN);

        let fileLink = null;
        for (const token of [...new Set(tokensToTry)]) {
            try { const api = new Telegram(token); const link = await api.getFileLink(photoId); if (link && link.href) { fileLink = link.href; break; } } catch(e) {}
        }

        if (!fileLink) return res.status(404).send('لا يمكن الوصول للصورة');

        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
        res.set('Content-Type', 'image/jpeg'); res.set('Cache-Control', 'public, max-age=31536000');
        return res.send(Buffer.from(response.data));

    } catch (error) {
        console.error('[Executor Proxy Error]:', error.message);
        res.status(500).send('خطأ داخلي في الخادم');
    }
});

router.get('/dashboard', requireExecutorAuth, async (req, res) => {
    const emp = await Employee.findById(req.session.executorId).populate('botId');
    res.render('executor/dashboard', { emp });
});

router.get('/api/live-tasks', requireExecutorAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId);
        const filter = { $or: [ { executorBotId: emp.botId }, { managerBotId: emp.botId } ], status: { $in: ['processing', 'accepted'] } };
        const tasks = await Transaction.find(filter).sort({ createdAt: 1 }).lean();
        const busyOperators = await Transaction.distinct('operatorId', { $or: [ { executorBotId: emp.botId }, { managerBotId: emp.botId } ], status: 'accepted', operatorId: { $ne: null } });

        const now = Date.now();
        for (let tx of tasks) {
            if (tx.status === 'processing' && !tx.autoAlertFired) {
                const diffMs = now - new Date(tx.createdAt).getTime();
                if (diffMs >= 120000) { 
                    const alertMsg = 'تأخير استجابة! الطلب تخطى 120 ثانية ولم يقبله أحد، يرجى سحبه فوراً!';
                    const updatedTx = await Transaction.findOneAndUpdate({ _id: tx._id, autoAlertFired: { $ne: true } }, { $set: { emergencyAlert: alertMsg, autoAlertFired: true } }, { new: true, strict: false } );
                    if (updatedTx) {
                        try {
                            const execBot = await ExecutorBot.findById(emp.botId);
                            if (execBot) {
                                const execAPI = new Telegram(execBot.token);
                                const displayId = tx.customId || tx._id.toString();
                                const teleMsg = `🚨🚨 <b>تـنـبـيـه طـارئ آلـي (تأخير استجابة)</b> 🚨🚨\n\nالطلب رقم <code>${displayId}</code> تخطى 120 ثانية في الانتظار ولم يقبله أي موظف!\n\nالرجاء الدخول للموقع وسحب الطلب فوراً!`;
                                const operators = await Employee.find({ botId: execBot._id, status: 'active' });
                                for (const op of operators) { if (!busyOperators.includes(op.telegramId)) execAPI.sendMessage(op.telegramId, teleMsg, { parse_mode: 'HTML' }).catch(()=>{}); }
                            }
                        } catch(e) {}
                    }
                }
            }
        }

        const alerts = await Transaction.find({ $or: [ { executorBotId: emp.botId }, { managerBotId: emp.botId } ], emergencyAlert: { $exists: true, $ne: null }, status: { $in: ['processing', 'accepted'] } }).lean(); 
        const depAlerts = await Transaction.find({ $or: [ { operatorId: emp.telegramId }, { executorBotId: emp.botId }, { managerBotId: emp.botId } ], executorWebAlert: { $exists: true, $ne: null } }).lean();

        res.json({ tasks, alerts, depAlerts });
    } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/clear-alert/:id', requireExecutorAuth, async (req, res) => { try { await Transaction.updateOne({ _id: req.params.id }, { $unset: { emergencyAlert: 1 } }, { strict: false }); res.json({ success: true }); } catch (e) { res.json({ success: false }); } });
router.post('/api/clear-dep-alert/:id', requireExecutorAuth, async (req, res) => { try { await Transaction.updateOne({ _id: req.params.id }, { $unset: { executorWebAlert: 1 } }, { strict: false }); res.json({ success: true }); } catch (e) { res.json({ success: false }); } });

router.post('/api/request-deposit', requireExecutorAuth, async (req, res) => {
    try {
        const { amount } = req.body; const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.json({ success: false, error: 'مبلغ غير صالح' });

        const emp = await Employee.findById(req.session.executorId).populate('botId');
        const tx = await Transaction.create({ userId: 'admin', executorBotId: emp.botId._id, operatorId: emp.telegramId, amount: parsedAmount, costLYD: 0, vodafoneNumber: 'طلب إيداع', status: 'deposit_pending', customId: `DEPREQ-${Date.now().toString().slice(-6)}`, companyName: 'طلب إيداع من منفذ', employeeName: emp.name, executorName: emp.name });

        const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN); const admins = await Admin.find({});
        const keyboard = { inline_keyboard: [ [{ text: '✅ قبول وإرفاق إيصال', callback_data: `dep_accept_${tx._id}` }], [{ text: '❌ رفض الطلب', callback_data: `dep_reject_${tx._id}` }] ]};
        const msgText = `📥 <b>طلب إيداع نقدية جديد!</b>\n👤 المنفذ: ${emp.name}\n🤖 البوت: ${emp.botId.name}\n💵 المبلغ المطلوب: <b>${parsedAmount} EGP</b>\n🧾 رقم: <code>${tx.customId}</code>\n\nيمكنك الرد من هنا أو من لوحة تحكم الموقع.`;
        
        for (const admin of admins) { if (admin.telegramId) await adminAPI.sendMessage(admin.telegramId, msgText, { parse_mode: 'HTML', reply_markup: keyboard }).catch(()=>{}); }
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/accept-task/:id', requireExecutorAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('botId');
        const tx = await Transaction.findOneAndUpdate({ _id: req.params.id, status: 'processing' }, { $set: { status: 'accepted', operatorId: emp.telegramId, executorName: emp.name, emergencyAlert: undefined } }, { new: true });
        if (!tx) return res.json({ success: false, error: 'تم قبول الطلب مسبقاً من زميل آخر أو لم يعد متاحاً' });

        if (tx.broadcastMessages && tx.broadcastMessages.length > 0) {
            const execBotAPI = new Telegram(emp.botId.token);
            let typeLabel = '📱 فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = '📮 حساب بريد'; if(tx.transferType === 'post_card') typeLabel = '💳 بطاقة عميل';
            const msgText = `🔒 <b>تم سحب المهمة (${typeLabel})</b>\n\n📞 الرقم/الحساب: <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 المبلغ: ${tx.amount} EGP\n🧾 الطلب: <code>${tx.customId || tx._id}</code>\n\n👨‍💻 <b>تم الاستلام بواسطة:</b> ${emp.name}`;
            
            for (const msg of tx.broadcastMessages) {
                try {
                    if (tx.transferType === 'post_card' && tx.idCardImage) await execBotAPI.editMessageCaption(msg.telegramId, msg.messageId, undefined, msgText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                    else await execBotAPI.editMessageText(msg.telegramId, msg.messageId, undefined, msgText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
                } catch(e) {}
            }
        }
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
});

// ===============================================
// 🚀 استلام وإنهاء الطلب (وحفظ الصورة بالهارد ديسك)
// ===============================================
router.post('/api/complete-task/:id', requireExecutorAuth, async (req, res) => {
    try {
        const { imageBase64, imagesBase64, senderPhone } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId).populate('botId');

        if (!tx) return res.json({ success: false, error: 'الطلب غير موجود' });

        let imagesArray = [];
        if (imagesBase64 && Array.isArray(imagesBase64) && imagesBase64.length > 0) imagesArray = imagesBase64;
        else if (imageBase64) imagesArray = [imageBase64]; 

        if (imagesArray.length === 0) return res.json({ success: false, error: 'يرجى إرفاق صورة الإثبات' });

        const base64String = imagesArray[0];
        const photoBuffer = Buffer.from(base64String.replace(/^data:image\/\w+;base64,/, ""), 'base64');

        // 1️⃣ حفظ الملف في الهارد ديسك
        const fileName = `proof_${tx._id}_${Date.now()}.jpg`;
        const localImagePath = `/uploads/proofs/${fileName}`;
        fs.writeFileSync(path.join(uploadDir, fileName), photoBuffer);

        if (emp.botId.parentBotId) await ExecutorBot.findByIdAndUpdate(emp.botId.parentBotId, { $inc: { balance: -tx.amount } });
        await ExecutorBot.findByIdAndUpdate(emp.botId._id, { $inc: { balance: -tx.amount } });

        let typeLabel = 'فودافون كاش'; if(tx.transferType === 'post_account') typeLabel = 'حساب بريد'; if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';
        let senderPhoneDisplay = '';
        if (senderPhone && senderPhone.trim() !== '') {
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[رقم المحول: ${senderPhone.trim()}]`;
            senderPhoneDisplay = `\n📞 <b>رقم المُرسل:</b> <code>${senderPhone.trim()}</code>`;
        }

        let originalNote = tx.notes ? tx.notes.split('\n[')[0].split('\n---')[0].trim() : '';
        let noteText = originalNote ? `\n📝 <b>ملاحظة العميل:</b> ${originalNote}` : '';
        let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
        if (tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

        tx.status = 'completed'; 
        tx.proofImage = localImagePath; // 🟢 الحفظ بالهارد ديسك
        tx.proofImages = [localImagePath];
        tx.set('localProofImage', localImagePath, { strict: false });
        tx.updatedAt = new Date();
        await tx.save();

        const adminMsgCaption = `✅ <b>تم تنفيذ طلب تحويل (${typeLabel}) بنجاح!</b>\n\n🧾 <b>الطلب:</b> <code>${tx.customId || tx._id}</code>\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD\n👨‍💻 <b>المنفذ:</b> ${emp.name}\n🤖 <b>البوت:</b> ${emp.botId.name}${senderPhoneDisplay}${noteText}`;
        
        try {
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            const admins = await Admin.find({});
            for (const admin of admins) {
                if (admin.telegramId) await adminAPI.sendPhoto(admin.telegramId, { source: photoBuffer }, { caption: adminMsgCaption, parse_mode: 'HTML' }).catch(()=>{});
            }
        } catch (e) {}

        const { updateClientTracking } = require('../services/clientTrackingService');
        await updateClientTracking(tx._id, 'completed', '', photoBuffer);

        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/edit-amount/:id', requireExecutorAuth, async (req, res) => {
    try {
        const { newAmount, reason } = req.body;
        const emp = await Employee.findById(req.session.executorId);

        const tx = await Transaction.findOne({ _id: req.params.id, status: 'accepted', operatorId: emp.telegramId });
        if (!tx) return res.json({ success: false, error: 'العملية غير صالحة أو لا تملك صلاحية تعديلها' });

        const parsedAmount = parseFloat(newAmount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.json({ success: false, error: 'مبلغ غير صالح' });

        const oldAmount = tx.amount || 0;
        const oldCost = tx.costLYD || 0;
        const actualRate = tx.exchangeRate || (oldAmount / oldCost);
        const newCost = parseFloat((parsedAmount / actualRate).toFixed(3));
        const diffCost = newCost - oldCost; 

        if (tx.clientBotId) {
            const comp = await ClientBot.findById(tx.clientBotId);
            if (diffCost > 0) {
                const updated = await ClientBot.findOneAndUpdate( { _id: tx.clientBotId, balance: { $gte: diffCost - (comp.creditLimit || 0) } }, { $inc: { balance: -diffCost } }, { new: true } );
                if (!updated) return res.json({ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' });
            } else if (diffCost < 0) { await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: Math.abs(diffCost) } }); }
        } else if (tx.userId) {
            const user = await User.findOne({ telegramId: tx.userId });
            if (diffCost > 0) {
                const updated = await User.findOneAndUpdate( { telegramId: tx.userId, balance: { $gte: diffCost - (user.creditLimit || 0) } }, { $inc: { balance: -diffCost } }, { new: true } );
                if (!updated) return res.json({ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' });
            } else if (diffCost < 0) { await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: Math.abs(diffCost) } }); }
        }

        tx.amount = parsedAmount; tx.costLYD = newCost;
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تعديل المبلغ من ${oldAmount} إلى ${parsedAmount} | السبب: ${reason}]`;
        await tx.save();
        
        notifyAdmins(`⚠️ <b>تعديل مبلغ حوالة من المنفذ!</b>\n🧾 رقم: <code>${tx.customId}</code>\n💵 المبلغ: <b>${parsedAmount} EGP</b>\n📝 السبب: ${reason}`);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/cancel-task/:id', requireExecutorAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId);

        if (tx && tx.status === 'accepted' && tx.operatorId === emp.telegramId) {
            if (tx.clientBotId) await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: tx.costLYD } });
            else if (tx.userId) await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.costLYD } });

            tx.status = 'rejected';
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`;
            await tx.save();

            const { updateClientTracking } = require('../services/clientTrackingService');
            await updateClientTracking(tx._id, 'rejected', reason);

            const adminMsg = `🚨 <b>تنبيه للإدارة: تم إلغاء عملية من قِبل المنفذ!</b>\n\n🏢 <b>الجهة/العميل:</b> ${tx.companyName || 'عميل فردي'}\n👤 <b>الموظف الطالب:</b> ${tx.employeeName || 'غير محدد'}\n🤖 <b>بواسطة المنفذ:</b> ${emp.name}\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة المسترجعة:</b> ${tx.costLYD.toFixed(2)} LYD\n⚠️ <b>سبب الإلغاء:</b> <b>${reason}</b>`;
            notifyAdmins(adminMsg);
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'العملية غير صالحة' });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/return-task/:id', requireExecutorAuth, async (req, res) => {
    try {
        const { reason } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId);

        if (tx && tx.status === 'accepted' && tx.operatorId === emp.telegramId) {
            tx.status = 'pending'; tx.executorBotId = undefined; tx.managerBotId = undefined;
            tx.executorName = undefined; tx.operatorId = undefined; tx.broadcastMessages = [];
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[إرجاع للإدارة | السبب: ${reason}]`;
            await tx.save();

            const { updateClientTracking } = require('../services/clientTrackingService');
            await updateClientTracking(tx._id, 'pending');

            return res.json({ success: true });
        }
        res.json({ success: false, error: 'العملية غير صالحة' });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

router.get('/reports', requireExecutorAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('botId');
        let targetDate = req.query.date; let showMonth = req.query.month === 'true'; let search = req.query.search ? req.query.search.trim() : ''; let dateLabel = '';
        let filter = { $or: [ { executorBotId: emp.botId._id }, { managerBotId: emp.botId._id } ] }; let start, end;

        if (showMonth) {
            const now = new Date(); start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
            dateLabel = `شهر ${now.getMonth() + 1} لعام ${now.getFullYear()}`; targetDate = '';
        } else if (targetDate) {
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`); dateLabel = targetDate;
        } else if (!search) {
            const today = new Date(); targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`); dateLabel = targetDate;
        } else { targetDate = ''; dateLabel = 'نتائج البحث'; }

        if (start && end) filter.updatedAt = { $gte: start, $lte: end };
        filter.status = { $in: ['completed', 'deposit', 'deduction'] };
        if (search) filter.$and = [ { $or: [ { customId: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { accountNumber: { $regex: search, $options: 'i' } } ] } ];

        const allPeriodTxs = await Transaction.find(filter).sort({ updatedAt: 1 }).lean(); 

        let openingBalance = 0;
        if (start) {
            const txsBefore = await Transaction.find({ $or: [ { executorBotId: emp.botId._id }, { managerBotId: emp.botId._id } ], status: { $in: ['completed', 'deposit', 'deduction'] }, updatedAt: { $lt: start } }).lean();
            txsBefore.forEach(tx => {
                if (tx.status === 'completed') openingBalance -= (tx.amount || 0); else if (tx.status === 'deposit') openingBalance += (tx.amount || 0); else if (tx.status === 'deduction') openingBalance -= Math.abs(tx.amount || 0);
            });
        }

        let totalCompleted = 0; let totalSettle = 0; let totalDeduction = 0; let groupedDaysArray = [];
        
        if (showMonth && !search) {
            const daysMap = {}; let currentRunningBalance = openingBalance;
            allPeriodTxs.forEach(tx => {
                if (tx.status === 'completed') totalCompleted += (tx.amount || 0); else if (tx.status === 'deposit') totalSettle += (tx.amount || 0); else if (tx.status === 'deduction') totalDeduction += Math.abs(tx.amount || 0);
                const d = new Date(tx.updatedAt); const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tripoli' }).format(d);
                if (!daysMap[dateStr]) { daysMap[dateStr] = { dateStr: dateStr, displayDate: new Intl.DateTimeFormat('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Africa/Tripoli' }).format(d), transactions: [], totalCompleted: 0, totalSettle: 0, totalDeduction: 0, execCount: 0 }; }
                daysMap[dateStr].transactions.push(tx);
                if (tx.status === 'completed') { daysMap[dateStr].totalCompleted += (tx.amount || 0); daysMap[dateStr].execCount++; } else if (tx.status === 'deposit') { daysMap[dateStr].totalSettle += (tx.amount || 0); } else if (tx.status === 'deduction') { daysMap[dateStr].totalDeduction += Math.abs(tx.amount || 0); }
            });

            const sortedDates = Object.keys(daysMap).sort(); 
            sortedDates.forEach(date => {
                let day = daysMap[date]; day.openingBalance = currentRunningBalance; day.closingBalance = currentRunningBalance + day.totalSettle - day.totalCompleted - day.totalDeduction; currentRunningBalance = day.closingBalance; 
                day.transactions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); groupedDaysArray.push(day);
            });
            groupedDaysArray.reverse(); 
        } else {
            allPeriodTxs.forEach(t => { if (t.status === 'completed') totalCompleted += t.amount || 0; else if (t.status === 'deposit') totalSettle += t.amount || 0; else if (t.status === 'deduction') totalDeduction += Math.abs(t.amount || 0); });
            allPeriodTxs.reverse(); 
        }

        const closingBalance = openingBalance + totalSettle - totalCompleted - totalDeduction;

        res.render('executor/reports', { emp, transactions: allPeriodTxs, targetDate, dateLabel, showMonth, search, totalCompleted, totalSettle, totalDeduction, closingBalance, openingBalance, groupedDaysArray });
    } catch (e) { res.redirect('/executor-portal/dashboard'); }
});

router.get('/support', requireExecutorAuth, async (req, res) => {
    try { const emp = await Employee.findById(req.session.executorId).populate('botId'); res.render('executor/support', { emp }); } catch(e) { res.redirect('/executor-portal/dashboard'); }
});

router.get('/api/support/messages', requireExecutorAuth, async (req, res) => {
    try { const emp = await Employee.findById(req.session.executorId); let ticket = await SupportTicket.findOne({ telegramId: emp.telegramId }).sort({ createdAt: -1 }); if (ticket) { ticket.unreadUser = 0; await ticket.save(); res.json({ success: true, messages: ticket.messages, status: ticket.status }); } else { res.json({ success: true, messages: [], status: 'closed' }); } } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/support/messages', requireExecutorAuth, async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        if (!text && !imageBase64) return res.json({ success: false, error: 'الرسالة فارغة' });

        const emp = await Employee.findById(req.session.executorId).populate('botId');
        let ticket = await SupportTicket.findOne({ telegramId: emp.telegramId, status: { $ne: 'closed' } });

        if (!ticket) {
            ticket = new SupportTicket({ entityType: 'executor', entityId: emp._id, telegramId: emp.telegramId, name: emp.name || 'منفذ', phone: emp.phone || 'غير مسجل', botToken: emp.botId ? emp.botId.token : process.env.CLIENT_BOT_TOKEN, messages: [] });
        }

        const newMsg = { sender: 'user', text: text || '', imageUrl: imageBase64 || '', createdAt: new Date() };
        ticket.messages.push(newMsg); ticket.status = 'open'; ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1; await ticket.save();

        const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
        const admins = await Admin.find({});
        const notifyMsg = `🚨 <b>رسالة دعم فني (ويب التنفيذ)!</b>\n\n👤 من: ${emp.name}\n💬 الرسالة: ${text || 'صورة مرفقة'}\n\nيرجى مراجعة لوحة التحكم للرد.`;

        for (const admin of admins) {
            if (imageBase64) {
                const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
                await adminAPI.sendPhoto(admin.telegramId, { source: buffer }, { caption: notifyMsg, parse_mode: 'HTML' }).catch(()=>{});
            } else { await adminAPI.sendMessage(admin.telegramId, notifyMsg, { parse_mode: 'HTML' }).catch(()=>{}); }
        }
        res.json({ success: true, message: newMsg });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;