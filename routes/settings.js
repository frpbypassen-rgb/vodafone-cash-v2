const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const Settings = require('../models/Settings');
const ExecutorBot = require('../models/ExecutorGroup');
const ClientBot = require('../models/ClientBot');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { pickAllowed } = require('../middlewares/sanitize');
const { hashPassword } = require('../services/passwordService');
const {
    SERVICE_RATE_ADMIN_FIELDS,
    getAdminRateServices,
    getCompanyRateConfig,
    getServiceRateForTier,
    SERVICE_RATE_KEYS,
    synchronizeVodafoneLinkedRateFields
} = require('../utils/rateHelper');
const { getEnabledMobileTransferServices } = require('../utils/mobileTransferServiceCatalog');
const {
    executorSupportsTransferType,
    getExecutorServiceLabel
} = require('../utils/executorServiceCatalog');
const { getWhatChimpConfigurationStatus, getWhatChimpTemplateReadiness, testWhatChimpConnection } = require('../services/whatsappService');
const { getPublicAppUrl, getReceiptShareSecret } = require('../services/receiptShareService');
const { scheduleRateUpdate } = require('../services/rateChangeService');
const { normalizeDelaySeconds, formatDelay } = require('../services/rateAlerts/rateAlertAudienceService');

const AUTO_ROUTE_INPUT_FIELDS = SERVICE_RATE_KEYS.map((serviceKey) => `autoRouteExecutor_${serviceKey}`);

router.use(requireAuth);

// =========================================================
// الحقول المسموحة لكل نوع إعداد — حماية من Mass Assignment
// =========================================================
const ALLOWED_MAIN_SETTINGS = [
    'rateLevel1', 'rateLevel2', 'rateLevel3',
    ...SERVICE_RATE_ADMIN_FIELDS,
    'openingTime', 'closingTime', 'isManualClosed',
    'supportContact', 'rateChangeDelay', 'autoRouteEnabled', 'autoRouteBotId',
    ...AUTO_ROUTE_INPUT_FIELDS
];

const ALLOWED_CONTENT_SETTINGS = [
    'welcomeMessage', 'termsMessage', 'closedMessage',
    'executorWelcomeMessage', 'executorPendingMessage', 'executorBannedMessage'
];

const ALLOWED_CLIENT_BOT_FIELDS = [
    'name', 'token', 'welcomeMessage', 'status',
    'rateLevel1', 'rateLevel2', 'rateLevel3'
];

const parseRateChangeDelay = (value, fallback) => {
    const raw = String(value ?? '').trim();
    const match = raw.match(/^(\d{1,2}):([0-5]\d)$/);
    if (match) return normalizeDelaySeconds((Number(match[1]) * 60) + Number(match[2]));
    return normalizeDelaySeconds(fallback);
};

// =========================================================
// الإعدادات الرئيسية
// =========================================================
router.get('/', async (req, res) => {
    const settings = await Settings.findOne({}) || await Settings.create({});
    const [executorBots, companies] = await Promise.all([
        ExecutorBot.find({ status: 'active', isManagerBot: { $ne: true } }),
        ClientCompany.find({ status: { $ne: 'deleted' } }).sort({ name: 1 }).lean()
    ]);
    const rateServices = getAdminRateServices().map((service) => ({
        ...service,
        values: {
            level1: getServiceRateForTier(service.key, 1, settings),
            level2: getServiceRateForTier(service.key, 2, settings),
            level3: getServiceRateForTier(service.key, 3, settings)
        }
    }));
    const explicitRules = Array.isArray(settings.autoRouteRules) ? settings.autoRouteRules : [];
    const legacyExecutor = explicitRules.length === 0 && settings.autoRouteBotId
        ? executorBots.find((bot) => String(bot._id) === String(settings.autoRouteBotId))
        : null;
    const autoRouteRows = getEnabledMobileTransferServices().map((service) => {
        const rule = explicitRules.find((item) => item.serviceKey === service.key);
        const legacySelected = legacyExecutor && executorSupportsTransferType(legacyExecutor, service.key)
            ? legacyExecutor._id
            : null;
        return {
            key: service.key,
            label: service.label,
            selectedExecutorId: rule?.executorGroupId || legacySelected || null,
            executors: executorBots
                .filter((bot) => executorSupportsTransferType(bot, service.key))
                .map((bot) => ({
                    _id: bot._id,
                    name: bot.name,
                    isApiBot: bot.isApiBot,
                    serviceLabel: getExecutorServiceLabel(bot)
                }))
        };
    });
    const companyRateRows = companies.map((company) => ({
        company,
        rateConfig: getCompanyRateConfig(company, settings)
    }));
    const baseWhatsAppStatus = await getWhatChimpTemplateReadiness().catch(() => getWhatChimpConfigurationStatus());
    const receiptLinkReady = Boolean(getPublicAppUrl() && getReceiptShareSecret());
    const whatsAppStatus = {
        ...baseWhatsAppStatus,
        receiptLinkReady,
        receiptOperational: Boolean(baseWhatsAppStatus.receiptOperational && receiptLinkReady),
        missing: [
            ...baseWhatsAppStatus.missing,
            ...(!receiptLinkReady ? ['PUBLIC_APP_URL (HTTPS)', 'RECEIPT_SHARE_SECRET'] : [])
        ]
    };
    res.render('settings', {
        settings,
        pendingRateUpdate: settings.pendingRateUpdate?.effectiveAt
            && new Date(settings.pendingRateUpdate.effectiveAt).getTime() > Date.now()
            ? {
                effectiveAt: new Date(settings.pendingRateUpdate.effectiveAt).toISOString(),
                changes: settings.pendingRateUpdate.changes || {},
                delaySeconds: settings.pendingRateUpdate.delaySeconds || settings.rateChangeDelaySeconds || 60
            }
            : null,
        executorBots,
        rateServices,
        companyRateRows,
        autoRouteRows,
        whatsAppStatus,
        query: req.query
    });
});

router.post('/whatsapp/test', requireMaster, async (req, res) => {
    try {
        const result = await testWhatChimpConnection();
        return res.redirect(`/settings?whatsAppTest=${result.success ? 'success' : 'failed'}#whatsapp-integration`);
    } catch (error) {
        console.error('[settings/whatsapp/test] failed:', error.message);
        return res.redirect('/settings?whatsAppTest=failed#whatsapp-integration');
    }
});

router.get('/bots', requireMaster, (req, res) => {
    res.redirect('/executors?openCreate=1');
});

router.post('/update', requireMaster, async (req, res) => {
    try {
        const data = pickAllowed(req.body, ALLOWED_MAIN_SETTINGS);
        data.isManualClosed = data.isManualClosed === 'true' || data.isManualClosed === true;
        data.autoRouteEnabled = data.autoRouteEnabled === 'true' || data.autoRouteEnabled === true;
        if (!data.autoRouteBotId || data.autoRouteBotId === '') data.autoRouteBotId = null;
        // تحقق من القيم الرقمية
        ['rateLevel1', 'rateLevel2', 'rateLevel3', ...SERVICE_RATE_ADMIN_FIELDS].forEach(field => {
            if (data[field] !== undefined) data[field] = parseFloat(data[field]) || 0;
        });
        const synchronizedData = synchronizeVodafoneLinkedRateFields(data);
        const submittedRateChangeDelay = synchronizedData.rateChangeDelay;
        delete synchronizedData.rateChangeDelay;

        const requestedRules = SERVICE_RATE_KEYS.map((serviceKey) => ({
            serviceKey,
            executorGroupId: String(synchronizedData[`autoRouteExecutor_${serviceKey}`] || '').trim()
        })).filter((rule) => rule.executorGroupId);
        AUTO_ROUTE_INPUT_FIELDS.forEach((field) => delete synchronizedData[field]);

        if (requestedRules.length === 0 && synchronizedData.autoRouteBotId) {
            const legacyExecutor = await ExecutorBot.findById(synchronizedData.autoRouteBotId);
            if (legacyExecutor) {
                SERVICE_RATE_KEYS.forEach((serviceKey) => {
                    if (executorSupportsTransferType(legacyExecutor, serviceKey)) {
                        requestedRules.push({ serviceKey, executorGroupId: String(legacyExecutor._id) });
                    }
                });
            }
        }

        const selectedExecutorIds = [...new Set(requestedRules.map((rule) => rule.executorGroupId))];
        const selectedExecutors = selectedExecutorIds.length
            ? await ExecutorBot.find({
                _id: { $in: selectedExecutorIds },
                status: 'active',
                isManagerBot: { $ne: true }
            })
            : [];
        const executorById = new Map(selectedExecutors.map((executor) => [String(executor._id), executor]));
        const invalidRule = requestedRules.find((rule) => {
            const executor = executorById.get(rule.executorGroupId);
            return !executor || !executorSupportsTransferType(executor, rule.serviceKey);
        });
        if (invalidRule) {
            return res.redirect('/settings?autoRouteError=service_mismatch#auto-routing');
        }

        const settings = await Settings.findOne({}) || new Settings();
        const rateChangeDelaySeconds = parseRateChangeDelay(
            submittedRateChangeDelay,
            settings.rateChangeDelaySeconds || 60
        );
        synchronizedData.rateChangeDelaySeconds = rateChangeDelaySeconds;
        const hasPendingRateUpdate = settings.pendingRateUpdate?.effectiveAt
            && new Date(settings.pendingRateUpdate.effectiveAt).getTime() > Date.now();
        // Keep a scheduled update when another form setting is saved during its
        // countdown. The form submits active rate values, which must not erase
        // a rate that is already waiting to be activated.
        const rateChanges = hasPendingRateUpdate
            ? { ...(settings.pendingRateUpdate.changes || {}) }
            : {};
        let receivedRateField = false;
        let pendingRateWasChanged = false;
        [...SERVICE_RATE_ADMIN_FIELDS, 'rateLevel1', 'rateLevel2', 'rateLevel3'].forEach((field) => {
            if (synchronizedData[field] !== undefined) {
                receivedRateField = true;
                const nextValue = synchronizedData[field];
                delete synchronizedData[field];
                if (Number(nextValue) === Number(settings[field])) {
                    if (!hasPendingRateUpdate) delete rateChanges[field];
                } else {
                    if (Number(rateChanges[field]) !== Number(nextValue)) {
                        pendingRateWasChanged = true;
                    }
                    rateChanges[field] = nextValue;
                }
            }
        });
        synchronizedData.autoRouteRules = requestedRules;
        synchronizedData.autoRouteBotId = requestedRules[0]?.executorGroupId || null;
        Object.assign(settings, synchronizedData);
        if (receivedRateField && !Object.keys(rateChanges).length) {
            settings.pendingRateUpdate = undefined;
        }
        await settings.save();
        const shouldScheduleRateUpdate = Object.keys(rateChanges).length > 0
            && (!hasPendingRateUpdate || pendingRateWasChanged);
        if (shouldScheduleRateUpdate) {
            await scheduleRateUpdate({
                settings,
                changes: rateChanges,
                actor: req.session?.adminName || req.session?.username || 'الإدارة',
                app: req.app,
                delaySeconds: rateChangeDelaySeconds
            });
        }
        const io = req.app?.get('io');
        if (io) {
            // لا نعلن تطبيق السعر قبل انتهاء مهلة الإشعار.
            if (!Object.keys(rateChanges).length) {
                io.emit('exchange_rates_updated', { source: 'general' });
            }
            io.emit('update_data');
        }
        const result = shouldScheduleRateUpdate
            ? 'ratesScheduled=1'
            : (Object.keys(rateChanges).length ? 'ratesPending=1' : 'ratesUpdated=1');
        res.redirect(`/settings?${result}&rateDelay=${encodeURIComponent(formatDelay(rateChangeDelaySeconds))}#company-rates`);
    } catch (e) {
        console.error('[settings/update] خطأ:', e.message);
        res.redirect('/settings');
    }
});

// =========================================================
// إدارة حسابات العملاء على الويب
// =========================================================
router.get('/clients-web', async (req, res) => {
    const users = await User.find({ status: 'active' });
    const companies = await ClientBot.find({ status: 'active' });
    const allClientEmployees = await ClientEmployee.find({ status: 'active' });
    const webUsers = await User.find({ webUsername: { $exists: true, $nin: [null, ""] } });
    const webEmployeesRaw = await ClientEmployee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('companyId');
    const webEmployees = webEmployeesRaw.map(e => ({
        _id: e._id, name: e.name, role: e.role, webUsername: e.webUsername,
        webPassword: '••••••', // لا نعرض كلمة المرور في الواجهة
        companyName: e.companyId ? e.companyId.name : 'شركة محذوفة', status: e.status
    }));
    res.render('settings_clients_web', { users, companies, allClientEmployees, webUsers, webEmployees, query: req.query });
});

// ✅ إصلاح: تشفير كلمة المرور قبل الحفظ
router.post('/clients-web/add', requireMaster, async (req, res) => {
    try {
        const { accountType, accountId, employeeId, webUsername, webPassword } = req.body;
        if (!webUsername || !webPassword) return res.redirect('/settings/clients-web?error=missing');
        
        const user = webUsername.trim().toLowerCase();
        const hashedPass = await hashPassword(webPassword);

        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, { webUsername: user, webPassword: hashedPass });
        } else {
            if (employeeId) await ClientEmployee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: hashedPass });
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (e) {
        console.error('[settings/clients-web/add] خطأ:', e.message);
        res.redirect('/settings/clients-web?error=true');
    }
});

// ✅ إصلاح: تشفير كلمة المرور عند التعديل
router.post('/clients-web/edit', requireMaster, async (req, res) => {
    try {
        const { accountType, accountId, webUsername, webPassword } = req.body;
        if (!webUsername || !accountId) return res.redirect('/settings/clients-web?error=missing');

        const user = webUsername.trim().toLowerCase();
        const updateData = { webUsername: user };

        // تشفير كلمة المرور فقط إذا تم إرسالها
        if (webPassword && webPassword.trim()) {
            updateData.webPassword = await hashPassword(webPassword);
        }

        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, updateData);
        } else if (accountType === 'employee') {
            await ClientEmployee.findByIdAndUpdate(accountId, updateData);
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) {
        console.error('[settings/clients-web/edit] خطأ:', error.message);
        res.redirect('/settings/clients-web?error=true');
    }
});

router.post('/clients-web/delete', requireMaster, async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') {
            await User.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } });
        } else if (accountType === 'employee') {
            await ClientEmployee.findByIdAndUpdate(accountId, { $unset: { webUsername: "", webPassword: "" } });
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) {
        console.error('[settings/clients-web/delete] خطأ:', error.message);
        res.redirect('/settings/clients-web?error=true');
    }
});

router.post('/clients-web/toggle', requireMaster, async (req, res) => {
    try {
        const { accountType, accountId } = req.body;
        if (accountType === 'user') {
            const account = await User.findById(accountId);
            if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); }
        } else if (accountType === 'employee') {
            const account = await ClientEmployee.findById(accountId);
            if(account) { account.status = account.status === 'active' ? 'banned' : 'active'; await account.save(); }
        }
        res.redirect('/settings/clients-web?success=true');
    } catch (error) {
        console.error('[settings/clients-web/toggle] خطأ:', error.message);
        res.redirect('/settings/clients-web?error=true');
    }
});

// =========================================================
// إدارة حسابات المنفذين على الويب
// =========================================================
router.get('/executors-web', async (req, res) => {
    try {
        const employees = await Employee.find({ status: 'active' }).populate('botId');
        const webExecutors = await Employee.find({ webUsername: { $exists: true, $nin: [null, ""] } }).populate('botId');
        res.render('settings_executors_web', { employees, webExecutors, query: req.query });
    } catch (e) {
        console.error('[settings/executors-web] خطأ:', e.message);
        res.redirect('/');
    }
});

// ✅ إصلاح: تشفير كلمة المرور
router.post('/executors-web/add', requireMaster, async (req, res) => {
    try {
        const { employeeId, webUsername, webPassword } = req.body;
        if (!employeeId || !webUsername || !webPassword) return res.redirect('/settings/executors-web?error=missing');
        
        const user = webUsername.trim().toLowerCase();
        const hashedPass = await hashPassword(webPassword);
        await Employee.findByIdAndUpdate(employeeId, { webUsername: user, webPassword: hashedPass });
        res.redirect('/settings/executors-web?success=true');
    } catch (e) {
        console.error('[settings/executors-web/add] خطأ:', e.message);
        res.redirect('/settings/executors-web?error=true');
    }
});

router.post('/executors-web/delete', requireMaster, async (req, res) => {
    try {
        const { employeeId } = req.body;
        await Employee.findByIdAndUpdate(employeeId, { $unset: { webUsername: "", webPassword: "" } });
        res.redirect('/settings/executors-web?success=true');
    } catch (e) {
        console.error('[settings/executors-web/delete] خطأ:', e.message);
        res.redirect('/settings/executors-web?error=true');
    }
});

// =========================================================
// إدارة مستخدمي لوحة التحكم — Master فقط
// =========================================================
router.get('/users', requireMaster, async (req, res) => {
    const webAdmins = await Admin.find({ webUsername: { $exists: true, $ne: null } }).sort({ createdAt: -1 });
    res.render('settings_users', { webAdmins });
});

// ✅ إصلاح: bcrypt عند إنشاء مستخدم جديد (pre('save') hook موجود في Admin model)
router.post('/users/add', requireMaster, async (req, res) => {
    try {
        const { name, webUsername, webPassword } = req.body;
        if (!name || !webUsername || !webPassword) return res.redirect('/settings/users');
        
        await Admin.create({ 
            name: name.trim(), 
            webUsername: webUsername.trim().toLowerCase(), 
            webPassword: webPassword.trim(), // سيتم تشفيره في pre('save') hook
            role: 'admin' 
        });
        res.redirect('/settings/users');
    } catch (e) {
        console.error('[settings/users/add] خطأ:', e.message);
        res.redirect('/settings/users');
    }
});

router.post('/users/delete/:id', requireMaster, async (req, res) => {
    try {
        await Admin.findByIdAndDelete(req.params.id);
        res.redirect('/settings/users');
    } catch(e) {
        console.error('[settings/users/delete] خطأ:', e.message);
        res.redirect('/settings/users');
    }
});

module.exports = router;
