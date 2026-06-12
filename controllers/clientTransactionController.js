const mongoose = require('mongoose');

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const SubAccount = require('../models/SubAccount');
const Counter = require('../models/Counter'); 
const Ledger = require('../models/Ledger'); 
const Admin = require('../models/Admin');
const { executeBalanceTransfer } = require('../services/balanceTransferService');
const { normalizeAccountCode, resolveAccountByCode } = require('../services/accountCodeService');
const { logAction } = require('../services/auditService');

const createClientError = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const getBalanceTransferSource = async (req) => {
    const isSubAccount = req.session.accountType === 'sub_client';
    const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
    const account = await Model.findById(req.session.clientId);
    if (!account) throw createClientError('SESSION_EXPIRED', 401);
    if (account.status && account.status !== 'active') throw createClientError('SOURCE_INACTIVE', 403);

    if (isSubAccount) {
        return { modelName: 'SubAccount', doc: account };
    }

    if (req.session.accountType === 'company') {
        const company = await ClientCompany.findById(account.companyId);
        if (!company) throw createClientError('COMPANY_NOT_FOUND', 404);
        return { modelName: 'ClientCompany', doc: company, performedBy: account.name };
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
    
    // 🟢 بدء المعاملة الذرية (Transaction) — تدعم الوضع بدون Replica Set
    let session = null;
    let useTransaction = false;
    try {
        const adminDb = mongoose.connection.db.admin();
        const info = await adminDb.command({ replSetGetStatus: 1 }).catch(() => null);
        if (info) {
            session = await mongoose.startSession();
            session.startTransaction();
            useTransaction = true;
        }
    } catch (e) {
        // MongoDB standalone — لا يدعم transactions
        session = null;
        useTransaction = false;
    }

    try {
        // helper: ربط session بالاستعلام فقط إذا كان متاحاً
        const sessionOpts = useTransaction ? { session } : {};
        const withSess = (query) => useTransaction ? query.session(session) : query;

        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await withSess(Model.findById(req.session.clientId));
        auditAccount = account;
        auditIsSubAccount = isSubAccount;
        
        if (account.role === 'accountant') {
            if (useTransaction) { await session.abortTransaction(); session.endSession(); }
            return isAjax ? res.status(403).json({ error: '❌ ليس لديك صلاحية.' }) : res.redirect('/client/dashboard?error=unauthorized');
        }

        const amount = parseFloat(req.body.amount); 
        const phone = req.body.phone; 
        const notes = req.body.notes ? req.body.notes.trim() : ''; 
        const transferType = req.body.type || 'كاش'; 

        if (isNaN(amount) || amount <= 0 || !phone) throw new Error('INVALID_DATA');

        let settings = await withSess(Settings.findOne({}));
        if (!settings) settings = await Settings.create({}, sessionOpts);
        if (settings && settings.isManualClosed) throw new Error('SYSTEM_CLOSED');

        let masterRate, actualSubRate, subCostLYD, masterCostLYD, commission = 0;
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
            masterRate = clientTier === 3 ? settings.rateLevel3 : (clientTier === 2 ? settings.rateLevel2 : settings.rateLevel1);
            if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
            actualSubRate = masterRate - account.customMargin; if (actualSubRate <= 0) actualSubRate = masterRate;
            subCostLYD = parseFloat((amount / actualSubRate).toFixed(3)); masterCostLYD = parseFloat((amount / masterRate).toFixed(3)); commission = parseFloat((subCostLYD - masterCostLYD).toFixed(3));

            if (account.masterType === 'company') { companyId = masterObj._id; companyName = masterObj.name; telegramId = null; }
            else { companyName = masterObj.name; telegramId = masterObj.telegramId; }

            const minSubBalance = subCostLYD - (account.creditLimit || 0);
            const minMasterBalance = masterCostLYD - (masterObj.creditLimit || 0);

            // 🟢 الخصم الذري لنقطة البيع + القيد المالي
            const updatedSub = await SubAccount.findOneAndUpdate(
                { _id: account._id, balance: { $gte: minSubBalance } },
                { $inc: { balance: -subCostLYD } },
                { new: true, ...sessionOpts }
            );
            if (!updatedSub) throw new Error('SUB_INSUFFICIENT_BALANCE');
            
            await new Ledger({
                entityId: account._id, entityModel: 'SubAccount', transactionId: finalCustomId,
                type: 'TRANSFER', amount: -subCostLYD, balanceBefore: updatedSub.balance + subCostLYD,
                balanceAfter: updatedSub.balance, description: `تحويل ${amount} EGP إلى ${phone}`
            }).save(sessionOpts);

            // 🟢 الخصم الذري للرئيسي + القيد المالي
            const MasterModel = account.masterType === 'user' ? User : ClientCompany;
            const updatedMaster = await MasterModel.findOneAndUpdate(
                { _id: masterObj._id, balance: { $gte: minMasterBalance } },
                { $inc: { balance: -masterCostLYD } },
                { new: true, ...sessionOpts }
            );

            if (!updatedMaster) throw new Error('MASTER_INSUFFICIENT_BALANCE');
            
            await new Ledger({
                entityId: masterObj._id, entityModel: MasterModel.modelName, transactionId: finalCustomId,
                type: 'TRANSFER', amount: -masterCostLYD, balanceBefore: updatedMaster.balance + masterCostLYD,
                balanceAfter: updatedMaster.balance, description: `تحويل من نقطة بيع (${account.name}): ${amount} EGP إلى ${phone}`
            }).save(sessionOpts);

            balanceModel = updatedSub;
            masterObj = updatedMaster;

        } else {
            if (req.session.accountType === 'company') {
                const company = await withSess(ClientCompany.findById(account.companyId));
                masterRate = company.tier === 3 ? settings.rateLevel3 : (company.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
                if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
                masterCostLYD = parseFloat((amount / masterRate).toFixed(3));
                balanceModel = company; companyId = company._id; companyName = company.name; telegramId = account.phone || account.webUsername;
            } else {
                masterRate = account.tier === 3 ? settings.rateLevel3 : (account.tier === 2 ? settings.rateLevel2 : settings.rateLevel1);
                if (transferType === 'بريد حساب') masterRate -= 0.05; else if (transferType === 'بريد بطاقة') masterRate -= 0.15; 
                masterCostLYD = parseFloat((amount / masterRate).toFixed(3));
                balanceModel = account; telegramId = account.phone || account.webUsername;
            }

            const minBalance = masterCostLYD - (balanceModel.creditLimit || 0);
            const BModel = req.session.accountType === 'company' ? ClientCompany : User;
            
            // 🟢 الخصم الذري للرئيسي + القيد المالي
            const updatedClient = await BModel.findOneAndUpdate(
                { _id: balanceModel._id, balance: { $gte: minBalance } },
                { $inc: { balance: -masterCostLYD } },
                { new: true, ...sessionOpts }
            );

            if (!updatedClient) throw new Error('INSUFFICIENT_BALANCE');
            balanceModel = updatedClient;

            await new Ledger({
                entityId: balanceModel._id, entityModel: BModel.modelName, transactionId: finalCustomId,
                type: 'TRANSFER', amount: -masterCostLYD, balanceBefore: balanceModel.balance + masterCostLYD,
                balanceAfter: balanceModel.balance, description: `تحويل ${amount} EGP إلى ${phone}`
            }).save(sessionOpts);
        }

        // 🟢 تسجيل المعاملة النهائية
        const newTx = new Transaction({
            customId: finalCustomId, userId: telegramId, companyId: companyId, subAccountId: isSubAccount ? account._id : null,
            subAccountName: isSubAccount ? account.name : '', companyName: isSubAccount ? masterObj.name : companyName, 
            employeeName: isSubAccount ? account.name : account.name, vodafoneNumber: phone, transferType: transferType,
            accountName: req.body.name || '', accountNumber: req.body.number || '', amount: amount, costLYD: masterCostLYD,
            subAccountCostLYD: isSubAccount ? subCostLYD : 0, commission: commission, exchangeRate: masterRate, subClientRate: isSubAccount ? actualSubRate : 0,
            notes: notes, status: 'pending', isSubAccountTx: isSubAccount, masterProfit: isSubAccount ? commission : 0
        });
        await newTx.save(sessionOpts);

        // Log successful transfer to audit log
        await logAction({
            action: 'TRANSFER_CREATED',
            req,
            performedById: account._id,
            performedByModel: isSubAccount ? 'SubAccount' : (req.session.accountType === 'company' ? 'ClientEmployee' : 'User'),
            performedByName: account.name,
            targetId: newTx._id,
            targetModel: 'Transaction',
            newData: { customId: finalCustomId, amount, transferType, costLYD: masterCostLYD, exchangeRate: masterRate },
            metadata: { customId: finalCustomId, transferType }
        });

        // ✅ تأكيد العملية بنجاح (Commit)
        if (useTransaction) { await session.commitTransaction(); session.endSession(); }

        if (isAjax) res.json({ success: true, message: '✅ تم الإرسال بنجاح!', newBalance: balanceModel.balance.toFixed(2) });

        // 🔔 إرسال الإشعارات
        setImmediate(async () => {
            try {
                const masterNameText = isSubAccount ? masterObj.name : companyName;
                const requesterText = isSubAccount ? `${account.name} (نقطة بيع)` : 'حساب الوكيل المباشر';
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
        // 🔴 في حال أي خطأ يتم التراجع عن خصم الأرصدة وإلغاء الفواتير والدفتر
        console.error('[Transfer] خطأ:', error.message, error.stack);
        if (useTransaction) { try { await session.abortTransaction(); session.endSession(); } catch(e) {} }

        // Log failed transfer to audit log
        try {
            await logAction({
                action: 'TRANSFER_CREATED',
                req,
                performedById: auditAccount ? auditAccount._id : null,
                performedByModel: auditAccount ? (auditIsSubAccount ? 'SubAccount' : (req.session.accountType === 'company' ? 'ClientEmployee' : 'User')) : 'System',
                performedByName: auditAccount ? auditAccount.name : 'System',
                success: false,
                errorCode: error.message,
                metadata: { amount: req.body.amount, transferType: req.body.type || 'كاش' }
            });
        } catch (_) {}

        if (error.message === 'SYSTEM_CLOSED') return isAjax ? res.status(403).json({ error: '⛔ النظام مغلق.' }) : null;
        if (error.message === 'INVALID_DATA') return isAjax ? res.status(400).json({ error: '❌ بيانات التحويل غير صحيحة.' }) : null;
        if (error.message.includes('INSUFFICIENT_BALANCE')) return isAjax ? res.status(400).json({ error: '❌ الرصيد غير كافٍ أو تغير أثناء العملية.' }) : null;

        return isAjax ? res.status(500).json({ error: '❌ خطأ داخلي.' }) : null;
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
            notes: req.body.notes || ''
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
        if (!transactionId || !complaintText) {
            return res.json({ success: false, error: 'يرجى ملء جميع الحقول.' });
        }
        const tx = await Transaction.findById(transactionId);
        if (!tx) return res.json({ success: false, error: 'العملية غير موجودة.' });
        
        tx.complaintText = complaintText;
        tx.emergencyAlert = `شكوى عميل: ${complaintText}`;
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
        } else if (req.session.accountType === 'user') {
            const user = await User.findById(accountId);
            if (user && tx.userId === (user.phone || user.webUsername)) hasAccess = true;
        }

        if (!hasAccess) return res.status(403).send('غير مصرح لك بعرض هذه الصورة أو الإيصال');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        
        if (tx.proofImages && tx.proofImages.length > index) {
            photoId = tx.proofImages[index];
        } else if (tx.proofImage && index === 0) {
            photoId = tx.proofImage; 
        }

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) {
        console.error(error);
        res.status(500).send('خطأ داخلي في الخادم');
    }
};
