const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const RegistrationRequest = require('../models/RegistrationRequest');
const { getTodayString } = require('../utils/helpers');
const { verifyOtp } = require('../utils/otp');
const { establishAuthenticatedSession } = require('../utils/sessionSecurity');
const { logAction } = require('../services/auditService');
const securityControl = require('../services/securityControlService');
const { isPasskeyRequired } = require('../config/securityPolicy');
const { checkRegistrationIdentityAvailability } = require('../services/registrationIdentityService');

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

            const identityCheck = await checkRegistrationIdentityAvailability({ phone, username });
            if (!identityCheck.success) return fail(identityCheck.message);

            const regRequest = await RegistrationRequest.create({
                accountType, fullName, phone, storeName, address, username, password,
                tenantId: (req.tenant && req.tenant._id) || undefined,
                ...identityCheck.requestMetadata,
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

            const identityCheck = await checkRegistrationIdentityAvailability({ phone, username });
            if (!identityCheck.success) return fail(identityCheck.message, {
                restoreNewAgentVerified: true,
                restoredAgentName: agent.name || agent.webUsername || 'وكيل معتمد'
            });

            const regRequest = await RegistrationRequest.create({
                accountType,
                tenantId: (req.tenant && req.tenant._id) || agent.tenantId || undefined,
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
                ...identityCheck.requestMetadata,
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

            const identityCheck = await checkRegistrationIdentityAvailability({ phone, username });
            if (!identityCheck.success) return fail(identityCheck.message);

            const regRequest = await RegistrationRequest.create({
                accountType, companyName, fullName, phone, address, companyEmail, username, password,
                tenantId: (req.tenant && req.tenant._id) || undefined,
                ...identityCheck.requestMetadata,
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

            const identityCheck = await checkRegistrationIdentityAvailability({ phone: companyPhone, username });
            if (!identityCheck.success) return fail(identityCheck.message);

            const regRequest = await RegistrationRequest.create({
                accountType, companyName, companyContact, companyPhone, companyEmail, username, password,
                tenantId: (req.tenant && req.tenant._id) || undefined,
                ...identityCheck.requestMetadata,
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

exports.postLogin = (req, res) => {
    // The unified login route owns authentication. Keep this legacy entry point closed.
    return res.redirect(307, '/login');
};
exports.getVerify = (req, res) => {
    if (!req.session.tempClientId) return res.redirect('/login');
    res.render('client/verify', { error: null });
};

exports.postVerify = async (req, res) => {
    try {
        const otp = String(req.body.otp || '').trim();
        const accountId = req.session.tempClientId;
        const accountType = req.session.tempAccountType;
        const otpChallengeId = String(req.session.otpChallengeId || '');
        const performedByModel = accountType === 'company'
            ? 'ClientEmployee'
            : (accountType === 'agent_staff' ? 'AgentEmployee' : (accountType === 'sub_client' ? 'SubAccount' : 'User'));
        const AccountModel = accountType === 'company'
            ? ClientEmployee
            : (accountType === 'agent_staff' ? AgentEmployee : (accountType === 'sub_client' ? SubAccount : User));

        if (!accountId || !accountType || !otpChallengeId || !otp) return res.redirect('/login');

        const account = await AccountModel.findById(accountId).lean();
        const otpAccepted = Boolean(
            account
            && account.otpChallengeId === otpChallengeId
            && account.otpExpires
            && new Date(account.otpExpires) >= new Date()
            && verifyOtp(otp, account.otpCode)
        );
        if (!otpAccepted) {
            if (account) {
                await logAction({ action: 'LOGIN_FAILED', req, performedById: account._id, performedByModel, performedByName: account.name, success: false, errorCode: 'INVALID_OTP', metadata: { reason: 'رمز التحقق غير صحيح أو منتهي' } });

                const updated = await AccountModel.findOneAndUpdate(
                    { _id: account._id, otpChallengeId },
                    { $inc: { otpAttempts: 1 } },
                    { new: true }
                ).lean();
                if (Number(updated?.otpAttempts || 0) >= 5) {
                    await AccountModel.updateOne(
                        { _id: account._id, otpChallengeId },
                        { $unset: { otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1, otpAttempts: 1 } }
                    );
                    return res.render('client/verify', { error: 'تم تجاوز عدد المحاولات. سجل الدخول من جديد للحصول على رمز آخر.' });
                }
            }
            return res.render('client/verify', { error: 'الرمز غير صحيح أو منتهي الصلاحية.' });
        }

        const todayStr = getTodayString();
        const consumedAccount = await AccountModel.findOneAndUpdate(
            {
                _id: account._id,
                otpCode: account.otpCode,
                otpChallengeId,
                otpExpires: { $gte: new Date() }
            },
            {
                $set: { lastOtpDate: todayStr },
                $unset: { otpCode: 1, otpExpires: 1, otpChallengeId: 1, otpIssuedAt: 1, otpAttempts: 1 }
            },
            { new: true }
        ).lean();
        if (!consumedAccount) {
            return res.render('client/verify', { error: 'تم استخدام الرمز أو انتهت صلاحيته. سجل الدخول من جديد.' });
        }

        const principalType = ({
            user: 'client_user',
            company: 'client_company',
            agent_staff: 'agent_staff',
            sub_client: 'sub_client'
        })[accountType] || 'client_user';
        const principal = {
            principalType,
            principalId: String(account._id),
            principalName: account.name || account.webUsername || 'حساب عميل'
        };
        const authorization = await securityControl.authorizeLogin({
            req,
            res,
            principal,
            accountClass: 'account',
            allowFirstDevice: true
        });
        if (!authorization.allowed) {
            return res.render('client/verify', { error: authorization.message });
        }

        if (isPasskeyRequired() && authorization.device?.credentialId) {
            req.session.pendingPasskeyLogin = {
                ...principal,
                loginKind: 'client',
                accountType,
                username: req.session.pendingSecurityUsername || '',
                createdAt: Date.now()
            };
            delete req.session.tempClientId;
            delete req.session.tempAccountType;
            delete req.session.otpChallengeId;
            return req.session.save(() => res.redirect('/login?passkey=1'));
        }

        const pendingLocation = req.session.pendingSecurityLocation || null;
        await establishAuthenticatedSession(req, {
            isClientLoggedIn: true,
            clientId: account._id,
            accountType,
            clientName: principal.principalName,
            pendingSecurityLocation: pendingLocation
        });
        await securityControl.applySessionSecurity(req, principal, 'account');
        delete req.session.pendingSecurityLocation;
        delete req.session.pendingSecurityUsername;

        await logAction({
            action: 'LOGIN_SUCCESS',
            req,
            performedById: account._id,
            performedByModel,
            performedByName: account.name,
            metadata: { accountType, via: 'OTP' }
        });
        return req.session.save(() => res.redirect('/client/dashboard'));
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
