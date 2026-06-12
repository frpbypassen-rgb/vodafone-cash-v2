const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const Employee = require('../models/Employee');
const SupportTicket = require('../models/SupportTicket');
const RegistrationRequest = require('../models/RegistrationRequest');
const { requireAuth } = require('../middlewares/auth');
const { syncBotBalance } = require('../utils/helpers');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');

router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        let photoId = null;
        if (tx.proofImages && tx.proofImages.length > index) photoId = tx.proofImages[index];
        else if (tx.proofImage && index === 0) photoId = tx.proofImage; 

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) { res.status(500).send('خطأ داخلي'); }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        const usersCount = await User.countDocuments(); const companiesCount = await ClientCompany.countDocuments(); const executorsCount = await Employee.countDocuments();
        const pendingTxs = await Transaction.countDocuments({ status: 'pending' }); const processingTxs = await Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } }); const completedTxs = await Transaction.countDocuments({ status: 'completed' });
        
        // --- إحصائيات اليوم المخصصة للهاتف المحمول ---
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const todayQuery = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
        
        const todayCompleted = await Transaction.countDocuments({ ...todayQuery, status: 'completed' });
        const todayPending = await Transaction.countDocuments({ ...todayQuery, status: 'pending' });
        const todayProcessing = await Transaction.countDocuments({ ...todayQuery, status: { $in: ['processing', 'accepted'] } });
        const todayCancelled = await Transaction.countDocuments({ ...todayQuery, status: { $in: ['rejected', 'cancelled_by_admin'] } });
        const todayTotal = await Transaction.countDocuments(todayQuery);

        // حساب مبالغ العمليات المكتملة لليوم
        const sums = await Transaction.aggregate([
            { $match: { ...todayQuery, status: 'completed' } },
            { $group: { _id: null, totalEGP: { $sum: '$amount' }, totalLYD: { $sum: '$costLYD' } } }
        ]);

        const todayEGP = sums.length > 0 ? sums[0].totalEGP : 0;
        const todayLYD = sums.length > 0 ? sums[0].totalLYD : 0;

        res.render('index', { 
            usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs, adminName: req.session.adminName,
            todayCompleted, todayPending, todayProcessing, todayCancelled, todayTotal, todayEGP, todayLYD
        });
    } catch (e) { console.error('Dashboard Error:', e); res.status(500).send('خطأ داخلي'); }
});

router.get('/api/sidebar-stats', requireAuth, async (req, res) => {
    try {
        const complaintsCount = await Transaction.countDocuments({
            $or: [
                { complaintText: { $exists: true, $ne: '' } },
                { emergencyAlert: { $exists: true, $ne: '' } }
            ]
        });
        const regRequestsCount = await RegistrationRequest.countDocuments({ status: 'pending' });
        const supportCount = await SupportTicket.countDocuments({ unreadAdmin: { $gt: 0 } });
        const pendingCount = await Transaction.countDocuments({ status: 'pending' });
        res.json({
            success: true,
            complaintsCount,
            regRequestsCount,
            supportCount,
            pendingCount
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

const Notification = require('../models/Notification');

router.get('/api/notifications/unread', requireAuth, async (req, res) => {
    try { const notifs = await Notification.find({ isRead: false }).sort({ createdAt: -1 }); res.json({ count: notifs.length, notifications: notifs }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    try { await Notification.updateMany({ isRead: false }, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.get('/complaints', requireAuth, async (req, res) => {
    try {
        const complaints = await Transaction.find({ 
            $or: [
                { complaintText: { $exists: true, $ne: '' } },
                { emergencyAlert: { $exists: true, $ne: '' } }
            ]
        }).sort({ updatedAt: -1, createdAt: -1 });
        res.render('complaints', { complaints, adminName: req.session.adminName });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.post('/api/resolve-complaint', requireAuth, async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!transactionId) return res.status(400).json({ error: 'معرف العملية مطلوب' });
        await Transaction.findByIdAndUpdate(transactionId, { 
            $unset: { complaintText: "", emergencyAlert: "" }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'خطأ داخلي' }); }
});

router.post('/api/complaints/:id/edit-amount', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const newAmount = parseFloat(req.body.newAmount);
        const reason = req.body.reason || '';
        if (isNaN(newAmount) || newAmount <= 0) return res.status(400).json({ error: 'المبلغ غير صالح' });
        
        const tx = await Transaction.findById(txId);
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });
        if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
            return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        }

        const oldAmountEGP = tx.amount;
        const adminName = req.session.adminName || 'الإدارة';

        if (tx.status === 'deposit' || tx.status === 'deduction') {
            const diffAmount = newAmount - oldAmountEGP;
            const diffDeposit = (tx.status === 'deposit') ? diffAmount : -diffAmount;
            if (tx.userId === 'admin' && tx.executorGroupId) {
                const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل المبلغ من ${oldAmountEGP} إلى ${newAmount} بواسطة: ${adminName}${reason ? ' | السبب: ' + reason : ''}]`;
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, notes: newNotes } }, { timestamps: false });
                await syncBotBalance(tx.executorGroupId);
                if (tx.managerGroupId) await syncBotBalance(tx.managerGroupId);
            } else {
                if (tx.companyId) {
                    const comp = await ClientCompany.findById(tx.companyId);
                    if (comp) { comp.balance += diffDeposit; await comp.save(); }
                } else if (tx.userId) {
                    const user = await User.findOne({ phone: tx.userId });
                    if (user) { user.balance += diffDeposit; await user.save(); }
                }
                const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل المبلغ من ${oldAmountEGP} إلى ${newAmount} بواسطة: ${adminName}${reason ? ' | السبب: ' + reason : ''}]`;
                await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, notes: newNotes } }, { timestamps: false });
            }
        } else {
            const oldCostLYD = tx.costLYD || 0;
            const currentRate = tx.exchangeRate || (oldCostLYD > 0 ? (oldAmountEGP / oldCostLYD) : 1);
            const newCostLYD = parseFloat((newAmount / currentRate).toFixed(3));
            const diffEGP = newAmount - oldAmountEGP;
            const diffLYD = newCostLYD - oldCostLYD;

            if (tx.companyId) {
                const comp = await ClientCompany.findById(tx.companyId);
                if (comp) { comp.balance -= diffLYD; await comp.save(); }
            } else if (tx.userId) {
                const user = await User.findOne({ phone: tx.userId });
                if (user) { user.balance -= diffLYD; await user.save(); }
            }

            if (tx.status === 'completed' && tx.executorGroupId) {
                const execGroup = await ExecutorGroup.findById(tx.executorGroupId);
                if (execGroup) { execGroup.balance -= diffEGP; await execGroup.save(); }
                if (tx.managerGroupId) {
                    const mgrGroup = await ExecutorGroup.findById(tx.managerGroupId);
                    if (mgrGroup) { mgrGroup.balance -= diffEGP; await mgrGroup.save(); }
                }
            }

            const newNotes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل المبلغ من ${oldAmountEGP} EGP إلى ${newAmount} EGP بواسطة: ${adminName}${reason ? ' | السبب: ' + reason : ''}]`;
            await Transaction.updateOne({ _id: tx._id }, { $set: { amount: newAmount, costLYD: newCostLYD, notes: newNotes } }, { timestamps: false });
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/edit-rate', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const newRate = parseFloat(req.body.newRate);
        const reason = req.body.reason || '';
        if (isNaN(newRate) || newRate <= 0) return res.status(400).json({ error: 'سعر الصرف غير صالح' });

        const tx = await Transaction.findById(txId);
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });
        if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
            return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        }

        const oldCost = tx.costLYD || 0;
        const newCost = tx.amount / newRate;
        const diff = newCost - oldCost;

        if (tx.companyId) {
            const company = await ClientCompany.findById(tx.companyId);
            if (company) { company.balance -= diff; await company.save(); }
        } else if (tx.userId) {
            const user = await User.findOne({ phone: tx.userId });
            if (user) { user.balance -= diff; await user.save(); }
        }

        const adminName = req.session.adminName || 'الإدارة';
        const oldRate = oldCost > 0 ? (tx.amount / oldCost).toFixed(3) : (tx.exchangeRate || 0).toString();
        tx.costLYD = newCost;
        tx.exchangeRate = newRate;
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم تعديل السعر من ${oldRate} إلى ${newRate} بواسطة: ${adminName}${reason ? ' | السبب: ' + reason : ''}]`;
        await tx.save();

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'خطأ داخلي: ' + error.message });
    }
});

router.post('/api/complaints/:id/upload-proof', requireAuth, async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'الصورة مطلوبة' });

        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });

        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        
        const fileName = `complaint_${Date.now()}_${Math.round(Math.random()*1000)}.jpg`;
        fs.writeFileSync(path.join(proofsDir, fileName), buffer);

        tx.proofImage = fileName;
        if (!tx.proofImages) tx.proofImages = [];
        tx.proofImages.push(fileName);
        
        const adminName = req.session.adminName || 'الإدارة';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم إرفاق إثبات جديد بواسطة: ${adminName}]`;
        await tx.save();

        res.json({ success: true, imageUrl: `/proxy/image/${tx._id}/${tx.proofImages.length - 1}` });
    } catch (e) {
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/resolve', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });

        const tx = await Transaction.findById(txId);
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });

        const adminName = req.session.adminName || 'الإدارة';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم حل الشكوى بواسطة: ${adminName} | السبب: ${reason}]`;
        
        // Unset complaint fields
        tx.complaintText = undefined;
        tx.emergencyAlert = undefined;
        await tx.save();

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/cancel', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });

        const tx = await Transaction.findById(txId);
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });

        if (tx.status === 'completed' || tx.status === 'processing' || tx.status === 'accepted' || tx.status === 'pending') {
            if (tx.companyId) {
                await ClientCompany.findByIdAndUpdate(tx.companyId, { $inc: { balance: tx.costLYD || 0 } });
            } else if (tx.userId) {
                await User.findOneAndUpdate({ phone: tx.userId }, { $inc: { balance: tx.costLYD || 0 } });
            }
        }
        const groupId = tx.executorGroupId;
        const managerGroupId = tx.managerGroupId;

        tx.status = 'cancelled_by_admin';
        const adminName = req.session.adminName || 'الإدارة';
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم إلغاء العملية لحل الشكوى بواسطة ${adminName} | السبب: ${reason}]`;
        
        tx.complaintText = undefined;
        tx.emergencyAlert = undefined;
        tx.updatedAt = new Date();
        await tx.save();

        if (groupId) await syncBotBalance(groupId);
        if (managerGroupId) await syncBotBalance(managerGroupId);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

module.exports = router;
