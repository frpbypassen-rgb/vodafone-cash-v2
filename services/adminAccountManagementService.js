'use strict';

const mongoose = require('mongoose');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Admin = require('../models/Admin');
const Settings = require('../models/Settings');
const Transaction = require('../models/Transaction');
const {
    CODE_LENGTHS,
    expectedUserCodeLength,
    validateAccountCode,
    ensureAccountCodeAvailable,
    reserveAccountCode,
    releaseAccountCodeReservation
} = require('./accountCodeService');
const {
    getExecutorServiceOptions,
    normalizeExecutorServiceKey
} = require('../utils/executorServiceCatalog');
const { buildMarginStorage } = require('../utils/agencyPricing');
const {
    normalizeCreditLimit,
    assertCreditLimitCanCoverBalance
} = require('./agencyCreditLimitService');

class AdminAccountManagementError extends Error {
    constructor(code, field = null) {
        super(code);
        this.name = 'AdminAccountManagementError';
        this.code = code;
        this.field = field;
    }
}

const ACCOUNT_TYPES = Object.freeze({
    user: Object.freeze({ modelName: 'User', label: 'عميل', Model: User }),
    agent: Object.freeze({ modelName: 'User', label: 'وكيل', Model: User }),
    company: Object.freeze({ modelName: 'ClientCompany', label: 'شركة', Model: ClientCompany }),
    subaccount: Object.freeze({ modelName: 'SubAccount', label: 'حساب عميل تابع', Model: SubAccount }),
    'client-employee': Object.freeze({ modelName: 'ClientEmployee', label: 'موظف شركة', Model: ClientEmployee }),
    'agent-employee': Object.freeze({ modelName: 'AgentEmployee', label: 'موظف وكيل', Model: AgentEmployee }),
    'executor-employee': Object.freeze({ modelName: 'Employee', label: 'موظف منفذ', Model: Employee }),
    executor: Object.freeze({ modelName: 'ExecutorGroup', label: 'منفذ تنفيذ', Model: ExecutorGroup })
});

const IDENTITY_MODELS = Object.freeze([
    { modelName: 'User', Model: User, hasPhone: true },
    { modelName: 'ClientCompany', Model: ClientCompany, hasPhone: true },
    { modelName: 'SubAccount', Model: SubAccount, hasPhone: true },
    { modelName: 'ClientEmployee', Model: ClientEmployee, hasPhone: true },
    { modelName: 'AgentEmployee', Model: AgentEmployee, hasPhone: true },
    { modelName: 'Employee', Model: Employee, hasPhone: true },
    { modelName: 'Admin', Model: Admin, hasPhone: false }
]);

const STATUS_OPTIONS = Object.freeze({
    user: Object.freeze(['active', 'inactive', 'banned']),
    agent: Object.freeze(['active', 'inactive', 'banned']),
    company: Object.freeze(['active', 'inactive', 'banned']),
    subaccount: Object.freeze(['active', 'inactive', 'banned']),
    'client-employee': Object.freeze(['active', 'inactive', 'banned']),
    'agent-employee': Object.freeze(['active', 'inactive', 'banned']),
    'executor-employee': Object.freeze(['pending', 'active', 'suspended', 'banned']),
    executor: Object.freeze(['active', 'inactive', 'paused'])
});

const ROLE_OPTIONS = Object.freeze({
    'client-employee': Object.freeze(['owner', 'employee', 'accountant']),
    'agent-employee': Object.freeze(['employee', 'accountant']),
    'executor-employee': Object.freeze(['operator', 'manager', 'accountant'])
});

const ERROR_MESSAGES = Object.freeze({
    INVALID_ACCOUNT_TYPE: 'نوع الحساب المطلوب غير صالح.',
    INVALID_ACCOUNT_ID: 'معرف الحساب غير صالح.',
    ACCOUNT_NOT_FOUND: 'الحساب غير موجود أو تم حذفه.',
    NAME_REQUIRED: 'الاسم مطلوب ويجب ألا يقل عن حرفين.',
    PHONE_REQUIRED: 'رقم الهاتف مطلوب لهذا النوع من الحسابات.',
    PHONE_INVALID: 'رقم الهاتف غير صالح. استخدم الأرقام وعلامة + فقط.',
    PHONE_TAKEN: 'رقم الهاتف مستخدم في حساب آخر.',
    USERNAME_REQUIRED: 'اسم المستخدم مطلوب.',
    USERNAME_INVALID: 'اسم المستخدم غير صالح أو يحتوي على مسافات.',
    USERNAME_TAKEN: 'اسم المستخدم مستخدم في حساب آخر.',
    PASSWORD_TOO_SHORT: 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف.',
    INVALID_STATUS: 'حالة الحساب المحددة غير صالحة.',
    INVALID_ROLE: 'صفة الموظف المحددة غير صالحة.',
    INVALID_TIER: 'مستوى السعر يجب أن يكون بين 1 و3.',
    INVALID_CREDIT_LIMIT: 'حد المديونية يجب أن يكون رقماً موجباً أو صفراً.',
    CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT: 'لا يمكن خفض حد المديونية إلى أقل من الدين الحالي للحساب.',
    INVALID_NUMBER: 'إحدى القيم الرقمية المدخلة غير صالحة.',
    INVALID_COMPANY: 'الشركة المحددة غير موجودة أو محذوفة.',
    INVALID_AGENT: 'الوكيل المحدد غير موجود أو غير صالح.',
    INVALID_EXECUTOR: 'المنفذ المحدد غير موجود أو مؤرشف.',
    INVALID_PARENT_EXECUTOR: 'مجموعة الإشراف المحددة غير صالحة.',
    INVALID_SERVICE: 'خدمة المنفذ المحددة غير صالحة.',
    ACTIVE_TASKS: 'لا يمكن تغيير خدمة المنفذ أثناء وجود عمليات قيد التنفيذ.',
    INVALID_API_URL: 'رابط API يجب أن يبدأ بـ http:// أو https://.',
    ACCOUNT_CODE_DUPLICATE: 'رقم الحساب مستخدم في حساب آخر.',
    ACCOUNT_CODE_INVALID: 'رقم الحساب لا يطابق عدد الأرقام المطلوب.',
    IDENTITY_TAKEN: 'اسم المستخدم أو رقم الهاتف مستخدم في حساب آخر.',
    UPDATE_FAILED: 'تعذر حفظ التعديلات. راجع البيانات وحاول مرة أخرى.'
});

const normalizeAccountType = (value) => String(value || '').trim().toLowerCase();
const cleanText = (value, maxLength = 160) => String(value || '').trim().slice(0, maxLength);
const isChecked = (value) => ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const sameText = (left, right) => cleanText(left).toLowerCase() === cleanText(right).toLowerCase();

const getAccountTypeDefinition = (type) => {
    const normalizedType = normalizeAccountType(type);
    const definition = ACCOUNT_TYPES[normalizedType];
    if (!definition) throw new AdminAccountManagementError('INVALID_ACCOUNT_TYPE');
    return { ...definition, type: normalizedType };
};

const assertValidId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(String(id || ''))) {
        throw new AdminAccountManagementError('INVALID_ACCOUNT_ID');
    }
};

const assertAccountMatchesType = (type, account) => {
    if (!account || account.status === 'deleted') {
        throw new AdminAccountManagementError('ACCOUNT_NOT_FOUND');
    }
    if (type === 'user' && account.role === 'agent') {
        throw new AdminAccountManagementError('ACCOUNT_NOT_FOUND');
    }
    if (type === 'agent' && account.role !== 'agent') {
        throw new AdminAccountManagementError('ACCOUNT_NOT_FOUND');
    }
    if (type === 'executor' && account.status === 'archived') {
        throw new AdminAccountManagementError('ACCOUNT_NOT_FOUND');
    }
};

const findEditableAccount = async (type, id) => {
    const definition = getAccountTypeDefinition(type);
    assertValidId(id);
    const account = await definition.Model.findById(id);
    assertAccountMatchesType(definition.type, account);
    return { definition, account };
};

const parseNumber = (value, field, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
        throw new AdminAccountManagementError(field === 'tier' ? 'INVALID_TIER' : 'INVALID_NUMBER', field);
    }
    return parsed;
};

const normalizeUsername = (value) => {
    const username = cleanText(value, 100).toLowerCase();
    if (!username) throw new AdminAccountManagementError('USERNAME_REQUIRED', 'webUsername');
    if (username.length < 3 || /\s/.test(username)) {
        throw new AdminAccountManagementError('USERNAME_INVALID', 'webUsername');
    }
    return username;
};

const normalizePhone = (value, required = false) => {
    const phone = cleanText(value, 24).replace(/[\s-]+/g, '');
    if (!phone && required) throw new AdminAccountManagementError('PHONE_REQUIRED', 'phone');
    if (phone && !/^\+?\d{6,20}$/.test(phone)) {
        throw new AdminAccountManagementError('PHONE_INVALID', 'phone');
    }
    return phone;
};

const assertIdentityAvailable = async ({ field, value, currentModelName, currentId }) => {
    if (!value) return;
    const queryValue = field === 'webUsername'
        ? new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        : value;

    const matches = await Promise.all(IDENTITY_MODELS.map(async (descriptor) => {
        if (field === 'phone' && !descriptor.hasPhone) return null;
        const query = { [field]: queryValue };
        if (descriptor.modelName === currentModelName) query._id = { $ne: currentId };
        return descriptor.Model.findOne(query).select('_id').lean();
    }));

    if (matches.some(Boolean)) {
        throw new AdminAccountManagementError(field === 'phone' ? 'PHONE_TAKEN' : 'USERNAME_TAKEN', field);
    }
};

const setName = (account, payload) => {
    const name = cleanText(payload.name, 120);
    if (name.length < 2) throw new AdminAccountManagementError('NAME_REQUIRED', 'name');
    account.name = name;
};

const setStatus = (type, account, payload) => {
    const status = cleanText(payload.status, 30).toLowerCase();
    if (!STATUS_OPTIONS[type].includes(status)) {
        throw new AdminAccountManagementError('INVALID_STATUS', 'status');
    }
    account.status = status;
};

const setBusinessProfile = (account, payload) => {
    const fields = ['contactName', 'email', 'city', 'address', 'registrationNumber'];
    for (const field of fields) {
        account.set(`businessProfile.${field}`, cleanText(payload[field], field === 'address' ? 240 : 120));
    }
};

const applyUploadedDocuments = (account, uploads = {}) => {
    const documentKinds = {
        profilePhoto: 'profile_photo',
        identityDocument: 'identity',
        taxCard: 'tax_card',
        businessLicense: 'business_license'
    };
    const existing = Array.isArray(account.verificationDocuments)
        ? account.verificationDocuments.map((document) => document.toObject ? document.toObject() : document)
        : [];
    const replacements = [];

    for (const [field, kind] of Object.entries(documentKinds)) {
        const file = Array.isArray(uploads[field]) ? uploads[field][0] : null;
        if (!file?.filename) continue;
        replacements.push({
            kind,
            fileUrl: `/uploads/${file.filename}`,
            originalName: cleanText(file.originalname, 180),
            uploadedAt: new Date()
        });
    }

    if (!replacements.length) return [];
    const replacedKinds = new Set(replacements.map((document) => document.kind));
    account.verificationDocuments = [
        ...existing.filter((document) => !replacedKinds.has(document.kind)),
        ...replacements
    ];
    const photo = replacements.find((document) => document.kind === 'profile_photo');
    if (photo && account.schema?.path('profilePhotoKey')) {
        account.profilePhotoKey = photo.fileUrl;
        account.profilePhotoUpdatedAt = new Date();
    }
    return replacements.map((document) => document.kind);
};

const setLoginIdentity = async ({ definition, account, payload, requirePhone = false }) => {
    const phone = normalizePhone(payload.phone, requirePhone);
    const webUsername = normalizeUsername(payload.webUsername);
    const phoneChanged = !sameText(account.phone, phone);
    const usernameChanged = !sameText(account.webUsername, webUsername);

    if (phoneChanged) {
        await assertIdentityAvailable({
            field: 'phone',
            value: phone,
            currentModelName: definition.modelName,
            currentId: account._id
        });
    }
    if (usernameChanged) {
        await assertIdentityAvailable({
            field: 'webUsername',
            value: webUsername,
            currentModelName: definition.modelName,
            currentId: account._id
        });
    }

    account.phone = phone || undefined;
    account.webUsername = webUsername;

    const newPassword = String(payload.newPassword || '').trim();
    let passwordChanged = false;
    if (newPassword) {
        if (newPassword.length < 6) {
            throw new AdminAccountManagementError('PASSWORD_TOO_SHORT', 'newPassword');
        }
        account.webPassword = newPassword;
        account.refreshToken = undefined;
        account.otpCode = undefined;
        account.otpExpires = undefined;
        account.lastOtpDate = undefined;
        passwordChanged = true;
    }
    if ((phoneChanged || usernameChanged || passwordChanged) && account.schema?.path('sessionVersion')) {
        account.sessionVersion = Number(account.sessionVersion || 0) + 1;
    }
    return passwordChanged;
};

const accountCodeContext = async (type, account) => {
    if (type === 'user' || type === 'agent') {
        const hasSubAccounts = await SubAccount.exists({ masterType: 'user', masterId: account._id, status: { $ne: 'deleted' } });
        return { modelName: 'User', length: expectedUserCodeLength(account, Boolean(hasSubAccounts)) };
    }
    if (type === 'company') return { modelName: 'ClientCompany', length: CODE_LENGTHS.company };
    if (type === 'subaccount') return { modelName: 'SubAccount', length: CODE_LENGTHS.subAccount };
    return null;
};

const prepareAccountCodeChange = async ({ type, account, payload }) => {
    if (!hasOwn(payload, 'accountCode')) return null;
    const context = await accountCodeContext(type, account);
    if (!context) return null;

    const oldCode = cleanText(account.accountCode, 12);
    const newCode = cleanText(payload.accountCode, 12);
    if (oldCode === newCode) return null;

    const current = { modelName: context.modelName, id: account._id };
    if (newCode) {
        try {
            validateAccountCode(newCode, context.length);
            await ensureAccountCodeAvailable(newCode, current);
            await reserveAccountCode(newCode, current);
        } catch (error) {
            if (error.message === 'ACCOUNT_CODE_DUPLICATE') {
                throw new AdminAccountManagementError('ACCOUNT_CODE_DUPLICATE', 'accountCode');
            }
            if (String(error.message || '').startsWith('ACCOUNT_CODE_INVALID_')) {
                throw new AdminAccountManagementError('ACCOUNT_CODE_INVALID', 'accountCode');
            }
            throw error;
        }
        account.accountCode = newCode;
    } else {
        account.accountCode = undefined;
    }

    if (type === 'agent') account.agentCode = newCode || undefined;

    return {
        finalize: async () => {
            if (!newCode) await releaseAccountCodeReservation(current);
        },
        rollback: async () => {
            if (oldCode) await reserveAccountCode(oldCode, current);
            else await releaseAccountCodeReservation(current);
        }
    };
};

const updateUser = async ({ type, definition, account, payload }) => {
    setName(account, payload);
    setStatus(type, account, payload);
    const passwordChanged = await setLoginIdentity({
        definition,
        account,
        payload,
        requirePhone: true
    });
    account.tier = parseNumber(payload.tier, 'tier', { min: 1, max: 3, integer: true });
    account.creditLimit = parseNumber(payload.creditLimit || 0, 'creditLimit', { min: 0, max: 1e12 });
    setBusinessProfile(account, payload);
    return { passwordChanged };
};

const updateCompany = async ({ account, payload }) => {
    setName(account, payload);
    setStatus('company', account, payload);
    const phone = normalizePhone(payload.phone, false);
    if (!sameText(account.phone, phone)) {
        await assertIdentityAvailable({
            field: 'phone',
            value: phone,
            currentModelName: 'ClientCompany',
            currentId: account._id
        });
    }
    account.phone = phone || undefined;
    account.tier = parseNumber(payload.tier, 'tier', { min: 1, max: 3, integer: true });
    account.creditLimit = parseNumber(payload.creditLimit || 0, 'creditLimit', { min: 0, max: 1e12 });
    setBusinessProfile(account, payload);
    return { passwordChanged: false };
};

const updateSubAccount = async ({ definition, account, payload }) => {
    setName(account, payload);
    setStatus('subaccount', account, payload);
    const passwordChanged = await setLoginIdentity({ definition, account, payload });
    const creditLimit = normalizeCreditLimit(payload.creditLimit || 0, { required: true });
    try {
        assertCreditLimitCanCoverBalance({ balance: account.balance, creditLimit });
    } catch (error) {
        if (error && error.code) throw new AdminAccountManagementError(error.code, 'creditLimit');
        throw error;
    }
    account.creditLimit = creditLimit;
    const marginStorage = buildMarginStorage({ customMargin: parseNumber(payload.customMargin || 0, 'customMargin', { min: 0, max: 5 }) });
    account.customMargin = marginStorage.customMargin;
    account.marginPiasters = marginStorage.marginPiasters;
    account.pricingVersion = marginStorage.pricingVersion;
    account.cardMargin = parseNumber(payload.cardMargin || 0, 'cardMargin', { min: -100, max: 100 });
    return { passwordChanged };
};

const setEmployeeRoleAndPermissions = (type, account, payload) => {
    const role = cleanText(payload.role, 30).toLowerCase();
    if (!ROLE_OPTIONS[type].includes(role)) {
        throw new AdminAccountManagementError('INVALID_ROLE', 'role');
    }
    account.role = role;
    account.canViewAllReports = isChecked(payload.canViewAllReports);

    if (type === 'client-employee') {
        account.canManageCompany = isChecked(payload.canManageCompany);
        account.canCreateCompanyStaff = isChecked(payload.canCreateCompanyStaff);
    } else if (type === 'agent-employee') {
        account.canManageAgent = isChecked(payload.canManageAgent);
        account.canCreateAgentStaff = isChecked(payload.canCreateAgentStaff);
    }
};

const setEmployeeOwner = async (type, account, payload) => {
    if (type === 'client-employee') {
        assertValidId(payload.companyId);
        const company = await ClientCompany.findOne({ _id: payload.companyId, status: { $ne: 'deleted' } }).select('_id').lean();
        if (!company) throw new AdminAccountManagementError('INVALID_COMPANY', 'companyId');
        account.companyId = company._id;
        return;
    }
    if (type === 'agent-employee') {
        assertValidId(payload.agentId);
        const agent = await User.findOne({ _id: payload.agentId, role: 'agent', status: { $ne: 'deleted' } }).select('_id').lean();
        if (!agent) throw new AdminAccountManagementError('INVALID_AGENT', 'agentId');
        account.agentId = agent._id;
        return;
    }
    assertValidId(payload.groupId);
    const executor = await ExecutorGroup.findOne({ _id: payload.groupId, status: { $ne: 'archived' } }).select('_id').lean();
    if (!executor) throw new AdminAccountManagementError('INVALID_EXECUTOR', 'groupId');
    account.groupId = executor._id;
};

const updateEmployee = async ({ type, definition, account, payload }) => {
    setName(account, payload);
    setStatus(type, account, payload);
    const passwordChanged = await setLoginIdentity({ definition, account, payload });
    setEmployeeRoleAndPermissions(type, account, payload);
    await setEmployeeOwner(type, account, payload);
    if (type === 'executor-employee') account.telegramId = cleanText(payload.telegramId, 80) || undefined;
    return { passwordChanged };
};

const updateExecutor = async ({ account, payload }) => {
    setName(account, payload);
    setStatus('executor', account, payload);

    const oldServiceKey = normalizeExecutorServiceKey(account.serviceKey);
    const serviceKey = normalizeExecutorServiceKey(payload.serviceKey, null);
    if (!serviceKey) throw new AdminAccountManagementError('INVALID_SERVICE', 'serviceKey');

    if (serviceKey !== oldServiceKey) {
        const inFlightCount = await Transaction.countDocuments({
            $or: [{ executorGroupId: account._id }, { managerGroupId: account._id }],
            status: { $in: ['processing', 'accepted'] }
        });
        if (inFlightCount > 0) throw new AdminAccountManagementError('ACTIVE_TASKS', 'serviceKey');
        account.serviceKey = serviceKey;
    }

    if (!account.isManagerBot && payload.parentGroupId) {
        assertValidId(payload.parentGroupId);
        const manager = await ExecutorGroup.findOne({
            _id: payload.parentGroupId,
            isManagerBot: true,
            status: 'active'
        }).select('_id').lean();
        if (!manager) throw new AdminAccountManagementError('INVALID_PARENT_EXECUTOR', 'parentGroupId');
        account.parentGroupId = manager._id;
        account.parentBotId = manager._id;
    } else if (!account.isManagerBot) {
        account.parentGroupId = null;
        account.parentBotId = null;
    }

    const secretChanges = [];
    if (account.isApiBot) {
        const apiUrl = cleanText(payload.apiUrl, 400);
        if (apiUrl && !/^https?:\/\//i.test(apiUrl)) {
            throw new AdminAccountManagementError('INVALID_API_URL', 'apiUrl');
        }
        account.apiUrl = apiUrl;
        account.apiUsername = cleanText(payload.apiUsername, 160);
        account.apiMachineSerial = cleanText(payload.apiMachineSerial, 80) || 'XP1';
        account.apiServiceId = parseNumber(payload.apiServiceId, 'apiServiceId', { min: 0, max: 1e9, integer: true });
        account.apiProviderId = parseNumber(payload.apiProviderId, 'apiProviderId', { min: 0, max: 1e9, integer: true });
        account.apiFieldId = parseNumber(payload.apiFieldId, 'apiFieldId', { min: 0, max: 1e9, integer: true });

        const apiPassword = String(payload.apiPassword || '').trim();
        const apiToken = String(payload.apiToken || '').trim();
        if (apiPassword) {
            account.apiPassword = apiPassword;
            secretChanges.push('apiPassword');
        }
        if (apiToken) {
            account.apiToken = apiToken;
            secretChanges.push('apiToken');
        }
    }

    return { passwordChanged: false, secretChanges, serviceChanged: serviceKey !== oldServiceKey };
};

const safeSnapshot = (type, account) => {
    const snapshot = {
        name: account.name || '',
        status: account.status || ''
    };

    if (['user', 'agent', 'subaccount', 'client-employee', 'agent-employee', 'executor-employee'].includes(type)) {
        snapshot.phone = account.phone || '';
        snapshot.webUsername = account.webUsername || '';
    }
    if (['user', 'agent', 'company'].includes(type)) {
        snapshot.phone = account.phone || '';
        snapshot.tier = Number(account.tier || 1);
        snapshot.creditLimit = Number(account.creditLimit || 0);
        snapshot.accountCode = account.accountCode || '';
        snapshot.businessProfile = account.businessProfile?.toObject
            ? account.businessProfile.toObject()
            : { ...(account.businessProfile || {}) };
    }
    if (type === 'subaccount') {
        snapshot.accountCode = account.accountCode || '';
        snapshot.creditLimit = Number(account.creditLimit || 0);
        snapshot.customMargin = Number(account.customMargin || 0);
        snapshot.cardMargin = Number(account.cardMargin || 0);
        snapshot.masterType = account.masterType;
        snapshot.masterId = String(account.masterId || '');
    }
    if (ROLE_OPTIONS[type]) {
        snapshot.role = account.role;
        snapshot.canViewAllReports = Boolean(account.canViewAllReports);
    }
    if (type === 'client-employee') {
        snapshot.companyId = String(account.companyId || '');
        snapshot.canManageCompany = Boolean(account.canManageCompany);
        snapshot.canCreateCompanyStaff = Boolean(account.canCreateCompanyStaff);
    }
    if (type === 'agent-employee') {
        snapshot.agentId = String(account.agentId || '');
        snapshot.canManageAgent = Boolean(account.canManageAgent);
        snapshot.canCreateAgentStaff = Boolean(account.canCreateAgentStaff);
    }
    if (type === 'executor-employee') {
        snapshot.groupId = String(account.groupId || '');
        snapshot.telegramId = account.telegramId || '';
    }
    if (type === 'executor') {
        snapshot.serviceKey = normalizeExecutorServiceKey(account.serviceKey);
        snapshot.parentGroupId = String(account.parentGroupId || account.parentBotId || '');
        snapshot.isApiBot = Boolean(account.isApiBot);
        if (account.isApiBot) {
            snapshot.apiUrl = account.apiUrl || '';
            snapshot.apiUsername = account.apiUsername || '';
            snapshot.apiServiceId = Number(account.apiServiceId || 0);
            snapshot.apiProviderId = Number(account.apiProviderId || 0);
            snapshot.apiFieldId = Number(account.apiFieldId || 0);
            snapshot.apiMachineSerial = account.apiMachineSerial || '';
        }
    }
    return snapshot;
};

const changedFieldsBetween = (oldData, newData) => {
    const fields = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
    return [...fields].filter((field) => JSON.stringify(oldData[field]) !== JSON.stringify(newData[field]));
};

const updateEditableAccount = async ({ type, id, payload, uploads = {} }) => {
    const { definition, account } = await findEditableAccount(type, id);
    const oldData = safeSnapshot(definition.type, account);
    let accountCodeChange = null;

    try {
        let updateMetadata;
        if (definition.type === 'user' || definition.type === 'agent') {
            updateMetadata = await updateUser({ type: definition.type, definition, account, payload });
        } else if (definition.type === 'company') {
            updateMetadata = await updateCompany({ account, payload });
        } else if (definition.type === 'subaccount') {
            updateMetadata = await updateSubAccount({ definition, account, payload });
        } else if (ROLE_OPTIONS[definition.type]) {
            updateMetadata = await updateEmployee({ type: definition.type, definition, account, payload });
        } else {
            updateMetadata = await updateExecutor({ account, payload });
        }

        accountCodeChange = await prepareAccountCodeChange({ type: definition.type, account, payload });
        const uploadedDocumentKinds = applyUploadedDocuments(account, uploads);
        await account.save();
        if (accountCodeChange) await accountCodeChange.finalize();

        if (updateMetadata.serviceChanged) {
            await Settings.updateMany({}, { $pull: { autoRouteRules: { executorGroupId: account._id } } }).catch(() => {});
            await Settings.updateMany(
                { autoRouteBotId: account._id },
                { $set: { autoRouteBotId: null } }
            ).catch(() => {});
        }

        const newData = safeSnapshot(definition.type, account);
        return {
            account,
            definition,
            oldData,
            newData,
            changedFields: changedFieldsBetween(oldData, newData),
            uploadedDocumentKinds,
            ...updateMetadata
        };
    } catch (error) {
        if (accountCodeChange) await accountCodeChange.rollback().catch(() => {});
        if (error instanceof AdminAccountManagementError) throw error;
        if (error?.code === 11000) throw new AdminAccountManagementError('IDENTITY_TAKEN');
        throw error;
    }
};

const getReturnUrl = (type, account) => {
    if (type === 'user' || type === 'agent') return `/user/${account._id}`;
    if (type === 'company') return `/company/${account._id}`;
    if (type === 'subaccount') return '/clients?section=subaccounts';
    if (type === 'executor') return `/executor/${account._id}`;
    if (type === 'executor-employee') return '/employees?section=executors';
    return '/employees?section=clients';
};

const loadEditOptions = async (type, account) => {
    const options = {
        statuses: STATUS_OPTIONS[type] || [],
        roles: ROLE_OPTIONS[type] || [],
        companies: [],
        agents: [],
        executors: [],
        managerGroups: [],
        executorServices: [],
        accountCodeLength: null,
        ownerName: ''
    };

    if (['user', 'agent', 'company', 'subaccount'].includes(type)) {
        const context = await accountCodeContext(type, account);
        options.accountCodeLength = context?.length || null;
    }
    if (type === 'client-employee') {
        options.companies = await ClientCompany.find({ status: { $ne: 'deleted' } }).select('name status').sort({ name: 1 }).lean();
    }
    if (type === 'agent-employee') {
        options.agents = await User.find({ role: 'agent', status: { $ne: 'deleted' } }).select('name status accountCode').sort({ name: 1 }).lean();
    }
    if (type === 'executor-employee') {
        options.executors = await ExecutorGroup.find({ status: { $ne: 'archived' } }).select('name status serviceKey').sort({ name: 1 }).lean();
    }
    if (type === 'executor') {
        options.executorServices = getExecutorServiceOptions();
        options.managerGroups = await ExecutorGroup.find({
            isManagerBot: true,
            status: 'active',
            _id: { $ne: account._id }
        }).select('name').sort({ name: 1 }).lean();
    }
    if (type === 'subaccount') {
        const MasterModel = account.masterType === 'company' ? ClientCompany : User;
        const master = await MasterModel.findById(account.masterId).select('name').lean();
        options.ownerName = master?.name || 'غير معروف';
    }

    return options;
};

const getErrorMessage = (error) => {
    const code = error?.code || error?.message;
    if (String(code || '').startsWith('ACCOUNT_CODE_INVALID_')) return ERROR_MESSAGES.ACCOUNT_CODE_INVALID;
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.UPDATE_FAILED;
};

module.exports = {
    ACCOUNT_TYPES,
    STATUS_OPTIONS,
    ROLE_OPTIONS,
    AdminAccountManagementError,
    normalizeAccountType,
    getAccountTypeDefinition,
    findEditableAccount,
    updateEditableAccount,
    loadEditOptions,
    getReturnUrl,
    getErrorMessage,
    safeSnapshot,
    normalizeUsername,
    normalizePhone
};
