const mongoose = require('mongoose');

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const SubAccount = require('../models/SubAccount');
const StoreCategory = require('../models/StoreCategory');
const StoreProduct = require('../models/StoreProduct');
const Card = require('../models/Card');
const { updateBalanceWithLedger } = require('../services/walletService');
const { getServiceRatesForTier, getCompanyServiceRates } = require('../utils/rateHelper');
const { applyCustomerRateMargins, buildMarginStorage } = require('../utils/agencyPricing');
const clientCompanyController = require('./clientCompanyController');
const clientWorkspaceController = require('./clientWorkspaceController');
const businessPortalService = require('../services/businessPortalService');
const { sanitizeStatementTransaction } = require('../utils/accountStatementPrivacy');
const { normalizeCreditLimit } = require('../services/agencyCreditLimitService');
const { logAction } = require('../services/auditService');
const { saveProfilePhoto, streamProfilePhoto, removeProfilePhoto } = require('../services/profilePhotoStorageService');
const { activatePendingRateUpdate } = require('../services/rateChangeService');

const renderBusinessOverview = clientWorkspaceController.renderPage('overview');

exports.getDashboard = async (req, res) => {
    try {
        if (req.session.accountType === 'agent_staff') {
            return renderBusinessOverview(req, res);
        }

        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await Model.findById(req.session.clientId);
        if (!account) return res.redirect('/client/logout');
        if (account.status && account.status !== 'active') return res.redirect('/client/logout');

        if (req.session.accountType === 'company') {
            return renderBusinessOverview(req, res);
        }
        if (req.session.accountType === 'user' && account.role === 'agent') {
            return renderBusinessOverview(req, res);
        }

        const search = req.query.search ? req.query.search.trim() : '';
        let targetDate = req.query.date;
        const hasExplicitDateFilter = req.query.date !== undefined || req.query.month !== undefined;
        let showMonth = req.query.month === 'true' || !hasExplicitDateFilter;
        let dateLabel = '';

        let filter = {};
        if (isSubAccount) { filter.subAccountId = account._id; }
        else if (req.session.accountType === 'company') { filter.companyId = account.companyId; filter.subAccountId = null; }
        else { filter.userId = account.phone || account.webUsername; filter.companyId = null; filter.subAccountId = null; }

        let start, end;
        if (showMonth) {
            const now = new Date(); start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
            dateLabel = `شهر ${now.getMonth() + 1} لعام ${now.getFullYear()}`; targetDate = '';
        } else {
            if (!targetDate) { const today = new Date(); targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; }
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`); dateLabel = targetDate;
        }

        filter.createdAt = { $gte: start, $lte: end };
        if (search) { filter.$or = [{ notes: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { customId: { $regex: search, $options: 'i' } }]; }

        const transactions = await Transaction.find(filter).sort({ createdAt: -1 });

        let totals = { transfersEGP: 0, transfersLYD: 0, depositsEGP: 0 };
        let masterTotalProfit = 0;
        let subTransactionsList = [];

        if (!isSubAccount) {
            const subTxsFilter = req.session.accountType === 'company' ? { companyId: account.companyId } : { userId: account.phone || account.webUsername, companyId: null };
            subTxsFilter.subAccountId = { $ne: null };
            subTxsFilter.createdAt = { $gte: start, $lte: end };
            subTransactionsList = await Transaction.find(subTxsFilter).sort({ createdAt: -1 });
            subTransactionsList.forEach(t => { if (t.status === 'completed') masterTotalProfit += (t.masterProfit || 0); });
        }

        let combinedTransactions = isSubAccount ? transactions : [...transactions, ...subTransactionsList].sort((a,b) => b.createdAt - a.createdAt);

        combinedTransactions.forEach(tx => {
            if (tx.status === 'completed') {
                totals.transfersEGP += (tx.amount || 0);
                totals.transfersLYD += (isSubAccount ? (tx.subAccountCostLYD || tx.costLYD) : (tx.costLYD || 0));
            } else if (tx.status === 'deposit') {
                totals.depositsEGP += (tx.amount || 0);
            }
        });

        await activatePendingRateUpdate({ app: req.app });
        let set = await Settings.findOne({});
        if (!set) set = await Settings.create({});
        let balance, currentRate, serviceRates, clientTier = 1;

        let accountCode = account.accountCode || '';

        if (isSubAccount) {
            balance = account.balance;
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            clientTier = master ? (master.tier || 1) : 1;
            const masterRates = account.masterType === 'company'
                ? getCompanyServiceRates(master, set)
                : getServiceRatesForTier(clientTier, set);
            serviceRates = applyCustomerRateMargins(masterRates, account);
            currentRate = serviceRates.vodafone;
        } else if (req.session.accountType === 'company') {
            const company = await ClientCompany.findById(account.companyId);
            if (!company || company.status !== 'active') return res.redirect('/client/logout');
            balance = company.balance; clientTier = company.tier || 1;
            accountCode = company.accountCode || '';
            serviceRates = getCompanyServiceRates(company, set);
            currentRate = serviceRates.vodafone;
        } else {
            balance = account.balance; clientTier = account.tier || 1;
            serviceRates = getServiceRatesForTier(clientTier, set);
            currentRate = serviceRates.vodafone;
        }

        const categoriesMeta = await StoreCategory.find({});
        const productsMeta = await StoreProduct.find({});

        const availableCards = await Card.aggregate([
            { $match: { sold: false } },
            { $group: { _id: { category: "$category", name: "$name" }, price_1: { $first: "$price_1" }, price_2: { $first: "$price_2" }, price_3: { $first: "$price_3" }, count: { $sum: 1 } }},
            { $group: { _id: "$_id.category", products: { $push: { name: "$_id.name", price_1: "$price_1", price_2: "$price_2", price_3: "$price_3", count: "$count" } } }}
        ]);

        const storeCatalog = availableCards.map((cat, index) => {
            const catMeta = categoriesMeta.find(c => c.name === cat._id) || {};
            return {
                id: 'cat_' + index, categoryName: cat._id, icon: catMeta.icon || 'fa-store', color: catMeta.color || '#198754', image: catMeta.image || '',
                products: cat.products.map(p => {
                    let finalPrice = p.price_1;
                    if (clientTier === 2) finalPrice = p.price_2;
                    if (clientTier === 3) finalPrice = p.price_3;
                    const pMeta = productsMeta.find(pm => pm.name === p.name && pm.category === cat._id) || {};
                    return { name: p.name, price: finalPrice, count: p.count, image: pMeta.image || '' };
                })
            };
        });

        const currentHour = new Date().getHours();
        const isSystemOpen = currentHour >= 8 && currentHour < 23; // From 8 AM to 11 PM

        // Build detailed profile for mobile client card
        let accountTypeName = 'عميل مباشر';
        let accountTypeDetail = '';
        let userRoleLabel = 'عميل فردي';
        let profileMaster = null;

        if (isSubAccount) {
            accountTypeName = 'عميل جديد';
            profileMaster = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            accountTypeDetail = profileMaster ? profileMaster.name : 'غير معروف';
            userRoleLabel = 'نقطة بيع فرعية';
        } else if (req.session.accountType === 'company') {
            accountTypeName = 'شركة';
            const company = await ClientCompany.findById(account.companyId);
            accountTypeDetail = company ? company.name : 'غير معروف';
            userRoleLabel = account.canViewAllReports ? 'مدير' : 'موظف';
        } else if (account.role === 'agent') {
            accountTypeName = 'وكيل';
            accountTypeDetail = account.name;
            userRoleLabel = 'مدير';
        } else if (account.role === 'accountant') {
            accountTypeName = 'عميل مباشر';
            userRoleLabel = 'محاسب';
        } else {
            accountTypeName = 'عميل مباشر';
            userRoleLabel = 'عميل فردي';
        }

        const profile = {
            name: account.name,
            phone: account.phone || 'غير مسجل',
            username: account.webUsername,
            accountCode,
            agentAccountCode: isSubAccount && profileMaster && profileMaster.role === 'agent'
                ? (profileMaster.agentCode || profileMaster.accountCode || '')
                : '',
            address: account.address || (account.businessProfile && (account.businessProfile.address || account.businessProfile.city)) || 'غير مسجل',
            joinedAt: account.createdAt,
            accountStatus: account.status || 'active',
            profilePhotoUpdatedAt: account.profilePhotoUpdatedAt || null,
            hasProfilePhoto: Boolean(account.profilePhotoKey),
            canEditProfile: req.session.accountType === 'user' || isSubAccount,
            systemStatus: isSystemOpen ? 'تعمل' : 'خارج اوقات العمل',
            accountTypeName,
            accountTypeDetail,
            userRoleLabel,
            tier: clientTier
        };

        const canViewBalance = req.session.accountType !== 'company' || account.canViewAllReports;

        res.render('client/dashboard', {
            user: { name: account.name, phone: account.phone || account.webUsername, balance: balance, role: account.role || 'user', accountType: req.session.accountType, accountCode, canViewBalance },
            isSubAccount, isMaster: !isSubAccount, masterTotalProfit, transactions: combinedTransactions.map(sanitizeStatementTransaction), currentRate, serviceRates, totals, targetDate, dateLabel, showMonth, search, query: req.query, storeCatalog,
            isSystemOpen,
            profile,
            pendingRateUpdate: set?.pendingRateUpdate?.effectiveAt
                ? {
                    effectiveAt: new Date(set.pendingRateUpdate.effectiveAt).toISOString(),
                    changes: set.pendingRateUpdate.changes || {}
                }
                : null
        });
    } catch (error) {
        console.error("Dashboard Render Error:", error);
        res.redirect('/client/logout');
    }
};

exports.getProfilePhoto = async (req, res) => {
    try {
        const isSubAccount = req.session.accountType === 'sub_client';
        if (!isSubAccount && req.session.accountType !== 'user') return res.status(403).end();
        const Model = isSubAccount ? SubAccount : User;
        const account = await Model.findById(req.session.clientId);
        if (!account || !account.profilePhotoKey) return res.status(404).end();
        return streamProfilePhoto(account.profilePhotoKey, res);
    } catch (_) {
        return res.status(404).end();
    }
};

exports.postUpdateOwnProfile = async (req, res) => {
    let photoKey = null;
    try {
        const isSubAccount = req.session.accountType === 'sub_client';
        if (!isSubAccount && req.session.accountType !== 'user') return res.status(403).redirect('/client/dashboard');
        const Model = isSubAccount ? SubAccount : User;
        const account = await Model.findById(req.session.clientId);
        if (!account) return res.redirect('/client/logout');

        const name = String(req.body.name || '').trim().slice(0, 100);
        const address = String(req.body.address || '').trim().slice(0, 200);
        if (name.length < 3) return res.redirect('/client/dashboard?profileError=name');
        account.name = name;
        if (isSubAccount) {
            account.address = address;
        } else {
            account.businessProfile = {
                ...(account.businessProfile ? account.businessProfile.toObject ? account.businessProfile.toObject() : account.businessProfile : {}),
                address
            };
        }

        const imageBase64 = String(req.body.profileImageBase64 || '').trim();
        if (imageBase64) {
            photoKey = saveProfilePhoto(imageBase64, account._id);
            const previousKey = account.profilePhotoKey;
            account.profilePhotoKey = photoKey;
            account.profilePhotoUpdatedAt = new Date();
            if (previousKey && previousKey !== photoKey) {
                try { removeProfilePhoto(previousKey); } catch (_) { /* cleanup is best effort */ }
            }
        }
        await account.save();
        await logAction({
            action: 'CUSTOMER_PROFILE_UPDATED',
            req,
            performedById: account._id,
            performedByModel: isSubAccount ? 'SubAccount' : 'User',
            performedByName: account.name,
            metadata: { source: 'client_portal', profilePhotoUpdated: Boolean(photoKey) }
        });
        if (req.accepts('json')) {
            return res.json({
                success: true,
                profile: {
                    name: account.name,
                    address,
                    photoUpdatedAt: account.profilePhotoUpdatedAt || null
                }
            });
        }
        return res.redirect('/client/dashboard?tab=account&profileSuccess=1');
    } catch (error) {
        if (photoKey) {
            try { removeProfilePhoto(photoKey); } catch (_) { /* cleanup is best effort */ }
        }
        if (req.accepts('json')) {
            return res.status(400).json({ success: false, error: 'تعذر حفظ بيانات الملف الشخصي.' });
        }
        return res.redirect('/client/dashboard?tab=account&profileError=save');
    }
};

exports.getSubAccounts = async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.redirect('/client/dashboard');
    const isEmployee = req.session.accountType === 'company';
    const Model = isEmployee ? ClientEmployee : User;
    const account = await Model.findById(req.session.clientId);

    if (isEmployee || !account || account.role !== 'agent') return res.redirect('/client/dashboard');

    let masterType = isEmployee ? 'company' : 'user';
    let masterId = isEmployee ? account.companyId : account._id;
    const subAccounts = await SubAccount.find({ masterType, masterId }).sort({ createdAt: -1 });

    let totalDebt = 0; subAccounts.forEach(s => { if (s.balance < 0) totalDebt += Math.abs(s.balance); });
    res.render('client/sub_accounts', { user: account, subAccounts, totalDebt, isEmployee });
};

exports.postAddSubAccount = async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const { name, phone, webUsername, webPassword, customMargin, marginPiasters, creditLimit, cardMargin } = req.body;
    const isEmployee = req.session.accountType === 'company';
    const account = isEmployee ? await ClientEmployee.findById(req.session.clientId) : await User.findById(req.session.clientId);
    if (isEmployee || !account || account.role !== 'agent') return res.status(403).send('Unauthorized');
    let masterType = isEmployee ? 'company' : 'user'; let masterId = isEmployee ? account.companyId : account._id;

    try {
        const pricing = buildMarginStorage({ marginPiasters, customMargin });
        const normalizedCreditLimit = normalizeCreditLimit(creditLimit);
        await SubAccount.create({
            masterType,
            masterId,
            name,
            phone,
            webUsername,
            webPassword,
            ...pricing,
            cardMargin: parseFloat(cardMargin) || 0,
            creditLimit: normalizedCreditLimit,
            creditLimitUpdatedAt: normalizedCreditLimit > 0 ? new Date() : undefined,
            creditLimitUpdatedBy: normalizedCreditLimit > 0 ? account.name : undefined,
            creditLimitUpdatedByModel: normalizedCreditLimit > 0 ? 'User' : undefined,
            creditLimitUpdatedById: normalizedCreditLimit > 0 ? account._id : undefined
        });
        res.redirect('/client/sub-accounts?success=1');
    } catch(e) { res.redirect('/client/sub-accounts?error=1'); }
};

exports.postSettleSubAccount = async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const isEmployee = req.session.accountType === 'company';
    const account = isEmployee ? await ClientEmployee.findById(req.session.clientId) : await User.findById(req.session.clientId);
    if (isEmployee || !account || account.role !== 'agent') return res.status(403).send('Unauthorized');
    const { amount, type } = req.body; let val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return res.redirect('/client/sub-accounts?error=1');

    try {
        const sub = await SubAccount.findById(req.params.id);
        if(sub) {
            const txId = `SET-${Date.now().toString().slice(-6)}`;
            const delta = type === 'add' ? val : -val;

            await updateBalanceWithLedger(
                'SubAccount',
                sub._id,
                delta,
                type === 'add' ? 'DEPOSIT' : 'DEDUCTION',
                txId,
                type === 'add' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`,
                { allowNegative: true }
            );

            let parentUserId = null, parentClientCompanyId = null, empName = 'الوكيل';
            if (req.session.accountType === 'company') { const emp = await ClientEmployee.findById(req.session.clientId); parentClientCompanyId = emp.companyId; empName = emp.name; }
            else { const user = await User.findById(req.session.clientId); parentUserId = user.phone || user.webUsername; empName = user.name; }

            const adminNotes = type === 'add' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`;
            await Transaction.create({
                customId: txId,
                subAccountId: sub._id,
                userId: parentUserId,
                companyId: parentClientCompanyId,
                amount: Math.abs(val),
                costLYD: 0,
                status: type === 'add' ? 'deposit' : 'deduction',
                notes: '',
                adminNotes,
                companyName: 'تسوية وكيل',
                employeeName: empName,
                balanceAdjustment: { entityModel: 'SubAccount', entityId: sub._id, delta, reversible: true }
            });
        }
        res.redirect('/client/sub-accounts');
    } catch(e) { res.redirect('/client/sub-accounts?error=db'); }
};

exports.postToggleSubAccount = async (req, res) => {
    if (req.session.accountType === 'sub_client') return res.status(403).send('Unauthorized');
    const isEmployee = req.session.accountType === 'company';
    const account = isEmployee ? await ClientEmployee.findById(req.session.clientId) : await User.findById(req.session.clientId);
    if (isEmployee || !account || account.role !== 'agent') return res.status(403).send('Unauthorized');
    const sub = await SubAccount.findById(req.params.id);
    if(sub) { sub.status = sub.status === 'active' ? 'banned' : 'active'; await sub.save(); }
    res.redirect('/client/sub-accounts');
};


exports.getApiTransactions = async (req, res) => {
    try {
        if (req.session.accountType === 'company' || req.session.accountType === 'agent_staff') {
            const workspace = await businessPortalService.resolveWorkspace(req);
            const query = { ...req.query };
            if (!workspace.forceToday) {
                if (query.month === 'true') {
                    const now = new Date();
                    query.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                } else if (!query.date && !query.from && !query.to && !query.month) {
                    query.date = businessPortalService.formatInputDate(new Date());
                }
            }

            const { filter } = await businessPortalService.buildTransactionFilter(
                workspace,
                query,
                { forceToday: workspace.forceToday }
            );
            const [transactions, settings] = await Promise.all([
                Transaction.find(filter).sort({ createdAt: -1 }).limit(40).lean(),
                Settings.findOne({}).lean()
            ]);
            const serviceRates = workspace.isCompany
                ? getCompanyServiceRates(workspace.entity, settings || {})
                : getServiceRatesForTier(workspace.entity.tier || 1, settings || {});

            return res.json({
                success: true,
                transactions,
                currentRate: serviceRates.vodafone,
                serviceRates,
                availableBalance: workspace.permissions.canViewBalance ? Number(workspace.entity.balance || 0) : null
            });
        }

        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await Model.findById(req.session.clientId);

        let filter = {};
        if (isSubAccount) { filter.subAccountId = account._id; }
        else if (req.session.accountType === 'company') { filter.companyId = account.companyId; filter.subAccountId = null; }
        else { filter.userId = account.phone || account.webUsername; filter.companyId = null; filter.subAccountId = null; }

        const search = req.query.search ? req.query.search.trim() : '';
        let targetDate = req.query.date; let showMonth = req.query.month === 'true'; let start, end;
        if (showMonth) {
            const now = new Date(); start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
        } else {
            if (!targetDate) { const today = new Date(); targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`; }
            start = new Date(`${targetDate}T00:00:00.000Z`); end = new Date(`${targetDate}T23:59:59.999Z`);
        }
        filter.createdAt = { $gte: start, $lte: end };
        if (search) { filter.$or = [{ notes: { $regex: search, $options: 'i' } }, { vodafoneNumber: { $regex: search, $options: 'i' } }, { customId: { $regex: search, $options: 'i' } }]; }

        let transactions = await Transaction.find(filter).sort({ createdAt: -1 }).limit(25).lean();

        if (!isSubAccount) {
            const subFilter = req.session.accountType === 'company' ? { companyId: account.companyId } : { userId: account.phone || account.webUsername, companyId: null };
            subFilter.subAccountId = { $ne: null }; subFilter.createdAt = { $gte: start, $lte: end };
            const subTransactionsList = await Transaction.find(subFilter).sort({ createdAt: -1 }).limit(15).lean();
            transactions = [...transactions, ...subTransactionsList].sort((a,b) => b.createdAt - a.createdAt);
        }

        let currentRate = 1;
        let serviceRates = {};
        let availableBalance = Number(account.balance || 0);
        let set = await Settings.findOne({});
        if (!set) set = await Settings.create({});
        if (isSubAccount) {
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            const tier = master ? (master.tier || 1) : 1;
            const masterRates = account.masterType === 'company'
                ? getCompanyServiceRates(master, set)
                : getServiceRatesForTier(tier, set);
            serviceRates = applyCustomerRateMargins(masterRates, account);
            currentRate = serviceRates.vodafone;
        } else {
            let tier = 1;
            if (req.session.accountType === 'company') {
                const comp = await ClientCompany.findById(account.companyId);
                tier = comp ? (comp.tier || 1) : 1;
                availableBalance = comp ? Number(comp.balance || 0) : 0;
                serviceRates = comp ? getCompanyServiceRates(comp, set) : getServiceRatesForTier(tier, set);
            }
            else { tier = account.tier || 1; }
            if (!serviceRates.vodafone) serviceRates = getServiceRatesForTier(tier, set);
            currentRate = serviceRates.vodafone;
        }

        if (req.session.accountType === 'company' && !clientCompanyController.companyRoleHelpers.canViewCompanyBalance(account)) {
            availableBalance = null;
        }

        const mappedTransactions = transactions.map(t => {
            if (isSubAccount && t.isSubAccountTx) { t.costLYD = t.subAccountCostLYD; t.exchangeRate = t.subClientRate; }
            return t;
        });

        res.json({ success: true, transactions: mappedTransactions, currentRate, serviceRates, availableBalance });
    } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
};
