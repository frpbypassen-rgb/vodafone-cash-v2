const Employee = require('../models/Employee');
const RegistrationRequest = require('../models/RegistrationRequest');
const Admin = require('../models/Admin');
const { escapeRegex, verifyAndUpgradePassword, getTodayString } = require('../utils/helpers');
const { verifyOtp } = require('../utils/otp');
const {
    ExecutorAccountError,
    normalizeExecutorPhone,
    normalizeExecutorUsername
} = require('../services/executorAccountService');

const executorRegistrationFormData = (body = {}) => ({
    companyName: String(body.companyName || '').trim(),
    managerName: String(body.managerName || '').trim(),
    phone: String(body.phone || '').trim(),
    webUsername: String(body.webUsername || '').trim().replace(/@ahram\.com$/i, '')
});

const renderExecutorRegistration = (res, { error = null, success = null, formData = {} } = {}) => (
    res.render('executor/register', { error, success, formData })
);


exports.getLogin = (req, res) => {
    if (req.session.isExecutorLoggedIn) return res.redirect('/executor-portal/dashboard');
    res.redirect('/login');
};

exports.postLogin = async (req, res) => {
    try {
        const username = req.body.username?.trim();
        const password = req.body.password?.trim();

        if (!username || !password) return res.render('executor/login', { error: 'يرجى إدخال البيانات.' });

        const safeUsername = escapeRegex(username);
        const usernameRegex = new RegExp('^' + safeUsername + '$', 'i');
        const todayStr = getTodayString();

        const executor = await Employee.findOne({ 
            $or: [{ webUsername: usernameRegex }, { phone: username }]
        }).populate('groupId').lean();

        if (executor) {
            const isMatch = await verifyAndUpgradePassword(password, executor.webPassword, Employee, executor._id);

            if (isMatch) {
                if (executor.status !== 'active' || !executor.groupId || executor.groupId.status !== 'active') {
                    return res.render('executor/login', { error: 'حسابك أو مجموعة التنفيذ غير مفعلة حالياً.' });
                }

                // دخول مباشر بدون OTP (بعد إلغاء التيليجرام)
                req.session.isExecutorLoggedIn = true; 
                req.session.executorId = executor._id; 
                req.session.executorGroupId = executor.groupId ? executor.groupId._id : null;
                return req.session.save(() => res.redirect('/executor-portal/dashboard')); 
            }
        }

        return res.render('executor/login', { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });

    } catch (e) {
        console.error(e);
        res.render('executor/login', { error: 'حدث خطأ في النظام.' });
    }
};

exports.getRegister = (req, res) => {
    if (req.session.isExecutorLoggedIn) return res.redirect('/executor-portal/dashboard');
    renderExecutorRegistration(res);
};

exports.postRegister = async (req, res) => {
    const formData = executorRegistrationFormData(req.body);
    try {
        const companyName = formData.companyName;
        const managerName = formData.managerName;
        const { webPassword, confirmPassword } = req.body;
        
        if (!companyName || !managerName || !formData.phone || !formData.webUsername || !webPassword || !confirmPassword) {
            return renderExecutorRegistration(res, { error: 'يرجى ملء جميع الحقول المطلوبة.', formData });
        }
        if (companyName.length < 3 || managerName.length < 3) {
            return renderExecutorRegistration(res, { error: 'يرجى إدخال اسم المنفذ واسم المسؤول بشكل كامل.', formData });
        }
        if (webPassword !== confirmPassword) {
            return renderExecutorRegistration(res, { error: 'كلمات المرور غير متطابقة.', formData });
        }
        if (String(webPassword).length < 6) {
            return renderExecutorRegistration(res, { error: 'كلمة المرور يجب ألا تقل عن 6 أحرف.', formData });
        }

        const finalUsername = normalizeExecutorUsername(formData.webUsername);
        const phone = normalizeExecutorPhone(formData.phone);
        const usernameRegex = new RegExp(`^${escapeRegex(finalUsername)}$`, 'i');
        
        const existingEmployee = await Employee.exists({ webUsername: usernameRegex });
        if (existingEmployee) {
            return renderExecutorRegistration(res, { error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.', formData });
        }
        
        const existingRequest = await RegistrationRequest.findOne({
            status: 'pending',
            $or: [{ phone }, { username: usernameRegex }]
        }).lean();
        if (existingRequest) {
            return renderExecutorRegistration(res, {
                error: `يوجد طلب تسجيل سابق بهذه البيانات برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`,
                formData
            });
        }

        const regRequest = await RegistrationRequest.create({
            accountType: 'executor',
            fullName: managerName,
            phone: phone,
            username: finalUsername,
            password: webPassword,
            companyName: companyName,
            ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown'
        });

        try {
            const Notification = require('../models/Notification');
            const admins = await Admin.find({});
            for (const admin of admins) {
                await Notification.create({
                    userId: admin.webUsername || 'admin',
                    title: 'طلب تسجيل منفذ جديد',
                    message: `🚨 طلب تسجيل منفذ جديد!\n\nالشركة: ${companyName}\nالمدير: ${managerName}\nالهاتف: ${phone}\nرقم الطلب: ${regRequest.refCode}`,
                    type: 'registration'
                }).catch(() => {});
            }
        } catch (err) { }
        
        return renderExecutorRegistration(res, {
            success: { refCode: regRequest.refCode, username: finalUsername },
            formData: {}
        });
    } catch (e) {
        console.error(e);
        const errorMessage = e instanceof ExecutorAccountError
            ? e.message
            : 'حدث خطأ داخلي، يرجى المحاولة لاحقاً.';
        return renderExecutorRegistration(res, { error: errorMessage, formData });
    }
};

exports.getVerify = (req, res) => {
    if (!req.session.tempExecutorId) return res.redirect('/login');
    res.render('executor/verify', { error: null });
};

exports.postVerify = async (req, res) => {
    try {
        const { otp } = req.body;
        const account = await Employee.findById(req.session.tempExecutorId).lean();
        
        if (!account || !verifyOtp(otp, account.otpCode) || new Date(account.otpExpires) < new Date()) {
            return res.render('executor/verify', { error: 'الرمز غير صحيح أو انتهت صلاحيته.' });
        }

        const todayStr = getTodayString();
        await Employee.updateOne({ _id: account._id }, { $set: { lastOtpDate: todayStr }, $unset: { otpCode: 1, otpExpires: 1 } }, { strict: false });

        req.session.isExecutorLoggedIn = true; req.session.executorId = account._id; req.session.executorGroupId = account.groupId;
        req.session.tempExecutorId = null;
        res.redirect('/executor-portal/dashboard');
    } catch (e) { res.redirect('/login'); }
};

exports.logout = (req, res) => { req.session.destroy(); res.redirect('/login'); };
