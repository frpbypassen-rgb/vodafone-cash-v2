const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const RegistrationRequest = require('../models/RegistrationRequest');
const { verifyAndUpgradePassword, escapeRegex, getTodayString } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const { logAction } = require('../services/auditService');

// إشعار الأدمن بطلب تسجيل جديد
async function notifyAdminNewRegistration(reg) {
    // 🟢 الإشعارات تتم الآن عبر قاعدة البيانات أو WebSockets
}

exports.getLogin = (req, res) => {
    if (req.session.isClientLoggedIn) return res.redirect('/client/dashboard');
    res.redirect('/login');
};

exports.getRegister = (req, res) => {
    if (req.session.isClientLoggedIn) return res.redirect('/client/dashboard');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.render('client/register', { 
        error: null, success: false, refCode: null, 
        createdUsername: null, createdPassword: null 
    });
};

exports.postRegister = async (req, res) => {
    try {
        const getField = (val) => {
            if (Array.isArray(val)) return val.find(v => v && typeof v === 'string' && v.trim()) || '';
            return (typeof val === 'string') ? val : '';
        };

        const { accountType } = req.body;
        if (!accountType || !['direct', 'company', 'new', 'agent'].includes(accountType)) {
            return res.render('client/register', { error: 'يرجى اختيار نوع الحساب.', success: false, refCode: null, createdUsername: null, createdPassword: null });
        }

        // ======= عميل مباشر =======
        if (accountType === 'direct') {
            const fullName = getField(req.body.fullName).trim();
            const phone = getField(req.body.phone).trim();
            const storeName = getField(req.body.storeName).trim();
            const address = getField(req.body.address).trim();
            let username = getField(req.body.username).trim();
            if (username && !username.includes('@')) {
                username += '@ahram.com';
            }
            const password = getField(req.body.password);
            const passwordConfirm = getField(req.body.passwordConfirm);

            if (!fullName || fullName.split(/\s+/).length < 3) return res.render('client/register', { error: 'يرجى إدخال الاسم الثلاثي كاملاً (3 كلمات على الأقل).', success: false, refCode: null });
            if (!phone || phone.length < 10) return res.render('client/register', { error: 'يرجى إدخال رقم هاتف صحيح (10 أرقام على الأقل).', success: false, refCode: null });
            if (!storeName) return res.render('client/register', { error: 'يرجى إدخال اسم المتجر.', success: false, refCode: null });
            if (!address) return res.render('client/register', { error: 'يرجى إدخال العنوان.', success: false, refCode: null });
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return res.render('client/register', { error: 'اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف).', success: false, refCode: null });
            if (!password || password.length < 6) return res.render('client/register', { error: 'الرقم السري يجب أن يكون 6 أحرف على الأقل.', success: false, refCode: null });
            if (password !== passwordConfirm) return res.render('client/register', { error: 'الرقم السري غير متطابق.', success: false, refCode: null });

            const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
            if (existingRequest) return res.render('client/register', { error: `يوجد طلب تسجيل سابق لهذا الرقم برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`, success: false, refCode: null });
            
            const existingUser = await User.findOne({ $or: [{ phone }, { username: { $regex: new RegExp(`^${username}$`, 'i') } }] });
            if (existingUser) return res.render('client/register', { error: 'رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى اختيار اسم آخر أو تسجيل الدخول.', success: false, refCode: null });

            const regRequest = await RegistrationRequest.create({
                accountType, fullName, phone, storeName, address, username, password,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown'
            });

            notifyAdminNewRegistration(regRequest).catch(() => {});
            await logAction({
                action: 'USER_CREATED',
                req,
                performedByName: fullName || username || 'unknown',
                result: 'معلق',
                metadata: { accountType, phone, regRequestId: regRequest._id }
            });
            return res.render('client/register', { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password });
        }

        // ======= عميل جديد =======
        if (accountType === 'new') {
            const fullName = getField(req.body.newFullName).trim();
            const phone = getField(req.body.newPhone).trim();
            const nationality = getField(req.body.nationality);
            const city = getField(req.body.newCity);
            const password = getField(req.body.newPassword);
            const passwordConfirm = getField(req.body.newPasswordConfirm);

            if (!fullName || fullName.split(/\s+/).length < 3) return res.render('client/register', { error: 'يرجى إدخال الاسم الثلاثي كاملاً.', success: false, refCode: null });
            if (!phone || phone.length < 10) return res.render('client/register', { error: 'يرجى إدخال رقم هاتف صحيح.', success: false, refCode: null });
            if (!nationality || !['libyan', 'egyptian'].includes(nationality)) return res.render('client/register', { error: 'يرجى اختيار الجنسية.', success: false, refCode: null });
            if (!city) return res.render('client/register', { error: 'يرجى اختيار مكان السكن.', success: false, refCode: null });
            if (!password || password.length < 6) return res.render('client/register', { error: 'الرقم السري يجب أن يكون 6 أحرف على الأقل.', success: false, refCode: null });
            if (password !== passwordConfirm) return res.render('client/register', { error: 'الرقم السري غير متطابق.', success: false, refCode: null });

            const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
            if (existingRequest) return res.render('client/register', { error: `يوجد طلب تسجيل سابق لهذا الرقم برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`, success: false, refCode: null });
            
            const existingUser = await User.findOne({ phone });
            if (existingUser) return res.render('client/register', { error: 'رقم الهاتف مسجل بالفعل. يرجى تسجيل الدخول أو التواصل مع الإدارة.', success: false, refCode: null });

            const regRequest = await RegistrationRequest.create({
                accountType, fullName, phone, nationality, city, password,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown'
            });

            notifyAdminNewRegistration(regRequest).catch(() => {});
            await logAction({
                action: 'USER_CREATED',
                req,
                performedByName: fullName || 'unknown',
                result: 'معلق',
                metadata: { accountType, phone, regRequestId: regRequest._id }
            });
            return res.render('client/register', { error: null, success: true, refCode: regRequest.refCode });
        }

        // ======= وكيل منطقة =======
        if (accountType === 'agent') {
            const companyName = getField(req.body.agentCompanyName).trim();
            const fullName = getField(req.body.agentFullName).trim();
            const phone = getField(req.body.agentPhone).trim();
            const address = getField(req.body.agentAddress).trim();
            const companyEmail = getField(req.body.agentEmail).trim();
            let username = getField(req.body.agentUsername).trim();
            if (username && !username.includes('@')) username += '@ahram.com';
            const password = getField(req.body.agentPassword);
            const passwordConfirm = getField(req.body.agentPasswordConfirm);

            if (!companyName) return res.render('client/register', { error: 'يرجى إدخال اسم الشركة.', success: false, refCode: null });
            if (!fullName || fullName.split(/\s+/).length < 3) return res.render('client/register', { error: 'يرجى إدخال اسم الوكيل الثلاثي كاملاً.', success: false, refCode: null });
            if (!phone || phone.length < 10) return res.render('client/register', { error: 'يرجى إدخال رقم هاتف صحيح.', success: false, refCode: null });
            if (!address) return res.render('client/register', { error: 'يرجى إدخال العنوان.', success: false, refCode: null });
            if (!companyEmail || !/^\S+@\S+\.\S+$/.test(companyEmail)) return res.render('client/register', { error: 'يرجى إدخال بريد إلكتروني رسمي صحيح.', success: false, refCode: null });
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return res.render('client/register', { error: 'اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات.', success: false, refCode: null });
            if (!password || password.length < 6) return res.render('client/register', { error: 'الرقم السري يجب أن يكون 6 أحرف على الأقل.', success: false, refCode: null });
            if (password !== passwordConfirm) return res.render('client/register', { error: 'الرقم السري غير متطابق.', success: false, refCode: null });

            const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
            if (existingRequest) return res.render('client/register', { error: `يوجد طلب تسجيل سابق لهذا الرقم. يرجى انتظار المراجعة.`, success: false, refCode: null });
            const existingUser = await User.findOne({ $or: [{ phone }, { username: { $regex: new RegExp(`^${username}$`, 'i') } }] });
            if (existingUser) return res.render('client/register', { error: 'رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى اختيار بيانات أخرى.', success: false, refCode: null });

            let agentCode;
            let codeExists = true;
            while(codeExists) {
                agentCode = Math.floor(10000000 + Math.random() * 90000000).toString();
                const checkReq = await RegistrationRequest.findOne({ agentCode });
                if (!checkReq) codeExists = false;
            }

            const regRequest = await RegistrationRequest.create({
                accountType, companyName, fullName, phone, address, companyEmail, username, password, agentCode,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown'
            });

            notifyAdminNewRegistration(regRequest).catch(() => {});
            await logAction({
                action: 'USER_CREATED',
                req,
                performedByName: fullName || username || 'unknown',
                result: 'معلق',
                metadata: { accountType, phone, regRequestId: regRequest._id }
            });
            return res.render('client/register', { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password, agentCode: agentCode });
        }

        // ======= حساب شركة =======
        if (accountType === 'company') {
            const companyName = getField(req.body.companyName).trim();
            const companyContact = getField(req.body.companyContact).trim();
            const companyPhone = getField(req.body.companyPhone).trim();
            const companyEmail = getField(req.body.companyEmail).trim();
            let username = getField(req.body.username).trim();
            if (username && !username.includes('@')) username += '@ahram.com';
            const password = getField(req.body.password);
            const passwordConfirm = getField(req.body.passwordConfirm);

            if (!companyName) return res.render('client/register', { error: 'يرجى إدخال اسم الشركة القانوني.', success: false, refCode: null });
            if (!companyContact) return res.render('client/register', { error: 'يرجى إدخال اسم مدير الشركة.', success: false, refCode: null });
            if (!companyPhone || companyPhone.length < 10) return res.render('client/register', { error: 'يرجى إدخال رقم تواصل صحيح للشركة.', success: false, refCode: null });
            if (!companyEmail || !/^\S+@\S+\.\S+$/.test(companyEmail)) return res.render('client/register', { error: 'يرجى إدخال بريد إلكتروني رسمي صحيح.', success: false, refCode: null });
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return res.render('client/register', { error: 'اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات.', success: false, refCode: null });
            if (!password || password.length < 6) return res.render('client/register', { error: 'الرقم السري يجب أن يكون 6 أحرف على الأقل.', success: false, refCode: null });
            if (password !== passwordConfirm) return res.render('client/register', { error: 'الرقم السري غير متطابق.', success: false, refCode: null });

            const existingCompanyReq = await RegistrationRequest.findOne({ companyPhone, status: 'pending' });
            if (existingCompanyReq) return res.render('client/register', { error: `يوجد طلب تسجيل سابق لهذا الرقم. رقم الطلب: ${existingCompanyReq.refCode}`, success: false, refCode: null });
            const existingUser = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
            if (existingUser) return res.render('client/register', { error: 'اسم المستخدم مسجل بالفعل. يرجى اختيار اسم آخر.', success: false, refCode: null });

            const regRequest = await RegistrationRequest.create({
                accountType, companyName, companyContact, companyPhone, companyEmail, username, password,
                ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown'
            });

            notifyAdminNewRegistration(regRequest).catch(() => {});
            await logAction({
                action: 'USER_CREATED',
                req,
                performedByName: companyContact || username || 'unknown',
                result: 'معلق',
                metadata: { accountType, companyPhone, regRequestId: regRequest._id }
            });
            return res.render('client/register', { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password });
        }

    } catch (e) {
        console.error('[Register] خطأ:', e.message, e.stack);
        res.render('client/register', { error: 'حدث خطأ في النظام. يرجى المحاولة لاحقاً.', success: false, refCode: null, createdUsername: null, createdPassword: null });
    }
};

// Already required at the top of this file

exports.postLogin = async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) {
            await logAction({ action: 'LOGIN_FAILED', req, performedByName: username || 'unknown', success: false, errorCode: 'MISSING_CREDENTIALS', metadata: { reason: 'يرجى إدخال البيانات.' } });
            return res.render('client/login', { error: 'يرجى إدخال البيانات.' });
        }

        const safeUsername = escapeRegex(username);
        const usernameRegex = new RegExp(`^${safeUsername}$`, 'i');
        const todayStr = getTodayString();

        const subAcc = await SubAccount.findOne({ webUsername: usernameRegex }).lean();
        if (subAcc) {
            const isMatch = await verifyAndUpgradePassword(password, subAcc.webPassword, SubAccount, subAcc._id);
            if (isMatch) {
                if (subAcc.status !== 'active') {
                    await logAction({ action: 'LOGIN_FAILED', req, performedById: subAcc._id, performedByModel: 'SubAccount', performedByName: subAcc.name, success: false, errorCode: 'SUSPENDED', metadata: { reason: 'حساب العميل الفرعي معلق حالياً' } });
                    return res.render('client/login', { error: 'حسابك معلق من قبل الوكيل الرئيسي.' });
                }
                req.session.isClientLoggedIn = true; req.session.clientId = subAcc._id; req.session.accountType = 'sub_client';
                await logAction({ action: 'LOGIN_SUCCESS', req, performedById: subAcc._id, performedByModel: 'SubAccount', performedByName: subAcc.name, metadata: { accountType: 'sub_client' } });
                return req.session.save(() => res.redirect('/client/dashboard')); 
            }
        }

        const clientUser = await User.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username }] }).lean();
        if (clientUser) {
            const isMatch = await verifyAndUpgradePassword(password, clientUser.webPassword, User, clientUser._id);
            if (isMatch) {
                if (clientUser.status !== 'active') {
                    await logAction({ action: 'LOGIN_FAILED', req, performedById: clientUser._id, performedByModel: 'User', performedByName: clientUser.name, success: false, errorCode: 'SUSPENDED', metadata: { reason: 'حساب العميل معلق حالياً' } });
                    return res.render('client/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });
                }
                
                if (clientUser.lastOtpDate === todayStr) {
                    req.session.isClientLoggedIn = true; req.session.clientId = clientUser._id; req.session.accountType = 'user';
                    await logAction({ action: 'LOGIN_SUCCESS', req, performedById: clientUser._id, performedByModel: 'User', performedByName: clientUser.name, metadata: { accountType: 'user' } });
                    return req.session.save(() => res.redirect('/client/dashboard')); 
                }
                
                const otp = generateOtp();
                const otpExpires = new Date(Date.now() + 5 * 60000);
                await User.updateOne({ _id: clientUser._id }, { $set: { otpCode: hashOtp(otp), otpExpires: otpExpires } }, { strict: false });
                
                const whatsappService = require('../services/whatsappService');
                const otpMsg = `🔐 رمز الدخول الخاص بك في الأهرام للتحويلات هو:\n\n*${otp}*\n\nالرمز صالح لمدة 5 دقائق.`;
                whatsappService.sendWhatsAppMessage(clientUser.phone, otpMsg).catch(()=>{});

                req.session.tempClientId = clientUser._id; req.session.tempAccountType = 'user';
                await logAction({ action: 'LOGIN_FAILED', req, performedById: clientUser._id, performedByModel: 'User', performedByName: clientUser.name, result: 'معلق', metadata: { accountType: 'user', reason: 'OTP_REQUIRED' } });
                return req.session.save(() => res.redirect('/client/verify')); 
            }
        }

        const clientCompany = await ClientEmployee.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username }] }).lean();
        if (clientCompany) {
            const isMatch = await verifyAndUpgradePassword(password, clientCompany.webPassword, ClientEmployee, clientCompany._id);
            if (isMatch) {
                if (clientCompany.status !== 'active') {
                    await logAction({ action: 'LOGIN_FAILED', req, performedById: clientCompany._id, performedByModel: 'ClientEmployee', performedByName: clientCompany.name, success: false, errorCode: 'SUSPENDED', metadata: { reason: 'حساب الشركة معلق حالياً' } });
                    return res.render('client/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });
                }
                
                if (clientCompany.lastOtpDate === todayStr) {
                    req.session.isClientLoggedIn = true; req.session.clientId = clientCompany._id; req.session.accountType = 'company';
                    await logAction({ action: 'LOGIN_SUCCESS', req, performedById: clientCompany._id, performedByModel: 'ClientEmployee', performedByName: clientCompany.name, metadata: { accountType: 'company' } });
                    return req.session.save(() => res.redirect('/client/dashboard')); 
                }
                
                const otp = generateOtp();
                const otpExpires = new Date(Date.now() + 5 * 60000);
                await ClientEmployee.updateOne({ _id: clientCompany._id }, { $set: { otpCode: hashOtp(otp), otpExpires: otpExpires } }, { strict: false });
                
                const whatsappService = require('../services/whatsappService');
                const otpMsg = `🔐 رمز الدخول الخاص بك لحساب الشركة في الأهرام للتحويلات هو:\n\n*${otp}*\n\nالرمز صالح لمدة 5 دقائق.`;
                whatsappService.sendWhatsAppMessage(clientCompany.phone, otpMsg).catch(()=>{});

                req.session.tempClientId = clientCompany._id; req.session.tempAccountType = 'company';
                await logAction({ action: 'LOGIN_FAILED', req, performedById: clientCompany._id, performedByModel: 'ClientEmployee', performedByName: clientCompany.name, result: 'معلق', metadata: { accountType: 'company', reason: 'OTP_REQUIRED' } });
                return req.session.save(() => res.redirect('/client/verify')); 
            }
        }

        await logAction({ action: 'LOGIN_FAILED', req, performedByName: username, success: false, errorCode: 'INVALID_CREDENTIALS', metadata: { reason: 'بيانات الدخول غير صحيحة.' } });
        return res.render('client/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
    } catch (e) {
        console.error('[Login Error] حدث خطأ في تسجيل دخول العميل:', e);
        res.render('client/login', { error: 'حدث خطأ في النظام.' });
    }
};

exports.getVerify = (req, res) => {
    if (!req.session.tempClientId) return res.redirect('/login');
    res.render('client/verify', { error: null });
};

exports.postVerify = async (req, res) => {
    try {
        const { otp } = req.body;
        let account = null;
        const performedByModel = req.session.tempAccountType === 'company' ? 'ClientEmployee' : 'User';
        
        if (req.session.tempAccountType === 'company') { account = await ClientEmployee.findById(req.session.tempClientId).lean(); } 
        else { account = await User.findById(req.session.tempClientId).lean(); }
        
        if (!account || !verifyOtp(otp, account.otpCode) || new Date(account.otpExpires) < new Date()) {
            if (account) {
                await logAction({ action: 'LOGIN_FAILED', req, performedById: account._id, performedByModel, performedByName: account.name, success: false, errorCode: 'INVALID_OTP', metadata: { reason: 'رمز التحقق غير صحيح أو منتهي' } });
            }
            return res.render('client/verify', { error: 'الرمز غير صحيح أو منتهي الصلاحية.' });
        }

        const todayStr = getTodayString();
        if (req.session.tempAccountType === 'company') { await ClientEmployee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); } 
        else { await User.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); }

        req.session.isClientLoggedIn = true; req.session.clientId = account._id; req.session.accountType = req.session.tempAccountType;
        req.session.tempClientId = null; req.session.tempAccountType = null;
        
        await logAction({ action: 'LOGIN_SUCCESS', req, performedById: account._id, performedByModel, performedByName: account.name, metadata: { accountType: req.session.accountType, via: 'OTP' } });
        res.redirect('/client/dashboard');
    } catch (e) { res.redirect('/login'); }
};

exports.logout = async (req, res) => {
    try {
        if (req.session.clientId) {
            const performedByModel = req.session.accountType === 'company' ? 'ClientEmployee' : (req.session.accountType === 'sub_client' ? 'SubAccount' : 'User');
            await logAction({
                action: 'LOGOUT',
                req,
                performedById: req.session.clientId,
                performedByModel,
                performedByName: req.session.adminName || 'عميل'
            });
        }
    } catch (e) {
        console.error('Failed to log client logout:', e);
    }
    req.session.destroy();
    res.redirect('/login');
};
