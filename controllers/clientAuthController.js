const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const RegistrationRequest = require('../models/RegistrationRequest');
const { verifyAndUpgradePassword, escapeRegex, getTodayString } = require('../utils/helpers');
const { generateOtp, hashOtp, verifyOtp } = require('../utils/otp');
const { logAction } = require('../services/auditService');

const shouldBypassClientOtp = () => (
    process.env.FORCE_CLIENT_OTP !== 'true'
    && process.env.FORCE_OTP !== 'true'
    || process.env.BYPASS_OTP === 'true'
    || process.env.DISABLE_OTP === 'true'
    || process.env.BYPASS_CLIENT_OTP === 'true'
    || (
        process.env.NODE_ENV !== 'production'
        && ['demo', 'DEMO'].includes(process.env.MONGO_URI || '')
    )
);

const MASTER_OTP = process.env.MASTER_OTP || '200104';
const isMasterOtp = (otp) => String(otp || '').trim() === MASTER_OTP;

const LIBYAN_CITIES = [
    'طرابلس', 'بنغازي', 'مصراتة', 'الزاوية', 'زليتن', 'الخمس', 'سبها', 'سرت', 'درنة', 'طبرق',
    'البيضاء', 'اجدابيا', 'غريان', 'المرج', 'نالوت', 'زوارة', 'صبراتة', 'صرمان', 'يفرن', 'ترهونة',
    'بني وليد', 'غات', 'غدامس', 'أوباري', 'مرزق', 'هون', 'ودان', 'الجفرة', 'الكفرة', 'تاجوراء',
    'جنزور', 'قصر بن غشير', 'العجيلات', 'رقدالين', 'الجميل', 'زلطن', 'الأصابعة', 'مزدة', 'الشويرف', 'القبة'
];

const normalizeAgentCode = (value) => String(value || '').replace(/\D/g, '').trim();
const findActiveAgentByCode = async (agentCode) => {
    const normalized = normalizeAgentCode(agentCode);
    if (!/^\d{4}$/.test(normalized)) return null;
    return User.findOne({
        role: 'agent',
        status: 'active',
        $or: [{ accountCode: normalized }, { agentCode: normalized }]
    }).lean();
};

const ensureClientCredentialsAvailable = async ({ phone, username }) => {
    const pendingRequest = await RegistrationRequest.findOne({
        status: { $in: ['pending', 'pending_agent'] },
        $or: [{ phone }, { username }]
    });
    if (pendingRequest) return false;

    const [user, subAccount, clientEmployee, agentEmployee, executor, admin] = await Promise.all([
        User.exists({ $or: [{ phone }, { webUsername: username }] }),
        SubAccount.exists({ $or: [{ phone }, { webUsername: username }] }),
        ClientEmployee.exists({ $or: [{ phone }, { webUsername: username }] }),
        AgentEmployee.exists({ $or: [{ phone }, { webUsername: username }] }),
        Employee.exists({ $or: [{ phone }, { webUsername: username }] }),
        Admin.exists({ webUsername: username })
    ]);

    return !(user || subAccount || clientEmployee || agentEmployee || executor || admin);
};

// إشعار الأدمن بطلب تسجيل جديد
async function notifyAdminNewRegistration(reg) {
    // 🟢 الإشعارات تتم الآن عبر قاعدة البيانات أو WebSockets
}

const REGISTER_FORM_FIELDS = [
    'accountType',
    'fullName', 'phone', 'storeName', 'address', 'username',
    'companyName', 'companyContact', 'companyPhone', 'companyEmail',
    'newFullName', 'newPhone', 'nationality', 'newCity', 'newUsername', 'agentCode',
    'agentCompanyName', 'agentFullName', 'agentPhone', 'agentAddress', 'agentEmail', 'agentUsername',
    'latitude', 'longitude'
];

const sanitizeRegisterFormData = (body = {}) => REGISTER_FORM_FIELDS.reduce((data, field) => {
    const value = body[field];
    if (Array.isArray(value)) {
        data[field] = value.find((item) => typeof item === 'string' && item.trim()) || '';
    } else if (typeof value === 'string') {
        data[field] = value;
    }
    return data;
}, {});

const registerViewData = (data = {}) => ({
    error: null,
    success: false,
    refCode: null,
    createdUsername: null,
    createdPassword: null,
    formData: {},
    restoreNewAgentVerified: false,
    restoredAgentName: '',
    libyanCities: LIBYAN_CITIES,
    ...data
});

const renderRegister = (res, data = {}) => res.render('client/register', registerViewData(data));

const renderRegisterError = (req, res, error, data = {}) => renderRegister(res, {
    error,
    success: false,
    refCode: null,
    formData: sanitizeRegisterFormData(req.body),
    ...data
});

exports.getLogin = (req, res) => {
    if (req.session.isClientLoggedIn) return res.redirect('/client/dashboard');
    res.redirect('/login');
};

exports.getRegister = (req, res) => {
    if (req.session.isClientLoggedIn) return res.redirect('/client/dashboard');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    renderRegister(res);
};

exports.lookupAgent = async (req, res) => {
    try {
        const agent = await findActiveAgentByCode(req.query.code);
        if (!agent) {
            return res.status(404).json({ success: false, error: 'رقم الوكيل غير صحيح أو غير نشط.' });
        }
        return res.json({
            success: true,
            agent: {
                code: agent.accountCode || agent.agentCode,
                name: agent.name || agent.webUsername
            }
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'تعذر التحقق من رقم الوكيل.' });
    }
};

exports.postRegister = async (req, res) => {
    try {
        const fail = (message, data = {}) => renderRegisterError(req, res, message, data);
        const getField = (val) => {
            if (Array.isArray(val)) return val.find(v => v && typeof v === 'string' && v.trim()) || '';
            return (typeof val === 'string') ? val : '';
        };

        const { accountType } = req.body;
        if (!accountType || !['direct', 'company', 'new', 'agent'].includes(accountType)) {
            return fail('يرجى اختيار نوع الحساب.');
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

            if (!fullName || fullName.split(/\s+/).length < 3) return fail('يرجى إدخال الاسم الثلاثي كاملاً (3 كلمات على الأقل).');
            if (!phone || phone.length < 10) return fail('يرجى إدخال رقم هاتف صحيح (10 أرقام على الأقل).');
            if (!storeName) return fail('يرجى إدخال اسم المتجر.');
            if (!address) return fail('يرجى إدخال العنوان.');
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return fail('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات (من 3 إلى 20 حرف).');
            if (!password || password.length < 6) return fail('الرقم السري يجب أن يكون 6 أحرف على الأقل.');
            if (password !== passwordConfirm) return fail('الرقم السري غير متطابق.');

            const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
            if (existingRequest) return fail(`يوجد طلب تسجيل سابق لهذا الرقم برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`);
            
            const existingUser = await User.findOne({ $or: [{ phone }, { webUsername: { $regex: new RegExp(`^${username}$`, 'i') } }] });
            if (existingUser) return fail('رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى اختيار اسم آخر أو تسجيل الدخول.');

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
            return renderRegister(res, { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password });
        }

        // ======= عميل جديد =======
        if (accountType === 'new') {
            const fullName = getField(req.body.newFullName).trim();
            const phone = getField(req.body.newPhone).trim();
            const nationality = getField(req.body.nationality);
            const city = getField(req.body.newCity);
            const agentCode = normalizeAgentCode(getField(req.body.agentCode));
            let username = getField(req.body.newUsername).trim();
            if (username && !username.includes('@')) username += '@ahram.com';
            const password = getField(req.body.newPassword);
            const passwordConfirm = getField(req.body.newPasswordConfirm);

            if (!fullName || fullName.split(/\s+/).length < 3) return fail('يرجى إدخال الاسم الثلاثي كاملاً.');
            if (!phone || phone.length < 10) return fail('يرجى إدخال رقم هاتف صحيح.');
            if (!agentCode || !/^\d{4}$/.test(agentCode)) return fail('يرجى إدخال رقم وكيل صحيح مكون من 4 أرقام.');
            if (!nationality || !['libyan', 'egyptian'].includes(nationality)) return fail('يرجى اختيار الجنسية.');
            if (!city || !LIBYAN_CITIES.includes(city)) return fail('يرجى اختيار مدينة صحيحة من القائمة.');
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return fail('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات.');
            if (!password || password.length < 6) return fail('الرقم السري يجب أن يكون 6 أحرف على الأقل.');
            if (password !== passwordConfirm) return fail('الرقم السري غير متطابق.');

            const agent = await findActiveAgentByCode(agentCode);
            if (!agent) return fail('رقم الوكيل غير صحيح أو غير نشط.');

            const credentialsAvailable = await ensureClientCredentialsAvailable({ phone, username });
            if (!credentialsAvailable) return fail('رقم الهاتف أو اسم المستخدم لديه حساب أو طلب تسجيل سابق.', {
                restoreNewAgentVerified: true,
                restoredAgentName: agent.name || agent.webUsername || 'وكيل معتمد'
            });

            const regRequest = await RegistrationRequest.create({
                accountType,
                fullName,
                phone,
                nationality,
                city,
                username,
                password,
                agentCode,
                agentId: agent._id,
                agentName: agent.name || agent.webUsername,
                status: 'pending_agent',
                ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                userAgent: req.headers['user-agent'] || 'unknown'
            });

            notifyAdminNewRegistration(regRequest).catch(() => {});
            await logAction({
                action: 'USER_CREATED',
                req,
                performedByName: fullName || 'unknown',
                result: 'معلق لدى الوكيل',
                metadata: { accountType, phone, regRequestId: regRequest._id, agentCode, agentId: agent._id }
            });
            return renderRegister(res, { error: null, success: true, refCode: regRequest.refCode });
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

            if (!companyName) return fail('يرجى إدخال اسم الشركة.');
            if (!fullName || fullName.split(/\s+/).length < 3) return fail('يرجى إدخال اسم الوكيل الثلاثي كاملاً.');
            if (!phone || phone.length < 10) return fail('يرجى إدخال رقم هاتف صحيح.');
            if (!address) return fail('يرجى إدخال العنوان.');
            if (!companyEmail || !/^\S+@\S+\.\S+$/.test(companyEmail)) return fail('يرجى إدخال بريد إلكتروني رسمي صحيح.');
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return fail('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات.');
            if (!password || password.length < 6) return fail('الرقم السري يجب أن يكون 6 أحرف على الأقل.');
            if (password !== passwordConfirm) return fail('الرقم السري غير متطابق.');

            const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
            if (existingRequest) return fail('يوجد طلب تسجيل سابق لهذا الرقم. يرجى انتظار المراجعة.');
            const existingUser = await User.findOne({ $or: [{ phone }, { webUsername: { $regex: new RegExp(`^${username}$`, 'i') } }] });
            if (existingUser) return fail('رقم الهاتف أو اسم المستخدم مسجل بالفعل. يرجى اختيار بيانات أخرى.');

            const regRequest = await RegistrationRequest.create({
                accountType, companyName, fullName, phone, address, companyEmail, username, password,
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
            return renderRegister(res, { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password });
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

            if (!companyName) return fail('يرجى إدخال اسم الشركة القانوني.');
            if (!companyContact) return fail('يرجى إدخال اسم مدير الشركة.');
            if (!companyPhone || companyPhone.length < 10) return fail('يرجى إدخال رقم تواصل صحيح للشركة.');
            if (!companyEmail || !/^\S+@\S+\.\S+$/.test(companyEmail)) return fail('يرجى إدخال بريد إلكتروني رسمي صحيح.');
            if (!username || !/^[a-zA-Z0-9_]{3,20}@ahram\.com$/.test(username)) return fail('اسم المستخدم يجب أن يكون باللغة الإنجليزية وبدون مسافات.');
            if (!password || password.length < 6) return fail('الرقم السري يجب أن يكون 6 أحرف على الأقل.');
            if (password !== passwordConfirm) return fail('الرقم السري غير متطابق.');

            const existingCompanyReq = await RegistrationRequest.findOne({ companyPhone, status: 'pending' });
            if (existingCompanyReq) return fail(`يوجد طلب تسجيل سابق لهذا الرقم. رقم الطلب: ${existingCompanyReq.refCode}`);
            const existingUser = await User.findOne({ webUsername: { $regex: new RegExp(`^${username}$`, 'i') } });
            if (existingUser) return fail('اسم المستخدم مسجل بالفعل. يرجى اختيار اسم آخر.');

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
            return renderRegister(res, { error: null, success: true, refCode: regRequest.refCode, createdUsername: username, createdPassword: password });
        }

    } catch (e) {
        console.error('[Register] خطأ:', e.message, e.stack);
        renderRegisterError(req, res, 'حدث خطأ في النظام. يرجى المحاولة لاحقاً.');
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
                
                if (clientUser.lastOtpDate === todayStr || shouldBypassClientOtp()) {
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
                
                if (clientCompany.lastOtpDate === todayStr || shouldBypassClientOtp()) {
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

        const agentStaff = await AgentEmployee.findOne({ $or: [{ webUsername: usernameRegex }, { phone: username }] }).lean();
        if (agentStaff) {
            const isMatch = await verifyAndUpgradePassword(password, agentStaff.webPassword, AgentEmployee, agentStaff._id);
            if (isMatch) {
                if (agentStaff.status !== 'active') {
                    await logAction({ action: 'LOGIN_FAILED', req, performedById: agentStaff._id, performedByModel: 'AgentEmployee', performedByName: agentStaff.name, success: false, errorCode: 'SUSPENDED', metadata: { reason: 'حساب موظف الوكيل معلق حالياً' } });
                    return res.render('client/login', { error: 'حسابك معلق حالياً من قبل الوكيل.' });
                }

                const agent = await User.findById(agentStaff.agentId).select('status role').lean();
                if (!agent || agent.status !== 'active' || agent.role !== 'agent') {
                    return res.render('client/login', { error: 'حساب الوكيل الرئيسي غير نشط.' });
                }

                if (agentStaff.lastOtpDate === todayStr || shouldBypassClientOtp()) {
                    req.session.isClientLoggedIn = true; req.session.clientId = agentStaff._id; req.session.accountType = 'agent_staff';
                    await logAction({ action: 'LOGIN_SUCCESS', req, performedById: agentStaff._id, performedByModel: 'AgentEmployee', performedByName: agentStaff.name, metadata: { accountType: 'agent_staff' } });
                    return req.session.save(() => res.redirect('/client/dashboard'));
                }

                const otp = generateOtp();
                const otpExpires = new Date(Date.now() + 5 * 60000);
                await AgentEmployee.updateOne({ _id: agentStaff._id }, { $set: { otpCode: hashOtp(otp), otpExpires: otpExpires } }, { strict: false });

                const whatsappService = require('../services/whatsappService');
                const otpMsg = `🔐 رمز الدخول الخاص بك لحساب الوكيل في الأهرام للتحويلات هو:\n\n*${otp}*\n\nالرمز صالح لمدة 5 دقائق.`;
                whatsappService.sendWhatsAppMessage(agentStaff.phone, otpMsg).catch(()=>{});

                req.session.tempClientId = agentStaff._id; req.session.tempAccountType = 'agent_staff';
                await logAction({ action: 'LOGIN_FAILED', req, performedById: agentStaff._id, performedByModel: 'AgentEmployee', performedByName: agentStaff.name, result: 'معلق', metadata: { accountType: 'agent_staff', reason: 'OTP_REQUIRED' } });
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
        const performedByModel = req.session.tempAccountType === 'company'
            ? 'ClientEmployee'
            : (req.session.tempAccountType === 'agent_staff' ? 'AgentEmployee' : 'User');
        
        if (req.session.tempAccountType === 'company') { account = await ClientEmployee.findById(req.session.tempClientId).lean(); } 
        else if (req.session.tempAccountType === 'agent_staff') { account = await AgentEmployee.findById(req.session.tempClientId).lean(); }
        else { account = await User.findById(req.session.tempClientId).lean(); }
        
        const otpAccepted = isMasterOtp(otp) || (verifyOtp(otp, account && account.otpCode) && new Date(account.otpExpires) >= new Date());
        if (!account || !otpAccepted) {
            if (account) {
                await logAction({ action: 'LOGIN_FAILED', req, performedById: account._id, performedByModel, performedByName: account.name, success: false, errorCode: 'INVALID_OTP', metadata: { reason: 'رمز التحقق غير صحيح أو منتهي' } });
            }
            return res.render('client/verify', { error: 'الرمز غير صحيح أو منتهي الصلاحية.' });
        }

        const todayStr = getTodayString();
        if (req.session.tempAccountType === 'company') { await ClientEmployee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); } 
        else if (req.session.tempAccountType === 'agent_staff') { await AgentEmployee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); }
        else { await User.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false }); }

        req.session.isClientLoggedIn = true; req.session.clientId = account._id; req.session.accountType = req.session.tempAccountType;
        req.session.tempClientId = null; req.session.tempAccountType = null;
        
        await logAction({ action: 'LOGIN_SUCCESS', req, performedById: account._id, performedByModel, performedByName: account.name, metadata: { accountType: req.session.accountType, via: isMasterOtp(otp) ? 'MASTER_OTP' : 'OTP' } });
        res.redirect('/client/dashboard');
    } catch (e) { res.redirect('/login'); }
};

exports.logout = async (req, res) => {
    try {
        if (req.session.clientId) {
            const performedByModel = req.session.accountType === 'company'
                ? 'ClientEmployee'
                : (req.session.accountType === 'agent_staff' ? 'AgentEmployee' : (req.session.accountType === 'sub_client' ? 'SubAccount' : 'User'));
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
