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
const { reversalService } = require('../src/Application/Services/ReversalService');
const { repriceTransaction, editTransactionAmount } = require('../services/adminFinancialMutationService');

const appendAdminNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireAuth, async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).send('لا توجد صورة إثبات');

        const index = req.params.index ? parseInt(req.params.index) : 0;
        const officialReceipt = String(
            tx.proofImage
            || (Array.isArray(tx.proofImages) ? tx.proofImages[0] : '')
            || ''
        ).trim();
        const adminProofs = [
            ...(officialReceipt ? [officialReceipt] : []),
            ...(Array.isArray(tx.executorProofImages) ? tx.executorProofImages : [])
        ].filter(Boolean);
        const photoId = adminProofs[index];

        if (!photoId) return res.status(404).send('لا توجد صورة إثبات');

        await streamProofImage(proofSourceUrl(photoId), res);
        return;
    } catch (error) { res.status(500).send('خطأ داخلي'); }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        // --- إحصائيات اليوم المخصصة للهاتف المحمول ---
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const todayQuery = { createdAt: { $gte: startOfDay, $lte: endOfDay } };

        const [
            usersCount,
            companiesCount,
            executorsCount,
            pendingTxs,
            processingTxs,
            completedTxs,
            todayCompleted,
            todayPending,
            todayProcessing,
            todayCancelled,
            todayTotal,
            sums
        ] = await Promise.all([
            User.countDocuments(),
            ClientCompany.countDocuments(),
            Employee.countDocuments(),
            Transaction.countDocuments({ status: 'pending' }),
            Transaction.countDocuments({ status: { $in: ['processing', 'accepted'] } }),
            Transaction.countDocuments({ status: 'completed' }),
            Transaction.countDocuments({ ...todayQuery, status: 'completed' }),
            Transaction.countDocuments({ ...todayQuery, status: 'pending' }),
            Transaction.countDocuments({ ...todayQuery, status: { $in: ['processing', 'accepted'] } }),
            Transaction.countDocuments({ ...todayQuery, status: { $in: ['rejected', 'cancelled_by_admin'] } }),
            Transaction.countDocuments(todayQuery),
            Transaction.aggregate([
                { $match: { ...todayQuery, status: 'completed' } },
                { $group: { _id: null, totalEGP: { $sum: '$amount' }, totalLYD: { $sum: '$costLYD' } } }
            ])
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
        const [complaintsCount, regRequestsCount, supportCount, pendingCount] = await Promise.all([
            Transaction.countDocuments({
                $or: [
                    { complaintText: { $exists: true, $ne: '' } },
                    { emergencyAlert: { $exists: true, $ne: '' } }
                ]
            }),
            RegistrationRequest.countDocuments({ status: 'pending' }),
            SupportTicket.countDocuments({ unreadAdmin: { $gt: 0 } }),
            Transaction.countDocuments({ status: 'pending' })
        ]);
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
    try {
        const unreadFilter = {
            isRead: false,
            $or: [
                { audience: { $in: ['admin', 'all'] } },
                { audience: { $exists: false } }
            ]
        };
        const [count, notifications] = await Promise.all([
            Notification.countDocuments(unreadFilter),
            Notification.find(unreadFilter).sort({ createdAt: -1 }).limit(50).lean()
        ]);
        res.json({ count, notifications });
    } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    try { await Notification.findByIdAndUpdate(req.params.id, { isRead: true }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: true }); }
});

router.post('/api/notifications/read-all', requireAuth, async (req, res) => {
    try {
        await Notification.updateMany({
            isRead: false,
            $or: [
                { audience: { $in: ['admin', 'all'] } },
                { audience: { $exists: false } }
            ]
        }, { isRead: true });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: true }); }
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
        
        const result = await editTransactionAmount({
            transactionId: txId,
            newAmount,
            adminName: req.session.adminName || 'الإدارة',
            noteDetail: reason
        });
        for (const groupId of result.syncGroupIds) await syncBotBalance(groupId);

        res.json({ success: true });
    } catch (e) {
        if (e.message === 'TRANSACTION_NOT_FOUND') return res.status(404).json({ error: 'العملية غير موجودة' });
        if (e.message === 'TRANSACTION_NOT_EDITABLE') return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        if (e.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') return res.status(503).json({ error: 'تعذر تأكيد التعديل المالي حالياً. حاول لاحقاً.' });
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/edit-rate', requireAuth, async (req, res) => {
    try {
        const newRate = parseFloat(req.body.newRate);
        const reason = req.body.reason || '';
        if (isNaN(newRate) || newRate <= 0) return res.status(400).json({ error: 'سعر الصرف غير صالح' });
        await repriceTransaction({
            transactionId: req.params.id,
            newRate,
            adminName: req.session.adminName || 'الإدارة',
            noteDetail: reason
        });
        res.json({ success: true });
    } catch (error) {
        if (error.message === 'TRANSACTION_NOT_FOUND') return res.status(404).json({ error: 'العملية غير موجودة' });
        if (error.message === 'TRANSACTION_NOT_EDITABLE') return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') return res.status(503).json({ error: 'تعذر تأكيد التعديل المالي حالياً. حاول لاحقاً.' });
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
        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم إرفاق إثبات جديد بواسطة: ${adminName}]`);
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
        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم حل الشكوى بواسطة: ${adminName} | السبب: ${reason}]`);
        
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
        if (tx) {
            const groupId = tx.executorGroupId;
            const managerGroupId = tx.managerGroupId;
            const adminName = req.session.adminName || 'الإدارة';
            const result = await reversalService.reverseTransaction(txId, reason, adminName, { status: 'cancelled_by_admin' });

            if (!result.success) {
                return res.status(400).json({ error: result.message });
            }

            await Transaction.updateOne(
                { _id: tx._id },
                { $unset: { complaintText: '', emergencyAlert: '' }, $set: { updatedAt: new Date() } },
                { timestamps: false }
            );

            if (groupId) await syncBotBalance(groupId);
            if (managerGroupId) await syncBotBalance(managerGroupId);

            return res.json({ success: true, cancellationNumber: result.cancellationNumber });
        }
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });
    } catch (e) {
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

module.exports = router;
