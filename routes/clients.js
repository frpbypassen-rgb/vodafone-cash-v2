const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const Transaction = require('../models/Transaction');
const ClientEmployee = require('../models/ClientEmployee');
const Notification = require('../models/Notification');
const SubAccount = require('../models/SubAccount');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const { updateBalanceWithLedger } = require('../services/walletService');
const {
    CODE_LENGTHS,
    expectedUserCodeLength,
    validateAccountCode,
    ensureAccountCodeAvailable,
    reserveAccountCode,
    releaseAccountCodeReservation
} = require('../services/accountCodeService');

const accountCodeErrorQuery = (error) => {
    if (error.message === 'ACCOUNT_CODE_DUPLICATE') return 'duplicate';
    if (error.message.startsWith('ACCOUNT_CODE_INVALID_')) return 'invalid';
    return 'error';
};

const visibleAccountFilter = { status: { $ne: 'deleted' } };

const saveAccountCode = async ({ Model, modelName, id, code, expectedLength }) => {
    const normalized = String(code || '').trim();
    const current = { modelName, id };
    const existing = await Model.findById(id).select('accountCode').lean();
    if (!existing) throw new Error('ACCOUNT_NOT_FOUND');

    if (!normalized) {
        await Model.findByIdAndUpdate(id, { $unset: { accountCode: 1 } });
        await releaseAccountCodeReservation(current);
        return;
    }

    const validCode = validateAccountCode(normalized, expectedLength);
    await ensureAccountCodeAvailable(validCode, current);
    await reserveAccountCode(validCode, current);

    try {
        await Model.findByIdAndUpdate(id, { accountCode: validCode }, { runValidators: true });
    } catch (error) {
        if (existing.accountCode) {
            await reserveAccountCode(existing.accountCode, current).catch(() => {});
        } else {
            await releaseAccountCodeReservation(current).catch(() => {});
        }
        throw error;
    }
};

const deleteMetadata = (req) => ({
    deletedAt: new Date(),
    deletedBy: req.session.adminId || req.session.adminName || 'admin'
});

const releaseSubAccountCodes = async (subAccounts) => {
    await Promise.all(subAccounts.map((sub) => (
        releaseAccountCodeReservation({ modelName: 'SubAccount', id: sub._id }).catch(() => {})
    )));
};

const deletedAccountUpdate = (req) => ({
    $set: { status: 'deleted', refreshToken: null, ...deleteMetadata(req) },
    $unset: { accountCode: 1, otpCode: 1, otpExpires: 1 }
});

const createManualAdjustmentId = (amount) => {
    const prefix = amount > 0 ? 'DEP' : 'DED';
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const runDbTransaction = async (callback) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const result = await callback(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        try { await session.abortTransaction(); } catch (_) {}
        throw error;
    } finally {
        session.endSession();
    }
};

const balanceErrorQuery = (error) => {
    if (error.message === 'INSUFFICIENT_BALANCE') return 'insufficient';
    if (error.message === 'ACCOUNT_NOT_FOUND') return 'notfound';
    return 'failed';
};

router.get('/clients', requireAuth, async (req, res) => {
    try {
        const users = await User.find(visibleAccountFilter).sort({ createdAt: -1 });
        const companies = await ClientCompany.find(visibleAccountFilter).sort({ createdAt: -1 });
        const subAccounts = await SubAccount.find(visibleAccountFilter).sort({ createdAt: -1 }).lean();

        // Get distinct master IDs of sub-accounts to identify agents
        const distinctMasterIds = await SubAccount.distinct('masterId', visibleAccountFilter);

        // Categorize:
        // 1. Agents (وكلاء) are users/companies who have subaccounts
        const agentsList = [];
        const directUsers = [];
        const directCompanies = [];

        users.forEach(u => {
            if (distinctMasterIds.some(id => id.toString() === u._id.toString())) {
                agentsList.push({ ...u.toObject(), type: 'user' });
            } else {
                directUsers.push(u);
            }
        });

        companies.forEach(c => {
            if (distinctMasterIds.some(id => id.toString() === c._id.toString())) {
                agentsList.push({ ...c.toObject(), type: 'company' });
            } else {
                directCompanies.push(c);
            }
        });

        // Link sub-accounts with their master agent name
        for (const sub of subAccounts) {
            let masterName = 'غير معروف';
            if (sub.masterType === 'user') {
                const u = users.find(x => x._id.toString() === sub.masterId.toString());
                if (u) masterName = u.name;
            } else if (sub.masterType === 'company') {
                const c = companies.find(x => x._id.toString() === sub.masterId.toString());
                if (c) masterName = c.name;
            }
            sub.masterName = masterName;
        }

        res.render('clients', {
            users: directUsers,
            companies: directCompanies,
            agents: agentsList,
            subAccounts: subAccounts,
            query: req.query
        });
    } catch (e) {
        console.error('[clients] خطأ في جلب بيانات العملاء:', e.message);
        res.status(500).send('خطأ داخلي في الخادم');
    }
});

router.get('/user/:id', requireAuth, async (req, res) => {
    const user = await User.findOne({ _id: req.params.id, ...visibleAccountFilter });
    if (!user) return res.redirect('/clients?deleteError=notfound');
    const transactions = await Transaction.find({ userId: user.phone || user.webUsername, companyId: null }).sort({ createdAt: -1 }).limit(50);
    const hasSubAccounts = await SubAccount.exists({ masterType: 'user', masterId: user._id, ...visibleAccountFilter });
    res.render('user_details', { user, transactions, accountCodeLength: expectedUserCodeLength(user, Boolean(hasSubAccounts)), query: req.query });
});

router.get('/company/:id', requireAuth, async (req, res) => {
    const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter });
    if (!company) return res.redirect('/clients?deleteError=notfound');
    const transactions = await Transaction.find({ companyId: company._id }).sort({ createdAt: -1 }).limit(50);
    res.render('company_details', { company, transactions, accountCodeLength: CODE_LENGTHS.company, query: req.query });
});

router.post('/user/:id/add-balance', requireAuth, requireMaster, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (isNaN(amount) || amount === 0) return res.redirect(`/user/${req.params.id}?balanceError=invalid`);

        const { user, tx } = await runDbTransaction(async (session) => {
            const account = await User.findById(req.params.id).session(session);
            if (!account) throw new Error('ACCOUNT_NOT_FOUND');

            const customId = createManualAdjustmentId(amount);
            const type = amount > 0 ? 'DEPOSIT' : 'DEDUCTION';
            const status = amount > 0 ? 'deposit' : 'deduction';
            const description = `${amount > 0 ? 'Admin deposit' : 'Admin deduction'} for user ${account.name || account.webUsername || account.phone}`;

            await updateBalanceWithLedger('User', account._id, amount, type, customId, description, {
                minBalance: 0,
                session
            });

            const [createdTx] = await Transaction.create([{
                userId: account.phone || account.webUsername,
                amount: Math.abs(amount),
                costLYD: 0,
                vodafoneNumber: '01000000000',
                status,
                customId,
                companyName: 'عميل فردي',
                employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)',
                notes
            }], { session });

            return { user: account, tx: createdTx };
        });

        const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد';
        const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
        try { await Notification.create({ userId: user.phone || user.webUsername, title: 'إشعار مالي', message: msg, type: amount > 0 ? 'deposit' : 'deduction' }); } catch(err) {}

        return res.redirect(`/user/${user._id}`);
    } catch (e) {
        return res.redirect(`/user/${req.params.id}?balanceError=${balanceErrorQuery(e)}`);
    }
});

router.post('/user/:id/toggle-status', requireAuth, requireMaster, async (req, res) => {
    const user = await User.findById(req.params.id); user.status = user.status === 'active' ? 'banned' : 'active'; await user.save(); res.redirect(`/user/${user._id}`);
});

router.post('/user/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const user = await User.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id');
        if (!user) return res.redirect('/clients?deleteError=notfound');

        const subAccounts = await SubAccount.find({ masterType: 'user', masterId: user._id, ...visibleAccountFilter }).select('_id').lean();
        await releaseAccountCodeReservation({ modelName: 'User', id: user._id });
        await releaseSubAccountCodes(subAccounts);

        await User.updateOne({ _id: user._id }, deletedAccountUpdate(req), { strict: false });
        if (subAccounts.length) {
            await SubAccount.updateMany(
                { _id: { $in: subAccounts.map((sub) => sub._id) } },
                deletedAccountUpdate(req),
                { strict: false }
            );
        }

        res.redirect('/clients?deleted=1');
    } catch (error) {
        console.error('[clients/delete-user] خطأ في حذف حساب العميل:', error.message);
        res.redirect('/clients?deleteError=1');
    }
});

router.post('/user/:id/change-level', requireAuth, requireMaster, async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/user/${req.params.id}`);
});

router.post('/user/:id/update-limit', requireAuth, requireMaster, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await User.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/user/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

router.post('/user/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        const hasSubAccounts = await SubAccount.exists({ masterType: 'user', masterId: user._id });
        await saveAccountCode({
            Model: User,
            modelName: 'User',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: expectedUserCodeLength(user, Boolean(hasSubAccounts))
        });
        res.redirect(`/user/${req.params.id}?codeSaved=1`);
    } catch (error) {
        res.redirect(`/user/${req.params.id}?codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/company/:id/add-balance', requireAuth, requireMaster, async (req, res) => {
    try {
        const amount = parseFloat(req.body.amount);
        const notes = req.body.notes ? req.body.notes.trim() : '';
        if (isNaN(amount) || amount === 0) return res.redirect(`/company/${req.params.id}?balanceError=invalid`);

        const { company, tx } = await runDbTransaction(async (session) => {
            const account = await ClientCompany.findById(req.params.id).session(session);
            if (!account) throw new Error('ACCOUNT_NOT_FOUND');

            const customId = createManualAdjustmentId(amount);
            const type = amount > 0 ? 'DEPOSIT' : 'DEDUCTION';
            const status = amount > 0 ? 'deposit' : 'deduction';
            const description = `${amount > 0 ? 'Admin deposit' : 'Admin deduction'} for company ${account.name || account._id}`;

            await updateBalanceWithLedger('ClientCompany', account._id, amount, type, customId, description, {
                minBalance: 0,
                session
            });

            const [createdTx] = await Transaction.create([{
                userId: 'admin',
                companyId: account._id,
                amount: Math.abs(amount),
                costLYD: 0,
                vodafoneNumber: '01000000000',
                status,
                customId,
                companyName: account.name,
                employeeName: amount > 0 ? 'الإدارة (إيداع)' : 'الإدارة (خصم)',
                notes
            }], { session });

            return { company: account, tx: createdTx };
        });

        const actionType = amount > 0 ? 'إيداع/شحن رصيد' : 'خصم من الرصيد';
        const msg = `💰 <b>إشعار مالي من الإدارة (${actionType})</b>\n\n💵 المبلغ: <b>${Math.abs(amount).toFixed(2)} دينار/EGP</b>\n📝 الملاحظة: ${notes || 'لا يوجد'}\n🧾 رقم العملية: <code>${tx.customId}</code>`;
        const emps = await ClientEmployee.find({ companyId: company._id, status: 'active' });
        for (const emp of emps) {
            try { await Notification.create({ userId: emp.webUsername, title: 'إشعار مالي', message: msg, type: amount > 0 ? 'deposit' : 'deduction' }); } catch(err) {}
        }

        return res.redirect(`/company/${company._id}`);
    } catch (e) {
        return res.redirect(`/company/${req.params.id}?balanceError=${balanceErrorQuery(e)}`);
    }
});

router.post('/company/:id/update-rate', requireAuth, requireMaster, async (req, res) => {
    try {
        const rate = Math.abs(parseFloat(req.body.exchangeRate) || 0);
        await ClientCompany.findByIdAndUpdate(req.params.id, { exchangeRate: rate }, { strict: false });
        res.redirect(`/company/${req.params.id}`);
    } catch (e) {
        res.redirect('/clients');
    }
});

router.post('/company/:id/toggle-status', requireAuth, requireMaster, async (req, res) => {
    const comp = await ClientCompany.findById(req.params.id); comp.status = comp.status === 'active' ? 'inactive' : 'active'; await comp.save(); res.redirect(`/company/${comp._id}`);
});

router.post('/company/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const company = await ClientCompany.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id');
        if (!company) return res.redirect('/clients?deleteError=notfound');

        const subAccounts = await SubAccount.find({ masterType: 'company', masterId: company._id, ...visibleAccountFilter }).select('_id').lean();
        await releaseAccountCodeReservation({ modelName: 'ClientCompany', id: company._id });
        await releaseSubAccountCodes(subAccounts);

        await ClientCompany.updateOne({ _id: company._id }, deletedAccountUpdate(req), { strict: false });
        await ClientEmployee.updateMany(
            { companyId: company._id, status: { $ne: 'deleted' } },
            {
                $set: { status: 'deleted', ...deleteMetadata(req) },
                $unset: { otpCode: 1, otpExpires: 1 }
            },
            { strict: false }
        );
        if (subAccounts.length) {
            await SubAccount.updateMany(
                { _id: { $in: subAccounts.map((sub) => sub._id) } },
                deletedAccountUpdate(req),
                { strict: false }
            );
        }

        res.redirect('/clients?deleted=1');
    } catch (error) {
        console.error('[clients/delete-company] خطأ في حذف حساب الشركة:', error.message);
        res.redirect('/clients?deleteError=1');
    }
});

router.post('/company/:id/change-level', requireAuth, requireMaster, async (req, res) => {
    await ClientCompany.findByIdAndUpdate(req.params.id, { tier: parseInt(req.body.tier) }); res.redirect(`/company/${req.params.id}`);
});

router.post('/company/:id/update-limit', requireAuth, requireMaster, async (req, res) => {
    try { const limit = Math.abs(parseFloat(req.body.creditLimit) || 0); await ClientCompany.findByIdAndUpdate(req.params.id, { creditLimit: limit }); res.redirect(`/company/${req.params.id}`); } catch (e) { res.redirect('/clients'); }
});

router.post('/company/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        await saveAccountCode({
            Model: ClientCompany,
            modelName: 'ClientCompany',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: CODE_LENGTHS.company
        });
        res.redirect(`/company/${req.params.id}?codeSaved=1`);
    } catch (error) {
        res.redirect(`/company/${req.params.id}?codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/sub-account/:id/update-account-code', requireAuth, requireMaster, async (req, res) => {
    try {
        await saveAccountCode({
            Model: SubAccount,
            modelName: 'SubAccount',
            id: req.params.id,
            code: req.body.accountCode,
            expectedLength: CODE_LENGTHS.subAccount
        });
        res.redirect('/clients?codeSaved=1');
    } catch (error) {
        res.redirect(`/clients?codeError=${accountCodeErrorQuery(error)}`);
    }
});

router.post('/sub-account/:id/delete', requireAuth, requireMaster, async (req, res) => {
    try {
        const subAccount = await SubAccount.findOne({ _id: req.params.id, ...visibleAccountFilter }).select('_id');
        if (!subAccount) return res.redirect('/clients?deleteError=notfound');

        await releaseAccountCodeReservation({ modelName: 'SubAccount', id: subAccount._id });
        await SubAccount.updateOne({ _id: subAccount._id }, deletedAccountUpdate(req), { strict: false });

        res.redirect('/clients?deleted=1');
    } catch (error) {
        console.error('[clients/delete-sub-account] خطأ في حذف حساب عميل الوكيل:', error.message);
        res.redirect('/clients?deleteError=1');
    }
});

module.exports = router;
