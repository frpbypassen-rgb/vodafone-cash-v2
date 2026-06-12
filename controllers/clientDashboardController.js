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

exports.getDashboard = async (req, res) => {
    try {
        const isSubAccount = req.session.accountType === 'sub_client';
        const Model = isSubAccount ? SubAccount : (req.session.accountType === 'company' ? ClientEmployee : User);
        const account = await Model.findById(req.session.clientId);
        if (!account) return res.redirect('/client/logout');
        if (account.status && account.status !== 'active') return res.redirect('/client/logout');

        const search = req.query.search ? req.query.search.trim() : '';
        let targetDate = req.query.date; let showMonth = req.query.month === 'true'; let dateLabel = '';

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

        let set = await Settings.findOne({});
        if (!set) set = await Settings.create({});
        let balance, currentRate, clientTier = 1;

        let accountCode = account.accountCode || '';

        if (isSubAccount) {
            balance = account.balance;
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            clientTier = master ? (master.tier || 1) : 1;
            let mRate = clientTier === 3 ? set.rateLevel3 : (clientTier === 2 ? set.rateLevel2 : set.rateLevel1);
            currentRate = mRate - account.customMargin;
        } else if (req.session.accountType === 'company') {
            const company = await ClientCompany.findById(account.companyId);
            if (!company || company.status !== 'active') return res.redirect('/client/logout');
            balance = company.balance; clientTier = company.tier || 1;
            accountCode = company.accountCode || '';
            currentRate = company.tier === 3 ? set.rateLevel3 : (company.tier === 2 ? set.rateLevel2 : set.rateLevel1);
        } else {
            balance = account.balance; clientTier = account.tier || 1;
            currentRate = account.tier === 3 ? set.rateLevel3 : (account.tier === 2 ? set.rateLevel2 : set.rateLevel1);
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

        if (isSubAccount) {
            accountTypeName = 'عميل جديد';
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            accountTypeDetail = master ? master.name : 'غير معروف';
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
            systemStatus: isSystemOpen ? 'تعمل' : 'خارج اوقات العمل',
            accountTypeName,
            accountTypeDetail,
            userRoleLabel,
            tier: clientTier
        };

        const canViewBalance = req.session.accountType !== 'company' || account.canViewAllReports;

        res.render('client/dashboard', {
            user: { name: account.name, phone: account.phone || account.webUsername, balance: balance, role: account.role || 'user', accountType: req.session.accountType, accountCode, canViewBalance },
            isSubAccount, isMaster: !isSubAccount, masterTotalProfit, transactions: combinedTransactions, currentRate, totals, targetDate, dateLabel, showMonth, search, query: req.query, storeCatalog,
            isSystemOpen,
            profile
        });
    } catch (error) {
        console.error("Dashboard Render Error:", error);
        res.redirect('/client/logout');
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
    const { name, phone, webUsername, webPassword, customMargin, creditLimit, cardMargin } = req.body;
    const isEmployee = req.session.accountType === 'company';
    const account = isEmployee ? await ClientEmployee.findById(req.session.clientId) : await User.findById(req.session.clientId);
    if (isEmployee || !account || account.role !== 'agent') return res.status(403).send('Unauthorized');
    let masterType = isEmployee ? 'company' : 'user'; let masterId = isEmployee ? account.companyId : account._id;

    try {
        await SubAccount.create({ masterType, masterId, name, phone, webUsername, webPassword, customMargin: parseFloat(customMargin) || 0, cardMargin: parseFloat(cardMargin) || 0, creditLimit: parseFloat(creditLimit) || 0 });
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
            if (type === 'withdraw' && sub.balance < val) return res.redirect('/client/sub-accounts?error=funds');

            const txId = `SET-${Date.now().toString().slice(-6)}`;

            await updateBalanceWithLedger(
                'SubAccount',
                sub._id,
                type === 'add' ? val : -val,
                type === 'add' ? 'DEPOSIT' : 'DEDUCTION',
                txId,
                type === 'add' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`
            );

            let parentUserId = null, parentClientCompanyId = null, empName = 'الوكيل';
            if (req.session.accountType === 'company') { const emp = await ClientEmployee.findById(req.session.clientId); parentClientCompanyId = emp.companyId; empName = emp.name; }
            else { const user = await User.findById(req.session.clientId); parentUserId = user.phone || user.webUsername; empName = user.name; }

            await Transaction.create({ customId: txId, subAccountId: sub._id, userId: parentUserId, companyId: parentClientCompanyId, amount: Math.abs(val), costLYD: 0, status: type === 'add' ? 'deposit' : 'deduction', notes: type === 'add' ? `تمويل نقطة بيع (${sub.name})` : `سحب رصيد من نقطة بيع (${sub.name})`, companyName: 'تسوية وكيل', employeeName: empName });
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
        let set = await Settings.findOne({});
        if (!set) set = await Settings.create({});
        if (isSubAccount) {
            let master = account.masterType === 'user' ? await User.findById(account.masterId) : await ClientCompany.findById(account.masterId);
            let mRate = master.tier === 3 ? set.rateLevel3 : (master.tier === 2 ? set.rateLevel2 : set.rateLevel1);
            currentRate = mRate - account.customMargin;
        } else {
            let tier = 1;
            if (req.session.accountType === 'company') { const comp = await ClientCompany.findById(account.companyId); tier = comp.tier || 1; }
            else { tier = account.tier || 1; }
            currentRate = tier === 3 ? set.rateLevel3 : (tier === 2 ? set.rateLevel2 : set.rateLevel1);
        }

        const mappedTransactions = transactions.map(t => {
            if (isSubAccount && t.isSubAccountTx) { t.costLYD = t.subAccountCostLYD; t.exchangeRate = t.subClientRate; }
            return t;
        });

        res.json({ success: true, transactions: mappedTransactions, currentRate, availableBalance: account.balance });
    } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
};
