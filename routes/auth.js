const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { escapeRegex, verifyAndUpgradePassword, getTodayString } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const Admin = require('../models/Admin');
const Employee = require('../models/Employee');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const SupportTicket = require('../models/SupportTicket');
const PasswordResetRequest = require('../models/PasswordResetRequest');

const loginLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    message: 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول. حاول بعد دقيقة.',
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

const passwordResetLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: { success: false, error: 'عدد محاولات الاستعادة مرتفع. حاول بعد قليل.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const renderLogin = (res, error = null) => res.render('unified_login', { error });

const clearLoginState = (session) => {
    delete session.isLoggedIn;
    delete session.adminName;
    delete session.adminRole;
    delete session.adminId;

    delete session.isClientLoggedIn;
    delete session.clientId;
    delete session.accountType;
    delete session.tempClientId;
    delete session.tempAccountType;

    delete session.isExecutorLoggedIn;
    delete session.executorId;
    delete session.executorGroupId;
    delete session.tempExecutorId;
};

const redirectActiveSession = (req, res) => {
    if (req.session.isLoggedIn) {
        res.redirect('/');
        return true;
    }
    if (req.session.isClientLoggedIn && req.session.clientId) {
        res.redirect('/client/dashboard');
        return true;
    }
    if (req.session.isExecutorLoggedIn && req.session.executorId) {
        res.redirect('/executor-portal/dashboard');
        return true;
    }
    return false;
};

const saveAndRedirect = (req, res, target) => req.session.save(() => res.redirect(target));

const getUsernameCandidates = (username) => {
    const candidates = [username];
    if (!username.includes('@')) candidates.push(`${username}@ahram.com`);
    return [...new Set(candidates.filter(Boolean))];
};

const getUsernameRegexes = (username) => (
    getUsernameCandidates(username).map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i'))
);

const webUsernameLookup = (username) => ({ $or: getUsernameRegexes(username).map((regex) => ({ webUsername: regex })) });

const personLookup = (username) => ({
    $or: [
        ...getUsernameRegexes(username).map((regex) => ({ webUsername: regex })),
        { phone: username },
    ],
});

const getPhoneCandidates = (phone) => {
    const raw = String(phone || '').trim();
    const digits = raw.replace(/\D/g, '');
    const candidates = [raw, digits];

    if (digits.startsWith('218') && digits.length === 12) candidates.push(`0${digits.slice(3)}`);
    if (digits.startsWith('20') && digits.length === 12) candidates.push(`0${digits.slice(2)}`);
    if (digits.startsWith('00218')) candidates.push(`0${digits.slice(5)}`);
    if (digits.startsWith('0020')) candidates.push(`0${digits.slice(4)}`);

    return [...new Set(candidates.filter(Boolean))];
};

const phoneMatches = (storedPhone, submittedPhone) => {
    const storedCandidates = getPhoneCandidates(storedPhone);
    const submittedCandidates = getPhoneCandidates(submittedPhone);
    return storedCandidates.some((phone) => submittedCandidates.includes(phone));
};

const { logAction } = require('../services/auditService');

const loginAsAdmin = async (req, res, adminData = null) => {
    clearLoginState(req.session);
    req.session.isLoggedIn = true;
    req.session.adminName = adminData ? adminData.name : 'المدير الأساسي';
    req.session.adminRole = adminData ? (adminData.role || 'admin') : 'master';
    req.session.adminId = adminData ? adminData._id : 'master_admin';

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: adminData ? adminData._id : null,
        performedByModel: 'Admin',
        performedByName: req.session.adminName,
        metadata: { role: req.session.adminRole }
    });

    return saveAndRedirect(req, res, '/');
};

const loginAsExecutor = async (req, res, executor) => {
    clearLoginState(req.session);
    req.session.isExecutorLoggedIn = true;
    req.session.executorId = executor._id;
    req.session.executorGroupId = executor.groupId ? executor.groupId._id : null;

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: executor._id,
        performedByModel: 'Employee',
        performedByName: executor.name,
        metadata: { role: 'executor', groupId: req.session.executorGroupId }
    });

    return saveAndRedirect(req, res, '/executor-portal/dashboard');
};

const loginAsClient = async (req, res, account, accountType) => {
    clearLoginState(req.session);
    req.session.isClientLoggedIn = true;
    req.session.clientId = account._id;
    req.session.accountType = accountType;
    const performedByModel = accountType === 'company' ? 'ClientEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User');

    await logAction({
        action: 'LOGIN_SUCCESS',
        req,
        performedById: account._id,
        performedByModel,
        performedByName: account.name,
        metadata: { accountType }
    });

    return saveAndRedirect(req, res, '/client/dashboard');
};

const startClientOtp = async (req, res, account, accountType, Model) => {
    const otp = generateOtp();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);

    await Model.updateOne(
        { _id: account._id },
        { $set: { otpCode: hashOtp(otp), otpExpires } },
        { strict: false }
    );

    try {
        const whatsappService = require('../services/whatsappService');
        const otpMsg = `رمز الدخول الخاص بك هو:\n\n*${otp}*\n\nالرمز صالح لمدة 5 دقائق.`;
        whatsappService.sendWhatsAppMessage(account.phone, otpMsg).catch(() => {});
    } catch (error) {
        console.warn('[Unified Login] WhatsApp OTP send skipped:', error.message);
    }

    clearLoginState(req.session);
    req.session.tempClientId = account._id;
    req.session.tempAccountType = accountType;

    const performedByModel = accountType === 'company' ? 'ClientEmployee' : 'User';
    await logAction({
        action: 'LOGIN_FAILED',
        req,
        performedById: account._id,
        performedByModel,
        performedByName: account.name,
        result: 'معلق',
        metadata: { accountType, reason: 'OTP_REQUIRED' }
    });

    return saveAndRedirect(req, res, '/client/verify');
};

const logLoginFailure = async (req, username, errorCode, reason) => {
    await logAction({
        action: 'LOGIN_FAILED',
        req,
        performedByName: username || 'unknown',
        success: false,
        errorCode,
        metadata: { reason }
    });
};

const sanitizeAccountSnapshot = (account) => {
    const snapshot = { ...account };
    delete snapshot.webPassword;
    delete snapshot.refreshToken;
    delete snapshot.otpCode;
    delete snapshot.otpExpires;
    return snapshot;
};

const formatAccountCard = (snapshot) => (
    Object.entries(snapshot)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => {
            if (value instanceof Date) return `- ${key}: ${value.toISOString()}`;
            if (typeof value === 'object') return `- ${key}: ${String(value)}`;
            return `- ${key}: ${value}`;
        })
        .join('\n')
);

const findPasswordResetAccount = async (username, phone) => {
    const user = await User.findOne(webUsernameLookup(username)).lean();
    if (user && phoneMatches(user.phone, phone)) {
        if ((user.role || 'user') === 'agent') {
            return { blocked: true, reason: 'استعادة كلمة المرور غير متاحة لحسابات الوكلاء.' };
        }

        return {
            accountType: 'user',
            accountModel: 'User',
            account: user,
            name: user.name || user.webUsername,
            phone: user.phone,
            masterName: ''
        };
    }

    const subAccount = await SubAccount.findOne(webUsernameLookup(username)).lean();
    if (subAccount && phoneMatches(subAccount.phone, phone)) {
        if (subAccount.masterType !== 'user') {
            return { blocked: true, reason: 'استعادة كلمة المرور غير متاحة لحسابات الشركات.' };
        }

        const master = await User.findById(subAccount.masterId).lean();
        return {
            accountType: 'sub_client',
            accountModel: 'SubAccount',
            account: subAccount,
            name: subAccount.name || subAccount.webUsername,
            phone: subAccount.phone,
            masterName: master ? (master.name || master.webUsername) : 'غير معروف'
        };
    }

    return null;
};

const createPasswordResetTicket = async (resetRequest) => {
    const typeLabel = resetRequest.accountType === 'sub_client' ? 'عميل تابع لوكيل' : 'عميل مباشر';
    const cardText = formatAccountCard(resetRequest.accountSnapshot || {});
    const messageText = [
        'طلب استعادة كلمة مرور بانتظار موافقة الإدارة.',
        '',
        `رقم الطلب: ${resetRequest.requestId}`,
        `نوع الحساب: ${typeLabel}`,
        `اسم العميل: ${resetRequest.name}`,
        `اسم المستخدم: ${resetRequest.username}`,
        `رقم الهاتف: ${resetRequest.phone}`,
        resetRequest.masterName ? `الوكيل/الحساب الرئيسي: ${resetRequest.masterName}` : '',
        '',
        'كلمة المرور الجديدة تم استلامها بأمان وسيتم تفعيلها بعد موافقة الإدارة.',
        '',
        'بطاقة بيانات الحساب:',
        cardText || '- لا توجد بيانات إضافية.'
    ].filter(Boolean).join('\n');

    return SupportTicket.create({
        entityType: resetRequest.accountType === 'sub_client' ? 'sub_client' : 'client_user',
        entityId: resetRequest.accountId,
        name: `استعادة كلمة مرور - ${resetRequest.name}`,
        phone: resetRequest.phone,
        status: 'open',
        unreadAdmin: 1,
        messages: [{
            sender: 'user',
            senderName: 'طلب استعادة كلمة المرور',
            text: messageText,
            createdAt: new Date()
        }],
        metadata: {
            type: 'password_reset',
            passwordResetRequestId: resetRequest._id,
            passwordResetStatus: 'pending_admin'
        }
    });
};

router.get('/login', (req, res) => {
    if (redirectActiveSession(req, res)) return;
    renderLogin(res);
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) {
            return renderLogin(res, 'يرجى إدخال اسم المستخدم وكلمة المرور.');
        }

        const envAdminUser = (process.env.PANEL_USER || '').trim();
        const envAdminPass = (process.env.PANEL_PASS || '').trim();

        if (envAdminUser && envAdminPass &&
            username.toLowerCase() === envAdminUser.toLowerCase() &&
            password === envAdminPass) {
            return loginAsAdmin(req, res);
        }

        const adminData = await Admin.findOne(webUsernameLookup(username)).lean();
        if (adminData?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, adminData.webPassword, Admin, adminData._id);
            if (isMatch) return loginAsAdmin(req, res, adminData);
        }

        const executor = await Employee.findOne(personLookup(username)).populate('groupId').lean();
        if (executor?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, executor.webPassword, Employee, executor._id);
            if (isMatch) {
                if (executor.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب التنفيذ غير مفعل حالياً');
                    return renderLogin(res, 'حساب التنفيذ غير مفعل حالياً.');
                }
                return loginAsExecutor(req, res, executor);
            }
        }

        const subAccount = await SubAccount.findOne(personLookup(username)).lean();
        if (subAccount?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, subAccount.webPassword, SubAccount, subAccount._id);
            if (isMatch) {
                if (subAccount.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب العميل الفرعي معلق حالياً');
                    return renderLogin(res, 'حساب العميل الفرعي معلق حالياً.');
                }
                return loginAsClient(req, res, subAccount, 'sub_client');
            }
        }

        const todayStr = getTodayString();
        const clientUser = await User.findOne(personLookup(username)).lean();
        if (clientUser?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, clientUser.webPassword, User, clientUser._id);
            if (isMatch) {
                if (clientUser.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب العميل معلق حالياً');
                    return renderLogin(res, 'حساب العميل معلق حالياً.');
                }
                if (clientUser.lastOtpDate === todayStr) {
                    return loginAsClient(req, res, clientUser, 'user');
                }
                return startClientOtp(req, res, clientUser, 'user', User);
            }
        }

        const clientCompany = await ClientEmployee.findOne(personLookup(username)).lean();
        if (clientCompany?.webPassword) {
            const isMatch = await verifyAndUpgradePassword(password, clientCompany.webPassword, ClientEmployee, clientCompany._id);
            if (isMatch) {
                if (clientCompany.status !== 'active') {
                    await logLoginFailure(req, username, 'SUSPENDED', 'حساب الشركة معلق حالياً');
                    return renderLogin(res, 'حساب الشركة معلق حالياً.');
                }
                if (clientCompany.lastOtpDate === todayStr) {
                    return loginAsClient(req, res, clientCompany, 'company');
                }
                return startClientOtp(req, res, clientCompany, 'company', ClientEmployee);
            }
        }

        await logLoginFailure(req, username, 'INVALID_CREDENTIALS', 'بيانات الدخول غير صحيحة');
        return renderLogin(res, 'بيانات الدخول غير صحيحة.');
    } catch (error) {
        console.error('[Unified Login] login failed:', error.message);
        return renderLogin(res, 'حدث خطأ داخلي في الخادم.');
    }
});

router.post('/api/password-reset/start', passwordResetLimiter, async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const phone = req.body.phone?.trim();

        if (!username || !phone) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال اسم المستخدم ورقم الهاتف.' });
        }

        const resetAccount = await findPasswordResetAccount(username, phone);
        if (!resetAccount) {
            return res.status(404).json({ success: false, error: 'لا يوجد حساب عميل مطابق لاسم المستخدم ورقم الهاتف.' });
        }
        if (resetAccount.blocked) {
            return res.status(403).json({ success: false, error: resetAccount.reason });
        }

        const existingPending = await PasswordResetRequest.findOne({
            accountType: resetAccount.accountType,
            accountId: resetAccount.account._id,
            status: 'pending_admin'
        }).lean();

        if (existingPending) {
            return res.status(409).json({ success: false, error: 'يوجد طلب استعادة قيد مراجعة الإدارة لهذا الحساب.' });
        }

        await PasswordResetRequest.updateMany(
            {
                accountType: resetAccount.accountType,
                accountId: resetAccount.account._id,
                status: { $in: ['otp_sent', 'otp_verified'] }
            },
            { $set: { status: 'expired' } }
        );

        const otp = generateOtp();
        const resetRequest = await PasswordResetRequest.create({
            accountType: resetAccount.accountType,
            accountModel: resetAccount.accountModel,
            accountId: resetAccount.account._id,
            username: resetAccount.account.webUsername,
            phone: resetAccount.phone,
            name: resetAccount.name,
            masterName: resetAccount.masterName,
            otpCode: hashOtp(otp),
            otpExpires: new Date(Date.now() + 10 * 60 * 1000),
            accountSnapshot: {
                ...sanitizeAccountSnapshot(resetAccount.account),
                accountType: resetAccount.accountType,
                masterName: resetAccount.masterName
            }
        });

        try {
            const whatsappService = require('../services/whatsappService');
            const otpMsg = `رمز تحقق استعادة كلمة المرور في Ahram Pay هو:\n\n*${otp}*\n\nالرمز صالح لمدة 10 دقائق.`;
            whatsappService.sendWhatsAppMessage(resetAccount.phone, otpMsg).catch(() => {});
        } catch (error) {
            console.warn('[Password Reset] WhatsApp OTP send skipped:', error.message);
        }

        return res.json({
            success: true,
            requestId: resetRequest._id,
            message: 'تم إرسال رمز التحقق على واتساب.'
        });
    } catch (error) {
        console.error('[Password Reset] start failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء بدء الاستعادة.' });
    }
});

router.post('/api/password-reset/verify-otp', passwordResetLimiter, async (req, res) => {
    try {
        const requestId = req.body.requestId?.trim();
        const otp = req.body.otp?.trim();

        if (!requestId || !otp) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال رمز التحقق.' });
        }

        const resetRequest = await PasswordResetRequest.findById(requestId);
        if (!resetRequest || resetRequest.status !== 'otp_sent') {
            return res.status(404).json({ success: false, error: 'طلب الاستعادة غير صالح أو منتهي.' });
        }

        if (!resetRequest.otpExpires || resetRequest.otpExpires < new Date()) {
            resetRequest.status = 'expired';
            await resetRequest.save();
            return res.status(410).json({ success: false, error: 'انتهت صلاحية رمز التحقق. ابدأ الطلب من جديد.' });
        }

        if (!verifyOtp(otp, resetRequest.otpCode)) {
            return res.status(400).json({ success: false, error: 'رمز التحقق غير صحيح.' });
        }

        resetRequest.status = 'otp_verified';
        resetRequest.otpVerifiedAt = new Date();
        resetRequest.otpCode = undefined;
        await resetRequest.save();

        return res.json({ success: true, message: 'تم التحقق من الرمز بنجاح.' });
    } catch (error) {
        console.error('[Password Reset] otp verify failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق من الرمز.' });
    }
});

router.post('/api/password-reset/submit', passwordResetLimiter, async (req, res) => {
    try {
        const requestId = req.body.requestId?.trim();
        const newPassword = req.body.newPassword?.trim();
        const confirmPassword = req.body.confirmPassword?.trim();

        if (!requestId || !newPassword || !confirmPassword) {
            return res.status(400).json({ success: false, error: 'يرجى إدخال كلمة المرور الجديدة وتأكيدها.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).json({ success: false, error: 'كلمتا المرور غير متطابقتين.' });
        }

        const resetRequest = await PasswordResetRequest.findById(requestId);
        if (!resetRequest || resetRequest.status !== 'otp_verified') {
            return res.status(404).json({ success: false, error: 'طلب الاستعادة غير صالح أو لم يتم التحقق منه.' });
        }

        resetRequest.pendingPasswordHash = await bcrypt.hash(newPassword, 12);
        resetRequest.status = 'pending_admin';
        await resetRequest.save();

        const ticket = await createPasswordResetTicket(resetRequest);
        resetRequest.ticketId = ticket._id;
        await resetRequest.save();

        try {
            const Notification = require('../models/Notification');
            await Notification.create({
                title: 'طلب استعادة كلمة مرور',
                message: `طلب جديد من ${resetRequest.name} بانتظار تأكيد الإدارة.`,
                txId: resetRequest.requestId
            });
        } catch (error) {
            console.warn('[Password Reset] notification skipped:', error.message);
        }

        return res.json({
            success: true,
            message: 'تم إرسال الطلب إلى الإدارة. سيتم تفعيل كلمة المرور الجديدة بعد الموافقة.'
        });
    } catch (error) {
        console.error('[Password Reset] submit failed:', error.message);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إرسال الطلب للإدارة.' });
    }
});

router.get('/logout', async (req, res) => {
    try {
        let userId = null;
        let performedByModel = 'System';
        let performedByName = 'System';

        if (req.session.adminId) {
            userId = req.session.adminId;
            performedByModel = 'Admin';
            performedByName = req.session.adminName;
        } else if (req.session.clientId) {
            userId = req.session.clientId;
            performedByModel = req.session.accountType === 'company' ? 'ClientEmployee' : (req.session.accountType === 'sub_client' ? 'SubAccount' : 'User');
            performedByName = req.session.adminName || 'عميل';
        } else if (req.session.executorId) {
            userId = req.session.executorId;
            performedByModel = 'Employee';
            performedByName = req.session.adminName || 'منفذ';
        }

        await logAction({
            action: 'LOGOUT',
            req,
            performedById: userId,
            performedByModel,
            performedByName
        });
    } catch (e) {
        console.error('Failed to log logout:', e);
    }

    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
