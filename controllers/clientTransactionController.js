const mongoose = require('mongoose');
const fs = require('fs');

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const Counter = require('../models/Counter'); 
const Ledger = require('../models/Ledger'); 
const AgencyJournal = require('../models/AgencyJournal');
const Admin = require('../models/Admin');
const { executeBalanceTransfer } = require('../services/balanceTransferService');
const {
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
} = require('../services/autoRouteService');
const { normalizeAccountCode, resolveAccountByCode } = require('../services/accountCodeService');
const { logAction } = require('../services/auditService');
const {
    getServiceRateForTier,
    getCompanyServiceRates,
    resolveTransferServiceKey
} = require('../utils/rateHelper');
const { getTransferServiceDefinition } = require('../utils/mobileTransferServiceCatalog');
const { validateTransferInput } = require('../utils/transferServiceRules');
const { getClientReceiptProofIds } = require('../services/clientReceiptService');
const { normalizeCustomerNoteInput } = require('../utils/transactionNotes');
const { normalizeWhatsAppPhone } = require('../services/whatsappService');
const { activatePendingRateUpdate } = require('../services/rateChangeService');
const { calculateAgencyPricing } = require('../utils/agencyPricing');
const { calculateTransferCostLYD, getTransferPricingDefinition } = require('../utils/transferPricing');
const { recordTransferReservation } = require('../services/agencyJournalService');
const { minimumBalanceForDebit } = require('../services/agencyCreditLimitService');
const { resolveCompanyPermissions, canPostPortalTransfer, redirectForbiddenPage } = require('../services/businessPortalService');
const {
    TransferCooldownError,
    acquireTransferCooldown,
    releaseTransferCooldown
} = require('../services/transferCooldownService');
const {
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
} = require('../services/walletService');

const clientOwnershipFilter = async (req) => {
    const accountId = req.session.clientId;
    if (req.session.accountType === 'sub_client') return { subAccountId: accountId };

    if (req.session.accountType === 'company') {
        const employee = await ClientEmployee.findById(accountId).select('companyId status').lean();
        if (!employee || employee.status !== 'active' || !employee.companyId) return null;
        return { companyId: employee.companyId };
    }

    if (req.session.accountType === 'agent_staff') {
        const employee = await AgentEmployee.findById(accountId).select('agentId status').lean();
        if (!employee || employee.status !== 'active' || !employee.agentId) return null;
        const agent = await User.findById(employee.agentId).select('phone webUsername status role').lean();
        if (!agent || agent.status !== 'active' || agent.role !== 'agent') return null;
        const subAccountIds = await SubAccount.find({ masterType: 'user', masterId: agent._id, status: { $ne: 'deleted' } }).distinct('_id');
        return {
            $or: [
                { userId: agent.phone, companyId: null, subAccountId: null },
                { userId: agent.webUsername, companyId: null, subAccountId: null },
                { subAccountId: { $in: subAccountIds } }
            ].filter((condition) => condition.userId || condition.subAccountId)
        };
    }

    const user = await User.findById(accountId).select('phone webUsername status role').lean();
    if (!user || user.status !== 'active') return null;
    const conditions = [
        { userId: user.phone, companyId: null, subAccountId: null },
        { userId: user.webUsername, companyId: null, subAccountId: null }
    ].filter((condition) => condition.userId);
    if (user.role === 'agent') {
        const subAccountIds = await SubAccount.find({ masterType: 'user', masterId: user._id, status: { $ne: 'deleted' } }).distinct('_id');
        conditions.push({ subAccountId: { $in: subAccountIds } });
    }
    return conditions.length ? { $or: conditions } : null;
};

const createClientError = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const getBalanceTransferSource = async (req) => {
    const isSubAccount = req.session.accountType === 'sub_client';
    const isAgentStaff = req.session.accountType === 'agent_staff';
    const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : (isAgentStaff ? AgentEmployee : User));
    const account = await Model.findById(req.session.clientId);
    if (!account) throw createClientError('SESSION_EXPIRED', 401);
    if (account.status && account.status !== 'active') throw createClientError('SOURCE_INACTIVE', 403);

    if (isSubAccount) {
        return { modelName: 'SubAccount', doc: account };
    }

    if (req.session.accountType === 'company') {
        const company = await ClientCompany.findById(account.companyId);
        if (!company) throw createClientError('COMPANY_NOT_FOUND', 404);
        const permissions = resolveCompanyPermissions(account);
        if (!permissions.canInternalTransfer) throw createClientError('ACCOUNTANT_FORBIDDEN', 403);
        return { modelName: 'ClientCompany', doc: company, performedBy: account.name };
    }

    if (isAgentStaff) {
        if (account.role === 'accountant') throw createClientError('ACCOUNTANT_FORBIDDEN', 403);
        const agent = await User.findById(account.agentId);
        if (!agent || agent.role !== 'agent') throw createClientError('AGENT_NOT_FOUND', 404);
        return { modelName: 'User', doc: agent, performedBy: account.name };
    }

    if (account.role === 'accountant') {
        throw createClientError('ACCOUNTANT_FORBIDDEN', 403);
    }

    return { modelName: 'User', doc: account };
};

const accountDisplayName = (account) => account.doc.name || account.doc.webUsername || account.doc.phone || 'حساب بدون اسم';
const isSameBalanceAccount = (source, target) => source.modelName === target.modelName && String(source.doc._id) === String(target.doc._id);

const balanceTransferMessages = {
    SESSION_EXPIRED: 'انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.',
    COMPANY_NOT_FOUND: 'حساب الشركة غير موجود.',
    ACCOUNTANT_FORBIDDEN: 'ليس لديك صلاحية تحويل الرصيد.',
    INVALID_ACCOUNT_CODE: 'ID المستلم يجب أن يكون من 4 إلى 6 أرقام.',
    INVALID_AMOUNT: 'المبلغ غير صحيح.',
    TARGET_NOT_FOUND: 'لم يتم العثور على حساب بهذا ID.',
    ACCOUNT_CODE_AMBIGUOUS: 'هذا ID مكرر لأكثر من حساب. يرجى التواصل مع الإدارة قبل التحويل.',
    TARGET_INACTIVE: 'الحساب المستلم غير نشط.',
    SOURCE_INACTIVE: 'حسابك غير نشط.',
    SAME_ACCOUNT: 'لا يمكن تحويل الرصيد إلى نفس الحساب.',
    INSUFFICIENT_BALANCE: 'الرصيد غير كافٍ لإتمام التحويل.'
};

const balanceTransferStatus = {
    SESSION_EXPIRED: 401,
    COMPANY_NOT_FOUND: 404,
    ACCOUNTANT_FORBIDDEN: 403,
    INVALID_ACCOUNT_CODE: 400,
    TARGET_NOT_FOUND: 404,
    ACCOUNT_CODE_AMBIGUOUS: 409,
    TARGET_INACTIVE: 400,
    SOURCE_INACTIVE: 403,
    SAME_ACCOUNT: 400,
    INSUFFICIENT_BALANCE: 400,
    INVALID_AMOUNT: 400
};

exports.postTransfer = async (req, res) => {
    const isAjax = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
    let auditAccount = null;
    let auditIsSubAccount = false;
    let standaloneCompensations = [];
    let cooldownLock = null;
    let cooldownGuardFields = null;
    
    let session = null;
    let useTransaction = false;

    try {
        try {
            const hello = await mongoose.connection.db.admin().command({ hello: 1 });
            const transactionCapable = Boolean(hello?.setName || hello?.msg === 'isdbgrid');
            if (!transactionCapable) {
                throw new Error('MongoDB transactions require a replica set or mongos');
            }
            session = await mongoose.startSession();
            session.startTransaction();
            useTransaction = true;
        } catch (error) {
            if (requiresMongoTransactions()) {
                throw financialTransactionsUnavailableError(error);
            }
            session = null;
            useTransaction = false;
        }

        await activatePendingRateUpdate({ app: req.app });
        // helper: ربط session بالاستعلام فقط إذا كان متاحاً
        const sessionOpts = useTransaction ? { session } : {};
        const withSess = (query) => useTransaction ? query.session(session) : query;

        const isSubAccount = req.session.accountType === 'sub_client';
        const isAgentStaff = req.session.accountType === 'agent_staff';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : (isAgentStaff ? AgentEmployee : User));
        const account = await withSess(Model.findById(req.session.clientId));
        auditAccount = account;
        auditIsSubAccount = isSubAccount;
        if (!account) throw new Error('SESSION_EXPIRED');
        
        if (!canPostPortalTransfer(req.session.accountType, account)) {
            if (useTransaction) { await session.abortTransaction(); session.endSession(); }
            if (isAjax) return res.status(403).json({ error: '❌ ليس لديك صلاحية.' });
            if (req.session.accountType === 'company') return redirectForbiddenPage(req, res);
            return res.redirect('/client/dashboard?error=unauthorized');
        }

        const amount = parseFloat(req.body.amount);
        const serviceKey = resolveTransferServiceKey(req.body.type || 'كاش');
        const transferType = req.body.type || 'كاش';
        const serviceDefinition = getTransferServiceDefinition(serviceKey);
        const pricingDefinition = getTransferPricingDefinition(serviceKey);
        const dataEntryAcknowledged = req.body.dataEntryAcknowledged === true
            || ['true', '1', 'on', 'yes'].includes(String(req.body.dataEntryAcknowledged || '').trim().toLowerCase());
        const submittedDestination = String(req.body.phone || '').trim();
        const nationalId = String(req.body.nationalId || (serviceKey === 'post_card' ? req.body.number : '') || '').trim().slice(0, 20);
        const governorate = String(req.body.governorate || (serviceKey === 'post_card' ? submittedDestination : '') || '').trim().slice(0, 100);
        const phone = serviceKey === 'post_card' ? governorate : submittedDestination;
        const notes = normalizeCustomerNoteInput(req.body);
        const accountName = String(req.body.name || '').trim().slice(0, 160);
        const accountNumber = String(serviceKey === 'post_card' ? nationalId : (req.body.number || phone)).trim().slice(0, 100);
        let clientPhone = String(req.body.clientPhone || '').trim().slice(0, 30);
        if (clientPhone) {
            try {
                // Store one canonical WhatsApp number: 09... is Libyan and 01... is Egyptian.
                clientPhone = normalizeWhatsAppPhone(clientPhone);
            } catch (_error) {
                throw createClientError('رقم واتساب العميل غير صالح. أدخل رقماً ليبياً أو مصرياً صحيحاً أو رقماً بمفتاح الدولة.', 400);
            }
        }
        const serviceDetails = {
            subtype: String(req.body.serviceSubtype || '').trim().slice(0, 40),
            city: String(req.body.city || '').trim().slice(0, 100),
            nationalId,
            governorate,
            clientPhone,
            destinationLabel: serviceDefinition ? serviceDefinition.numberLabel : '',
            amountCurrency: pricingDefinition.amountCurrencyCode,
            rateDirection: pricingDefinition.rateDirection,
            dataEntryAcknowledged: serviceKey === 'sefa_niger' ? dataEntryAcknowledged : false,
            dataEntryAcknowledgedAt: serviceKey === 'sefa_niger' && dataEntryAcknowledged ? new Date() : undefined
        };

        const validationError = validateTransferInput({
            serviceKey,
            amount,
            destination: phone,
            beneficiaryName: accountName,
            subtype: serviceDetails.subtype,
            city: serviceDetails.city,
            nationalId,
            governorate,
            hasIdentityImage: Boolean(req.file),
            enforceDataEntryAcknowledgement: true,
            dataEntryAcknowledged
        });
        if (validationError) throw createClientError(validationError, 400);

        let settings = await withSess(Settings.findOne({}));
        if (!settings) settings = await Settings.create({}, sessionOpts);
        if (settings && settings.isManualClosed) throw new Error('SYSTEM_CLOSED');
        const autoRouteExecutor = await resolveAutoRouteExecutor(
            settings,
            serviceKey,
            useTransaction ? session : null,
            amount
        );

        let masterRate, actualSubRate, subCostLYD, masterCostLYD, commission = 0;
        let agencyPricing;
        let balanceModel, companyId = null, companyName = 'عميل فردي (ويب)';
        let masterObj, telegramId = null;
        let finalCustomId = '';

        // 🟢 إعداد الـ ID الخاص بالفاتورة مبكراً لتوثيقه في الدفتر
        const counter = await Counter.findOneAndUpdate(
            { name: 'transaction' },
            { $inc: { value: 1 } },
            { upsert: true, new: true, ...sessionOpts }
        );
        const yy = new Date().getFullYear().toString().slice(-2);
        const mm = (new Date().getMonth() + 1).toString().padStart(2, '0');
        finalCustomId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`;

        if (isSubAccount) {
            masterObj = account.masterType === 'user' ? await withSess(User.findById(account.masterId)) : await withSess(ClientCompany.findById(account.masterId));
            let clientTier = masterObj.tier || 1;
            const masterRates = account.masterType === 'company'
                ? getCompanyServiceRates(masterObj, settings)
                : null;
            const effectiveMasterRates = masterRates || Object.fromEntries([
                [serviceKey, getServiceRateForTier(serviceKey, clientTier, settings)]
            ]);
            agencyPricing = calculateAgencyPricing({
                amountEGP: amount,
                masterRates: effectiveMasterRates,
                serviceKey,
                subAccount: account
            });
            masterRate = agencyPricing.agentRate;
            actualSubRate = agencyPricing.customerRate;
            subCostLYD = agencyPricing.customerChargeLYD;
            masterCostLYD = agencyPricing.agentCostLYD;
            commission = agencyPricing.profitLYD;

            if (account.masterType === 'company') { companyId = masterObj._id; companyName = masterObj.name; telegramId = null; }
            else { companyName = masterObj.name; telegramId = masterObj.telegramId; }

            const minSubBalance = minimumBalanceForDebit(subCostLYD, account.creditLimit);
            const minMasterBalance = minimumBalanceForDebit(masterCostLYD, masterObj.creditLimit);
            const cooldown = await acquireTransferCooldown({
                ownerModel: 'SubAccount',
                ownerId: account._id,
                serviceKey,
                recipient: accountNumber,
                amount
            });
            cooldownLock = cooldown.lock;
            cooldownGuardFields = cooldown.guardFields;

            // 🟢 الخصم الذري لنقطة البيع + القيد المالي
            const updatedSub = await SubAccount.findOneAndUpdate(
                { _id: account._id, balance: { $gte: minSubBalance } },
                { $inc: { balance: -subCostLYD } },
                { new: true, ...sessionOpts }
            );
            if (!updatedSub) throw new Error('SUB_INSUFFICIENT_BALANCE');
            if (!useTransaction) {
                standaloneCompensations.push(async () => {
                    await Ledger.deleteMany({ transactionId: finalCustomId, entityId: account._id });
                    await SubAccount.updateOne({ _id: account._id }, { $inc: { balance: subCostLYD } });
                });
            }
            
            await new Ledger({
                entityId: account._id, entityModel: 'SubAccount', transactionId: finalCustomId,
                type: 'TRANSFER', amount: -subCostLYD, balanceBefore: updatedSub.balance + subCostLYD,
                balanceAfter: updatedSub.balance, description: `تحويل ${amount} ${pricingDefinition.amountCurrencyLabel} إلى ${phone}`
            }).save(sessionOpts);

            // 🟢 الخصم الذري للرئيسي + القيد المالي
            const MasterModel = account.masterType === 'user' ? User : ClientCompany;
            const updatedMaster = await MasterModel.findOneAndUpdate(
                { _id: masterObj._id, balance: { $gte: minMasterBalance } },
                { $inc: { balance: -masterCostLYD } },
                { new: true, ...sessionOpts }
            );

            if (!updatedMaster) throw new Error('MASTER_INSUFFICIENT_BALANCE');
            if (!useTransaction) {
                standaloneCompensations.push(async () => {
                    await Ledger.deleteMany({ transactionId: finalCustomId, entityId: masterObj._id });
                    await MasterModel.updateOne({ _id: masterObj._id }, { $inc: { balance: masterCostLYD } });
                });
            }
            
            await new Ledger({
                entityId: masterObj._id, entityModel: MasterModel.modelName, transactionId: finalCustomId,
                type: 'TRANSFER', amount: -masterCostLYD, balanceBefore: updatedMaster.balance + masterCostLYD,
                balanceAfter: updatedMaster.balance, description: `تحويل من نقطة بيع (${account.name}): ${amount} ${pricingDefinition.amountCurrencyLabel} إلى ${phone}`
            }).save(sessionOpts);

            balanceModel = updatedSub;
            masterObj = updatedMaster;

        } else {
            if (req.session.accountType === 'company') {
                const company = await withSess(ClientCompany.findById(account.companyId));
                masterRate = getCompanyServiceRates(company, settings)[serviceKey];
                masterCostLYD = calculateTransferCostLYD({ serviceKey, amount, exchangeRate: masterRate });
                balanceModel = company; companyId = company._id; companyName = company.name; telegramId = account.phone || account.webUsername;
            } else if (isAgentStaff) {
                const agent = await withSess(User.findById(account.agentId));
                if (!agent || agent.status !== 'active' || agent.role !== 'agent') throw new Error('AGENT_NOT_FOUND');
                masterRate = getServiceRateForTier(serviceKey, agent.tier || 1, settings);
                masterCostLYD = calculateTransferCostLYD({ serviceKey, amount, exchangeRate: masterRate });
                balanceModel = agent;
                companyName = agent.name;
                telegramId = agent.phone || agent.webUsername;
            } else {
                masterRate = getServiceRateForTier(serviceKey, account.tier || 1, settings);
                masterCostLYD = calculateTransferCostLYD({ serviceKey, amount, exchangeRate: masterRate });
                balanceModel = account; telegramId = account.phone || account.webUsername;
            }

            const minBalance = minimumBalanceForDebit(masterCostLYD, balanceModel.creditLimit);
            const BModel = req.session.accountType === 'company' ? ClientCompany : User;
            const cooldown = await acquireTransferCooldown({
                ownerModel: BModel.modelName || (req.session.accountType === 'company' ? 'ClientCompany' : 'User'),
                ownerId: balanceModel._id,
                serviceKey,
                recipient: accountNumber,
                amount
            });
            cooldownLock = cooldown.lock;
            cooldownGuardFields = cooldown.guardFields;
            
            // 🟢 الخصم الذري للرئيسي + القيد المالي
            const updatedClient = await BModel.findOneAndUpdate(
                { _id: balanceModel._id, balance: { $gte: minBalance } },
                { $inc: { balance: -masterCostLYD } },
                { new: true, ...sessionOpts }
            );

            if (!updatedClient) throw new Error('INSUFFICIENT_BALANCE');
            balanceModel = updatedClient;
            if (!useTransaction) {
                standaloneCompensations.push(async () => {
                    await Ledger.deleteMany({ transactionId: finalCustomId, entityId: balanceModel._id });
                    await BModel.updateOne({ _id: balanceModel._id }, { $inc: { balance: masterCostLYD } });
                });
            }

            await new Ledger({
                entityId: balanceModel._id, entityModel: BModel.modelName, transactionId: finalCustomId,
                type: 'TRANSFER', amount: -masterCostLYD, balanceBefore: balanceModel.balance + masterCostLYD,
                balanceAfter: balanceModel.balance, description: `تحويل ${amount} ${pricingDefinition.amountCurrencyLabel} إلى ${phone}`
            }).save(sessionOpts);
        }

        // 🟢 تسجيل المعاملة النهائية
        const newTx = new Transaction({
            customId: finalCustomId, userId: telegramId, companyId: companyId, subAccountId: isSubAccount ? account._id : null,
            subAccountName: isSubAccount ? account.name : '', companyName: isSubAccount ? masterObj.name : companyName, 
            employeeName: isSubAccount ? account.name : account.name,
            clientActorId: String(account._id),
            clientActorModel: isSubAccount ? 'SubAccount' : (req.session.accountType === 'company' ? 'ClientEmployee' : (isAgentStaff ? 'AgentEmployee' : 'User')),
            vodafoneNumber: phone, transferType: serviceKey,
            accountName, accountNumber, serviceDetails, amount: amount, costLYD: masterCostLYD,
            ...(cooldownGuardFields || {}),
            subAccountCostLYD: isSubAccount ? subCostLYD : 0, commission: commission, exchangeRate: masterRate, subClientRate: isSubAccount ? actualSubRate : 0,
            agencyPricing: isSubAccount ? agencyPricing : undefined,
            notes, customerNotes: notes, status: 'pending', isSubAccountTx: isSubAccount, masterProfit: isSubAccount ? commission : 0,
            idCardImage: req.file ? `/uploads/${req.file.filename}` : undefined
        });
        if (autoRouteExecutor) applyAutoRouteFields(newTx, autoRouteExecutor);
        if (isSubAccount) {
            await recordTransferReservation({
                transaction: newTx,
                subAccount: account,
                ownerId: masterObj._id,
                actor: { _id: account._id, model: 'SubAccount', name: account.name }
            }, useTransaction ? session : null);
            if (!useTransaction) {
                standaloneCompensations.push(() => AgencyJournal.deleteMany({ transactionId: finalCustomId }));
            }
        }
        await newTx.save(sessionOpts);
        if (!useTransaction) {
            standaloneCompensations.push(() => Transaction.deleteOne({ _id: newTx._id }));
        }

        // Log successful transfer to audit log
        await logAction({
            action: 'TRANSFER_CREATED',
            req,
            performedById: account._id,
            performedByModel: isSubAccount ? 'SubAccount' : (req.session.accountType === 'company' ? 'ClientEmployee' : (isAgentStaff ? 'AgentEmployee' : 'User')),
            performedByName: account.name,
            targetId: newTx._id,
            targetModel: 'Transaction',
            newData: { customId: finalCustomId, amount, transferType, costLYD: masterCostLYD, exchangeRate: masterRate },
            metadata: { customId: finalCustomId, transferType }
        });

        // ✅ تأكيد العملية بنجاح (Commit)
        if (useTransaction) { await session.commitTransaction(); session.endSession(); }
        standaloneCompensations = [];

        if (autoRouteExecutor) {
            setImmediate(() => {
                enqueueAutoRouteIfNeeded(newTx, autoRouteExecutor).catch((err) => {
                    console.error('[Transfer] Auto-route enqueue failed:', err.message);
                });
            });
        }

        if (isAjax) res.json({ success: true, message: 'تم الإرسال بنجاح.', newBalance: balanceModel.balance.toFixed(2), customId: finalCustomId });

        // 🔔 إرسال الإشعارات
        setImmediate(async () => {
            try {
                const masterNameText = isSubAccount ? masterObj.name : companyName;
                const requesterText = isSubAccount
                    ? `${account.name} (نقطة بيع)`
                    : (isAgentStaff ? `${account.name} (موظف وكيل)` : 'حساب الوكيل المباشر');
                const profitNote = commission > 0 ? `\n🎁 ربح الوكيل من العملية: ${commission.toFixed(3)} LYD` : '';
                
                const adminMsg = `🔔 طلب جديد من الويب!\n\n🏢 الوكيل الرئيسي: ${masterNameText}\n🏪 الجهة الطالبة: ${requesterText}\n📞 المحفظة: ${phone}\n💵 المبلغ: ${amount} EGP\n💰 التكلفة: ${masterCostLYD.toFixed(3)} LYD${profitNote}\n📝 التفاصيل: ${notes || 'لا يوجد'}\n🔢 رقم: ${finalCustomId}`;
                
                const Notification = require('../models/Notification');
                const admins = await Admin.find({});
                for (const admin of admins) {
                    try {
                        await Notification.create({
                            userId: admin.webUsername || 'admin',
                            title: 'طلب تحويل جديد',
                            message: adminMsg,
                            type: 'transfer'
                        });
                    } catch(e) {}
                }
            } catch(e) {}
        });

    } catch (error) {
        if (requiresMongoTransactions() && isMongoTransactionFallbackError(error)) {
            error = financialTransactionsUnavailableError(error);
        }
        // 🔴 في حال أي خطأ يتم التراجع عن خصم الأرصدة وإلغاء الفواتير والدفتر
        if (!(error instanceof TransferCooldownError)) {
            console.error('[Transfer] خطأ:', error.message, error.stack);
        }
        if (useTransaction) { try { await session.abortTransaction(); session.endSession(); } catch(e) {} }
        if (!useTransaction && standaloneCompensations.length) {
            for (const compensate of standaloneCompensations.reverse()) {
                try { await compensate(); } catch (compensationError) {
                    console.error('[Transfer] فشل التعويض:', compensationError.message);
                }
            }
            standaloneCompensations = [];
        }
        if (req.file?.path) {
            fs.promises.unlink(req.file.path).catch(() => {});
        }

        // Log failed transfer to audit log
        try {
            await logAction({
                action: 'TRANSFER_CREATED',
                req,
                performedById: auditAccount ? auditAccount._id : null,
                performedByModel: auditAccount ? (auditIsSubAccount ? 'SubAccount' : (req.session.accountType === 'company' ? 'ClientEmployee' : (req.session.accountType === 'agent_staff' ? 'AgentEmployee' : 'User'))) : 'System',
                performedByName: auditAccount ? auditAccount.name : 'System',
                success: false,
                errorCode: error.message,
                metadata: { amount: req.body.amount, transferType: req.body.type || 'كاش' }
            });
        } catch (_) {}

        if (error instanceof TransferCooldownError) {
            return res.status(error.statusCode).json({
                success: false,
                code: error.code,
                error: error.message,
                message: error.message,
                cooldownType: error.cooldownType,
                retryAfterSeconds: error.retryAfterSeconds,
                retryAt: error.retryAt
            });
        }
        if (error.message === 'SYSTEM_CLOSED') return isAjax ? res.status(403).json({ error: '⛔ النظام مغلق.' }) : null;
        if (error.message === 'SESSION_EXPIRED') return isAjax ? res.status(401).json({ error: 'انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.' }) : res.redirect('/client/logout');
        if (error.message === 'AGENT_NOT_FOUND') return isAjax ? res.status(404).json({ error: 'حساب الوكيل غير موجود أو غير نشط.' }) : null;
        if (error.message === 'INVALID_DATA') return isAjax ? res.status(400).json({ error: '❌ بيانات التحويل غير صحيحة.' }) : null;
        if (error.message.includes('INSUFFICIENT_BALANCE')) return isAjax ? res.status(400).json({ error: '❌ الرصيد غير كافٍ أو تغير أثناء العملية.' }) : null;
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') {
            return res.status(503).json({
                success: false,
                code: error.code,
                error: 'الخدمة المالية غير متاحة مؤقتًا. لم يتم خصم أي مبلغ.'
            });
        }
        if (error.statusCode) return isAjax ? res.status(error.statusCode).json({ error: error.message }) : null;

        return isAjax ? res.status(500).json({ error: '❌ خطأ داخلي.' }) : null;
    } finally {
        await releaseTransferCooldown(cooldownLock);
    }
};

exports.lookupBalanceTransferTarget = async (req, res) => {
    try {
        const source = await getBalanceTransferSource(req);
        const targetCode = normalizeAccountCode(req.body.targetAccountCode || req.body.accountCode);

        if (!/^\d{4,6}$/.test(targetCode)) {
            throw createClientError('INVALID_ACCOUNT_CODE', 400);
        }

        const target = await resolveAccountByCode(targetCode);
        if (!target) throw createClientError('TARGET_NOT_FOUND', 404);
        if (source.doc.status !== 'active') throw createClientError('SOURCE_INACTIVE', 403);
        if (target.doc.status !== 'active') throw createClientError('TARGET_INACTIVE', 400);
        if (isSameBalanceAccount(source, target)) throw createClientError('SAME_ACCOUNT', 400);

        return res.json({
            success: true,
            target: {
                accountCode: target.doc.accountCode,
                name: accountDisplayName(target),
                type: target.label || 'حساب'
            }
        });
    } catch (error) {
        const statusCode = error.statusCode || balanceTransferStatus[error.message] || 400;
        return res.status(statusCode).json({
            success: false,
            error: balanceTransferMessages[error.message] || 'تعذر التحقق من حساب المستلم.'
        });
    }
};

exports.postBalanceTransfer = async (req, res) => {
    try {
        const source = await getBalanceTransferSource(req);
        const targetCode = normalizeAccountCode(req.body.targetAccountCode || req.body.accountCode);
        if (!/^\d{4,6}$/.test(targetCode)) {
            throw createClientError('INVALID_ACCOUNT_CODE', 400);
        }

        const result = await executeBalanceTransfer({
            source,
            targetCode,
            amount: req.body.amount,
            notes: normalizeCustomerNoteInput(req.body)
        });

        // Log successful balance transfer to audit log
        await logAction({
            action: 'TRANSFER_CREATED',
            req,
            performedById: source.doc._id,
            performedByModel: source.modelName,
            performedByName: source.doc.name,
            newData: { customId: result.transferId, amount: result.amount, transferType: 'balance_transfer' },
            metadata: { targetName: result.targetName }
        });

        return res.json({
            success: true,
            message: `تم تحويل ${result.amount.toFixed(2)} LYD إلى ${result.targetName} بنجاح.`,
            transferId: result.transferId,
            newBalance: result.sourceBalance.toFixed(2)
        });
    } catch (error) {
        // Log failed balance transfer to audit log
        try {
            const source = await getBalanceTransferSource(req);
            await logAction({
                action: 'TRANSFER_CREATED',
                req,
                performedById: source ? source.doc._id : null,
                performedByModel: source ? source.modelName : 'User',
                performedByName: source ? source.doc.name : 'System',
                success: false,
                errorCode: error.message,
                metadata: { amount: req.body.amount, transferType: 'balance_transfer' }
            });
        } catch (_) {}

        const statusCode = error.statusCode || balanceTransferStatus[error.message] || 400;
        return res.status(statusCode).json({
            success: false,
            error: balanceTransferMessages[error.message] || 'تعذر تنفيذ تحويل الرصيد.'
        });
    }
};

exports.postBuyCard = async (req, res) => {
    res.json({ success: true, message: 'ميزة الشراء قيد العمل', newBalance: 0 });
};

exports.postComplaint = async (req, res) => {
    try {
        const { transactionId, complaintText } = req.body;
        const cleanComplaint = String(complaintText || '').trim().slice(0, 1000);
        if (!mongoose.isValidObjectId(transactionId) || cleanComplaint.length < 3) {
            return res.status(400).json({ success: false, error: 'يرجى كتابة شكوى صحيحة عن عملية من حسابك.' });
        }
        const ownership = await clientOwnershipFilter(req);
        if (!ownership) return res.status(403).json({ success: false, error: 'غير مصرح.' });
        const tx = await Transaction.findOne({ $and: [{ _id: transactionId }, ownership] });
        if (!tx) return res.status(404).json({ success: false, error: 'العملية غير موجودة ضمن حسابك.' });
        
        tx.complaintText = cleanComplaint;
        tx.emergencyAlert = `شكوى عميل: ${cleanComplaint}`;
        await tx.save();
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'حدث خطأ.' });
    }
};

exports.getProxyImage = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const isSubAccount = req.session.accountType === 'sub_client';
        const accountId = req.session.clientId;
        let hasAccess = false;
        
        if (isSubAccount && tx.subAccountId && tx.subAccountId.toString() === accountId.toString()) hasAccess = true;
        else if (req.session.accountType === 'company') {
            const emp = await ClientEmployee.findById(accountId);
            if (emp && tx.companyId && tx.companyId.toString() === emp.companyId.toString()) hasAccess = true;
            if (!hasAccess && emp && tx.subAccountId) {
                hasAccess = Boolean(await SubAccount.exists({
                    _id: tx.subAccountId,
                    masterType: 'company',
                    masterId: emp.companyId,
                    status: { $ne: 'deleted' }
                }));
            }
        } else if (req.session.accountType === 'agent_staff') {
            const emp = await AgentEmployee.findById(accountId);
            if (emp) {
                const agent = await User.findById(emp.agentId);
                const agentUserIds = agent ? [agent.phone, agent.webUsername].filter(Boolean).map(String) : [];
                if (agent && agentUserIds.includes(String(tx.userId || ''))) hasAccess = true;
                if (!hasAccess && tx.subAccountId) {
                    hasAccess = Boolean(await SubAccount.exists({
                        _id: tx.subAccountId,
                        masterType: 'user',
                        masterId: emp.agentId,
                        status: { $ne: 'deleted' }
                    }));
                }
            }
        } else if (req.session.accountType === 'user') {
            const user = await User.findById(accountId);
            const userIds = user ? [user.phone, user.webUsername].filter(Boolean).map(String) : [];
            if (user && userIds.includes(String(tx.userId || ''))) hasAccess = true;
            if (!hasAccess && user?.role === 'agent' && tx.subAccountId) {
                hasAccess = Boolean(await SubAccount.exists({
                    _id: tx.subAccountId,
                    masterType: 'user',
                    masterId: user._id,
                    status: { $ne: 'deleted' }
                }));
            }
        }

        if (!hasAccess) return res.status(403).send('غير مصرح لك بعرض هذه الصورة أو الإيصال');

        const index = req.params.index === undefined ? 0 : Number.parseInt(req.params.index, 10);
        if (!Number.isInteger(index) || index < 0) return res.status(400).send('رقم صورة الإيصال غير صالح');
        const photoId = getClientReceiptProofIds(tx)[index];

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) {
        console.error(error);
        res.status(500).send('خطأ داخلي في الخادم');
    }
};
