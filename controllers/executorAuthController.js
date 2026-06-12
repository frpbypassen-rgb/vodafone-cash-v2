const Employee = require('../models/Employee');
const RegistrationRequest = require('../models/RegistrationRequest');
const Admin = require('../models/Admin');
const { escapeRegex, verifyAndUpgradePassword, getTodayString } = require('../utils/helpers');
const { verifyOtp } = require('../utils/otp');



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
                if (executor.status !== 'active') return res.render('executor/login', { error: 'حسابك معلق حالياً من قبل الإدارة.' });

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
    res.render('executor/register', { error: null, success: null });
};

exports.postRegister = async (req, res) => {
    try {
        const { companyName, managerName, phone, webUsername, webPassword, confirmPassword } = req.body;
        
        if (!companyName || !managerName || !phone || !webUsername || !webPassword || !confirmPassword) {
            return res.render('executor/register', { error: 'يرجى ملء جميع الحقول المطلوبة.', success: null });
        }
        
        if (webPassword !== confirmPassword) {
            return res.render('executor/register', { error: 'كلمات المرور غير متطابقة.', success: null });
        }
        
        let finalUsername = webUsername.trim();
        const prefix = finalUsername.endsWith('@ahram.com') ? finalUsername.split('@ahram.com')[0] : finalUsername;

        if (!/^[a-zA-Z0-9_]+$/.test(prefix)) {
            return res.render('executor/register', { error: 'اسم المستخدم يجب أن يحتوي على أحرف إنجليزية وأرقام فقط.', success: null });
        }
        
        finalUsername = prefix + '@ahram.com';
        
        const existingEmployee = await Employee.findOne({ webUsername: finalUsername });
        if (existingEmployee) {
            return res.render('executor/register', { error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر.', success: null });
        }
        
        const existingRequest = await RegistrationRequest.findOne({ phone, status: 'pending' });
        if (existingRequest) {
            return res.render('executor/register', { 
                error: `يوجد طلب تسجيل سابق لهذا الرقم برقم مرجعي: ${existingRequest.refCode}. يرجى انتظار المراجعة.`, 
                success: null 
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
        
        const successMsg = `تم تسجيل طلبك بنجاح! حسابك قيد المراجعة.<br><br><div class="text-start p-3 mt-2 rounded" style="background: rgba(0,0,0,0.2); border: 1px dashed var(--brand-neon);"><div class="mb-2"><span class="text-muted small d-block">رقم الطلب المرجعي:</span><span class="fs-5 text-warning font-monospace" dir="ltr">${regRequest.refCode}</span></div><div class="mb-2"><span class="text-muted small d-block">اسم المستخدم:</span><span class="fs-5 text-white font-monospace" dir="ltr">${finalUsername}</span></div><div><span class="text-muted small d-block">كلمة المرور:</span><span class="fs-5 text-white font-monospace" dir="ltr">${webPassword}</span></div></div><div class="mt-3 small">يرجى الاحتفاظ ببيانات الدخول. سيتم تفعيل حسابك بعد موافقة الإدارة.</div>`; 
        
        res.render('executor/register', { error: null, success: successMsg });
    } catch (e) {
        console.error(e);
        res.render('executor/register', { error: 'حدث خطأ داخلي، يرجى المحاولة لاحقاً.', success: null });
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
