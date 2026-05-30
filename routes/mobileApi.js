// routes/mobileApi.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { Telegram } = require('telegraf');
const axios = require('axios');

const User = require('../models/User');
const ClientBot = require('../models/ClientBot');
const ClientEmployee = require('../models/ClientEmployee');
const ExecutorBot = require('../models/ExecutorBot');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');

const { updateBalanceWithLedger } = require('../services/walletService');
const apiTransferQueue = require('../services/queueService');

const JWT_SECRET = process.env.JWT_SECRET || 'ahram-mobile-super-secret-key-2026';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'ahram-mobile-refresh-secret-key-2026';

// ==========================================
// 🛠️ Helper: توحيد صيغة الأخطاء والردود
// ==========================================
const sendError = (res, statusCode, code, message) => {
    return res.status(statusCode).json({ success: false, code, message });
};

const sendSuccess = (res, data) => {
    return res.status(200).json({ success: true, ...data });
};

// ==========================================
// 🔐 Middleware: حماية المسارات
// ==========================================
const requireMobileAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return sendError(res, 401, 'TOKEN_MISSING', 'توكن المصادقة مفقود.');

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        
        let account = null;
        if (decoded.accountType === 'client_user') account = await User.findById(decoded.id);
        else if (decoded.accountType === 'client_company') account = await ClientEmployee.findById(decoded.id);
        else if (decoded.accountType === 'executor') account = await Employee.findById(decoded.id);

        if (!account) return sendError(res, 401, 'TOKEN_INVALID', 'الحساب غير موجود.');
        if (account.status !== 'active') return sendError(res, 403, 'ACCOUNT_BANNED', 'هذا الحساب محظور أو غير مفعل.');

        req.user = { id: account._id, accountType: decoded.accountType, ...account._doc };
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') return sendError(res, 401, 'TOKEN_EXPIRED', 'انتهت صلاحية الجلسة.');
        return sendError(res, 401, 'TOKEN_INVALID', 'توكن غير صالح.');
    }
};

// ==========================================
// 🚀 Authentication Routes
// ==========================================

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return sendError(res, 400, 'MISSING_DATA', 'يرجى إرسال اسم المستخدم وكلمة المرور.');

        const safeUsername = username.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');

        let account = null;
        let accountType = '';
        let balance = 0;

        // فحص العملاء
        account = await User.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username.trim() }] }).lean();
        if (account) { accountType = 'client_user'; balance = account.balance; }
        
        // فحص الشركات
        if (!account) {
            account = await ClientEmployee.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username.trim() }] }).lean();
            if (account) {
                accountType = 'client_company';
                const comp = await ClientBot.findById(account.clientBotId).lean();
                balance = comp ? comp.balance : 0;
            }
        }

        // فحص المنفذين
        if (!account) {
            account = await Employee.findOne({ phone: username.trim() }).lean();
            if (account) accountType = 'executor';
        }

        if (!account) return sendError(res, 401, 'INVALID_CREDENTIALS', 'بيانات الدخول غير صحيحة.');

        let isMatch = false;
        if (accountType === 'executor') {
            isMatch = (password === account.phone); 
        } else {
            if (account.webPassword && account.webPassword.startsWith('$2')) {
                isMatch = await bcrypt.compare(password, account.webPassword);
            } else {
                isMatch = (password === account.webPassword);
            }
        }

        if (!isMatch) return sendError(res, 401, 'INVALID_CREDENTIALS', 'بيانات الدخول غير صحيحة.');
        if (account.status !== 'active') return sendError(res, 403, 'ACCOUNT_BANNED', 'حسابك معلق حالياً.');

        const payload = { id: account._id, accountType };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
        const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '30d' });

        return sendSuccess(res, {
            token,
            refreshToken,
            accountType,
            id: account._id,
            name: account.name,
            balance: accountType === 'executor' ? 0 : balance,
            expiresIn: 12 * 3600
        });

    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'خطأ داخلي في الخادم.');
    }
});

router.post('/refresh-token', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return sendError(res, 400, 'TOKEN_MISSING', 'يرجى إرسال الـ Refresh Token.');

        const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
        const payload = { id: decoded.id, accountType: decoded.accountType };
        
        const newToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
        
        return sendSuccess(res, {
            token: newToken,
            refreshToken: refreshToken, // يظل القديم صالحاً حتى تنتهي الـ 30 يوم
            expiresIn: 12 * 3600
        });
    } catch (e) {
        return sendError(res, 401, 'SESSION_REVOKED', 'انتهت صلاحية الـ Refresh Token. يرجى تسجيل الدخول مجدداً.');
    }
});

router.post('/logout', requireMobileAuth, (req, res) => {
    // في الـ JWT يتم مسح التوكن من جهة الموبايل
    return sendSuccess(res, { message: 'تم تسجيل الخروج بنجاح.' });
});

// ==========================================
// 💼 Client Routes (العملاء)
// ==========================================

router.post('/client/exchange-rate', requireMobileAuth, async (req, res) => {
    try {
        if (req.user.accountType === 'executor') return sendError(res, 403, 'FORBIDDEN', 'غير مصرح.');

        const set = await Settings.findOne({}) || {};
        let rate = set.rateLevel1;
        let balance = 0;

        if (req.user.accountType === 'client_user') {
            rate = req.user.tier === 3 ? set.rateLevel3 : (req.user.tier === 2 ? set.rateLevel2 : set.rateLevel1);
            balance = req.user.balance;
        } else if (req.user.accountType === 'client_company') {
            const comp = await ClientBot.findById(req.user.clientBotId);
            if (comp) {
                rate = comp.tier === 3 ? set.rateLevel3 : (comp.tier === 2 ? set.rateLevel2 : set.rateLevel1);
                balance = comp.balance;
            }
        }

        return sendSuccess(res, { exchangeRate: rate, balance });
    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'خطأ في جلب البيانات.');
    }
});

router.post('/client/transactions', requireMobileAuth, async (req, res) => {
    try {
        if (req.user.accountType === 'executor') return sendError(res, 403, 'FORBIDDEN', 'غير مصرح.');

        const page = parseInt(req.body.page) || 1;
        const limit = parseInt(req.body.limit) || 20;
        const skip = (page - 1) * limit;

        let filter = {};
        if (req.user.accountType === 'client_user') filter = { userId: req.user.telegramId, clientBotId: null };
        else if (req.user.accountType === 'client_company') filter = { clientBotId: req.user.clientBotId };

        const total = await Transaction.countDocuments(filter);
        const transactions = await Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

        return sendSuccess(res, {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore: skip + transactions.length < total,
            transactions
        });
    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'خطأ في جلب العمليات.');
    }
});

router.post('/client/new-transfer', requireMobileAuth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        if (req.user.accountType === 'executor') throw new Error('FORBIDDEN');

        // 🟢 تطبيق الـ Idempotency Key لمنع التكرار
        const idempotencyKey = req.headers['idempotency-key'];
        if (!idempotencyKey) throw new Error('MISSING_IDEMPOTENCY');

        const existingTx = await Transaction.findOne({ idempotencyKey }).session(session);
        if (existingTx) {
            await session.abortTransaction();
            session.endSession();
            // 🟢 إرجاع استجابة تفيد بأن الطلب مكرر (لكنه ناجح برمجياً حتى لا يتعطل الموبايل)
            return sendError(res, 409, 'DUPLICATE_IGNORED', 'تم استلام هذا الطلب مسبقاً.');
        }

        const { amount, phone, type, notes } = req.body;
        const parsedAmount = parseFloat(amount);

        if (isNaN(parsedAmount) || parsedAmount <= 0 || !phone) throw new Error('MISSING_DATA');

        const settings = await Settings.findOne({}).session(session);
        if (settings && settings.isManualClosed) throw new Error('SYSTEM_CLOSED');

        let rate = settings.rateLevel1;
        let balanceModel = null;
        let modelType = '';
        let telegramId = null;
        let clientBotId = null;
        let companyName = 'عميل فردي (موبايل)';

        if (req.user.accountType === 'client_user') {
            rate = req.user.tier === 3 ? settings.rateLevel3 : (req.user.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
            balanceModel = req.user;
            modelType = 'User';
            telegramId = req.user.telegramId;
        } else {
            const comp = await ClientBot.findById(req.user.clientBotId).session(session);
            rate = comp.tier === 3 ? settings.rateLevel3 : (comp.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
            balanceModel = comp;
            modelType = 'ClientBot';
            clientBotId = comp._id;
            companyName = comp.name;
        }

        if (type === 'post_account') rate -= 0.05;
        if (type === 'post_card') rate -= 0.15;

        const costLYD = parseFloat((parsedAmount / rate).toFixed(3));
        const minBalance = costLYD - (balanceModel.creditLimit || 0);

        if (balanceModel.balance < minBalance) throw new Error('INSUFFICIENT_BALANCE');

        // الخصم
        const Model = modelType === 'User' ? User : ClientBot;
        const updatedDoc = await Model.findOneAndUpdate(
            { _id: balanceModel._id, balance: { $gte: minBalance } },
            { $inc: { balance: -costLYD } },
            { new: true, session }
        );

        if (!updatedDoc) throw new Error('INSUFFICIENT_BALANCE');

        const newTx = new Transaction({
            idempotencyKey,
            customId: `MOB-${Date.now().toString().slice(-6)}`,
            userId: telegramId,
            clientBotId: clientBotId,
            companyName: companyName,
            employeeName: req.user.name,
            vodafoneNumber: phone,
            transferType: type || 'vodafone',
            amount: parsedAmount,
            costLYD: costLYD,
            exchangeRate: rate,
            notes: notes || '',
            status: 'pending'
        });

        await newTx.save({ session });
        await session.commitTransaction();
        session.endSession();

        // 🔔 إشعارات الإدارة في الخلفية
        setImmediate(async () => {
            try {
                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const admins = await Admin.find({});
                const msg = `📱 <b>طلب موبايل جديد!</b>\n\n🏢 <b>من:</b> ${companyName}\n📞 <b>المحفظة:</b> <code>${phone}</code>\n💵 <b>المبلغ:</b> ${parsedAmount} EGP\n💰 <b>التكلفة:</b> ${costLYD} LYD`;
                for (const ad of admins) if (ad.telegramId) adminAPI.sendMessage(ad.telegramId, msg, { parse_mode: 'HTML' }).catch(()=>{});
            } catch(e) {}
        });

        return sendSuccess(res, { message: 'تم إرسال الطلب بنجاح', newBalance: updatedDoc.balance });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();

        if (error.message === 'MISSING_IDEMPOTENCY') return sendError(res, 400, 'MISSING_DATA', 'معرف الطلب (Idempotency Key) مفقود.');
        if (error.message === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'غير مصرح للقيام بهذه العملية.');
        if (error.message === 'SYSTEM_CLOSED') return sendError(res, 403, 'SYSTEM_CLOSED', 'النظام مغلق حالياً.');
        if (error.message === 'MISSING_DATA') return sendError(res, 400, 'MISSING_DATA', 'بيانات التحويل غير مكتملة.');
        if (error.message === 'INSUFFICIENT_BALANCE') return sendError(res, 400, 'INSUFFICIENT_BALANCE', 'الرصيد غير كافٍ.');

        return sendError(res, 500, 'SERVER_ERROR', 'حدث خطأ داخلي.');
    }
});

// ==========================================
// ⚙️ Executor Routes (المنفذين)
// ==========================================

router.get('/executor/live-tasks', requireMobileAuth, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') return sendError(res, 403, 'FORBIDDEN', 'مخصص للمنفذين فقط.');

        let myTasks = [];
        let pendingTasks = [];

        if (req.user.status === 'active') {
            myTasks = await Transaction.find({ executorBotId: req.user.botId, operatorId: req.user.telegramId, status: 'accepted' }).lean();
            pendingTasks = await Transaction.find({ executorBotId: req.user.botId, status: 'processing' }).lean();
        }

        return sendSuccess(res, { myTasks, pendingTasks });
    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'حدث خطأ في الخادم.');
    }
});

router.post('/executor/accept-task/:id', requireMobileAuth, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') return sendError(res, 403, 'FORBIDDEN', 'غير مصرح.');
        if (req.user.status !== 'active') return sendError(res, 403, 'INVALID_STATE', 'حسابك غير مفعل لاستلام طلبات.');

        const tx = await Transaction.findOneAndUpdate(
            { _id: req.params.id, status: 'processing', executorBotId: req.user.botId },
            { $set: { status: 'accepted', operatorId: req.user.telegramId, executorName: req.user.name } },
            { new: true }
        );

        if (!tx) return sendError(res, 400, 'ALREADY_TAKEN', 'هذا الطلب تم قبوله من قبل موظف آخر أو تم سحبه.');

        return sendSuccess(res, { message: 'تم قبول الطلب بنجاح.', transaction: tx });
    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'حدث خطأ.');
    }
});

router.post('/executor/complete-task/:id', requireMobileAuth, async (req, res) => {
    try {
        if (req.user.accountType !== 'executor') return sendError(res, 403, 'FORBIDDEN', 'غير مصرح.');
        
        const { imageBase64 } = req.body;
        if (!imageBase64) return sendError(res, 400, 'MISSING_DATA', 'صورة الإثبات مطلوبة بصيغة Base64.');

        const tx = await Transaction.findOne({ _id: req.params.id, operatorId: req.user.telegramId, status: 'accepted' });
        if (!tx) return sendError(res, 400, 'INVALID_STATE', 'الطلب غير متاح للإنهاء.');

        // 🟢 حماية السيرفر: الموبايل يرسل Base64 ويقوم السيرفر برفعه لتيليجرام للحصول على file_id لتخفيف الـ DB
        const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        const execBot = await ExecutorBot.findById(req.user.botId);
        const botAPI = new Telegram(execBot.token);
        
        const sentMsg = await botAPI.sendPhoto(req.user.telegramId, { source: imageBuffer }, { caption: `✅ تم التنفيذ عبر الموبايل\nالطلب: ${tx.customId}` });
        const fileId = sentMsg.photo[sentMsg.photo.length - 1].file_id;

        tx.status = 'completed';
        tx.proofImage = fileId;
        tx.proofImages = [fileId];
        await tx.save();

        // 🟢 إرسال الإشعار للعميل عبر تيليجرام كالمعتاد (في الخلفية)
        setImmediate(async () => {
            try {
                let clientAPI = new Telegram(tx.clientBotId ? (await ClientBot.findById(tx.clientBotId)).token : process.env.CLIENT_BOT_TOKEN);
                const msg = `✅ <b>تـم تـنـفـيـذ طـلـبـك بـنـجـاح!</b>\n🧾 الطلب: <code>${tx.customId}</code>\n💵 المبلغ: ${tx.amount} EGP`;
                if (tx.userId) await clientAPI.sendPhoto(tx.userId, fileId, { caption: msg, parse_mode: 'HTML' }).catch(()=>{});
            } catch(e) {}
        });

        return sendSuccess(res, { message: 'تم إكمال الطلب بنجاح.' });
    } catch (e) {
        return sendError(res, 500, 'SERVER_ERROR', 'حدث خطأ أثناء الرفع.');
    }
});

// ==========================================
// 🖼️ الصور الآمنة (Image Proxy)
// ==========================================
router.get('/transaction/image/:id', requireMobileAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx || !tx.proofImage) return res.status(404).send('No image');

        let token = process.env.ADMIN_BOT_TOKEN; // افتراضي نجلبها من توكن الإدارة
        const api = new Telegram(token);
        const fileLink = await api.getFileLink(tx.proofImage);

        const response = await axios.get(fileLink.href, { responseType: 'stream' });
        res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send('Error loading image');
    }
});

module.exports = router;