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
const ClientServiceRequest = require('../models/ClientServiceRequest');
const RegistrationRequest = require('../models/RegistrationRequest');
const { requireAuth } = require('../middlewares/auth');
const { syncBotBalance } = require('../utils/helpers');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const { reversalService } = require('../src/Application/Services/ReversalService');
const { repriceTransaction, editTransactionAmount } = require('../services/adminFinancialMutationService');
const {
    listDashboardEntities,
    loadDashboardIntelligence,
    loadEntityMovementReport
} = require('../services/dashboardIntelligenceService');
const { adminVisibleTransactionQuery } = require('../services/adminAccountVisibilityService');
const { adminAccountScope, tenantScope } = require('../utils/tenantScope');
const {
    requireAdminActor,
    isAdminActorError,
    cancellationFields,
    ACTOR_MESSAGE,
    auditAdminAction
} = require('../utils/adminActor');

const appendAdminNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

router.get(['/proxy/image/:id', '/proxy/image/:id/:index'], requireAuth, async (req, res) => {
    try {
        const tx = await Transaction.findOne(adminVisibleTransactionQuery(tenantScope(req), { _id: req.params.id }));
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
        const scopedTenant = tenantScope(req);
        const accountScope = adminAccountScope(req);
        const [
            usersCount,
            companiesCount,
            executorsCount,
            pendingTxs,
            processingTxs,
            completedTxs,
            intelligence
        ] = await Promise.all([
            User.countDocuments(accountScope),
            ClientCompany.countDocuments(accountScope),
            Employee.countDocuments(accountScope),
            Transaction.countDocuments(adminVisibleTransactionQuery(scopedTenant, { status: 'pending' })),
            Transaction.countDocuments(adminVisibleTransactionQuery(scopedTenant, { status: { $in: ['processing', 'accepted'] } })),
            Transaction.countDocuments(adminVisibleTransactionQuery(scopedTenant, { status: 'completed' })),
            loadDashboardIntelligence(new Date(), { tenantId: req.tenantId })
        ]);

        res.render('index', { 
            usersCount, companiesCount, executorsCount, pendingTxs, processingTxs, completedTxs, adminName: req.session.adminName,
            todayCompleted: intelligence.todayStatus.completed,
            todayPending: intelligence.todayStatus.pending,
            todayProcessing: intelligence.todayStatus.processing,
            todayCancelled: intelligence.todayStatus.cancelled,
            todayTotal: Object.values(intelligence.todayStatus).reduce((sum, value) => sum + value, 0),
            todayEGP: intelligence.metrics.today.amountEGP,
            todayLYD: intelligence.metrics.today.costLYD,
            intelligence,
            intelligenceJson: JSON.stringify(intelligence).replace(/</g, '\\u003c')
        });
    } catch (e) { console.error('Dashboard Error:', e); res.status(500).send('خطأ داخلي'); }
});

router.get('/api/dashboard/intelligence', requireAuth, async (req, res) => {
    try {
        return res.json({ success: true, data: await loadDashboardIntelligence(new Date(), { tenantId: req.tenantId }) });
    } catch (error) {
        console.error('[Dashboard] intelligence refresh failed:', error.message);
        return res.status(500).json({ success: false, error: 'تعذر تحديث تحليلات لوحة القيادة.' });
    }
});

router.get('/api/dashboard/entities', requireAuth, async (req, res) => {
    try {
        const entities = await listDashboardEntities({ type: req.query.type, search: req.query.search, limit: req.query.limit, tenantId: req.tenantId });
        return res.json({ success: true, entities });
    } catch (error) {
        const status = error.message === 'INVALID_ENTITY_TYPE' ? 422 : 500;
        return res.status(status).json({ success: false, error: status === 422 ? 'نوع الحساب غير صالح.' : 'تعذر تحميل الحسابات.' });
    }
});

router.get('/api/dashboard/entity-report', requireAuth, async (req, res) => {
    try {
        const report = await loadEntityMovementReport({ type: req.query.type, id: req.query.id, days: req.query.days, tenantId: req.tenantId });
        return res.json({ success: true, report });
    } catch (error) {
        const inputErrors = ['INVALID_ENTITY_SCOPE', 'REPORT_ENTITY_NOT_FOUND', 'INVALID_REPORT_SCOPE'];
        const status = inputErrors.includes(error.message) ? 422 : 500;
        return res.status(status).json({ success: false, error: status === 422 ? 'تعذر العثور على الحساب المطلوب.' : 'تعذر إعداد تقرير الحركة.' });
    }
});

router.get('/api/sidebar-stats', requireAuth, async (req, res) => {
    try {
        const scopedTenant = tenantScope(req);
        const [complaintsCount, regRequestsCount, supportCount, pendingCount] = await Promise.all([
            Transaction.countDocuments(adminVisibleTransactionQuery(scopedTenant, {
                $or: [
                    { complaintText: { $exists: true, $ne: '' } },
                    { emergencyAlert: { $exists: true, $ne: '' } }
                ]
            })),
            RegistrationRequest.countDocuments({ status: 'pending' }),
            SupportTicket.countDocuments({ unreadAdmin: { $gt: 0 } }),
            Transaction.countDocuments(adminVisibleTransactionQuery(scopedTenant, { status: 'pending' }))
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
        const complaints = await Transaction.find(adminVisibleTransactionQuery(tenantScope(req), {
            $or: [
                { complaintText: { $exists: true, $ne: '' } },
                { emergencyAlert: { $exists: true, $ne: '' } }
            ]
        })).sort({ updatedAt: -1, createdAt: -1 });
        res.render('complaints', { complaints, adminName: req.session.adminName });
    } catch (e) { res.status(500).send('خطأ داخلي'); }
});

router.post('/api/resolve-complaint', requireAuth, async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!transactionId) return res.status(400).json({ error: 'معرف العملية مطلوب' });
        await Transaction.findOneAndUpdate(adminVisibleTransactionQuery(tenantScope(req), { _id: transactionId }), {
            $unset: { complaintText: "", emergencyAlert: "" }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'خطأ داخلي' }); }
});

router.post('/api/complaints/:id/edit-amount', requireAuth, async (req, res) => {
    try {
        const actor = requireAdminActor(req);
        const txId = req.params.id;
        const newAmount = parseFloat(req.body.newAmount);
        const reason = req.body.reason || '';
        if (isNaN(newAmount) || newAmount <= 0) return res.status(400).json({ error: 'المبلغ غير صالح' });
        if (!await Transaction.exists(adminVisibleTransactionQuery(tenantScope(req), { _id: txId }))) return res.status(404).json({ error: 'العملية غير موجودة' });
        
        const result = await editTransactionAmount({
            transactionId: txId,
            newAmount,
            adminName: actor.name,
            noteDetail: reason
        });
        for (const groupId of result.syncGroupIds) await syncBotBalance(groupId);
        await auditAdminAction(req, actor, {
            action: 'TRANSACTION_DATA_EDITED',
            targetId: txId,
            newData: { amount: newAmount },
            metadata: { reason }
        });

        res.json({ success: true });
    } catch (e) {
        if (isAdminActorError(e)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        if (e.message === 'TRANSACTION_NOT_FOUND') return res.status(404).json({ error: 'العملية غير موجودة' });
        if (e.message === 'TRANSACTION_NOT_EDITABLE') return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        if (e.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') return res.status(503).json({ error: 'تعذر تأكيد التعديل المالي حالياً. حاول لاحقاً.' });
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/edit-rate', requireAuth, async (req, res) => {
    try {
        const actor = requireAdminActor(req);
        const newRate = parseFloat(req.body.newRate);
        const reason = req.body.reason || '';
        if (isNaN(newRate) || newRate <= 0) return res.status(400).json({ error: 'سعر الصرف غير صالح' });
        if (!await Transaction.exists(adminVisibleTransactionQuery(tenantScope(req), { _id: req.params.id }))) return res.status(404).json({ error: 'العملية غير موجودة' });
        await repriceTransaction({
            transactionId: req.params.id,
            newRate,
            adminName: actor.name,
            noteDetail: reason
        });
        await auditAdminAction(req, actor, {
            action: 'TRANSACTION_RATE_EDITED',
            targetId: req.params.id,
            newData: { exchangeRate: newRate },
            metadata: { reason }
        });
        res.json({ success: true });
    } catch (error) {
        if (isAdminActorError(error)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        if (error.message === 'TRANSACTION_NOT_FOUND') return res.status(404).json({ error: 'العملية غير موجودة' });
        if (error.message === 'TRANSACTION_NOT_EDITABLE') return res.status(400).json({ error: 'لا يمكن تعديل عملية ملغاة' });
        if (error.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') return res.status(503).json({ error: 'تعذر تأكيد التعديل المالي حالياً. حاول لاحقاً.' });
        res.status(500).json({ error: 'خطأ داخلي: ' + error.message });
    }
});

router.get('/api/client-service-requests', requireAuth, async (_req, res) => {
    const requests = await ClientServiceRequest.find({}).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, requests });
});

router.post('/api/client-service-requests/:id/review', requireAuth, async (req, res) => {
    let actor;
    try {
        actor = requireAdminActor(req);
    } catch (error) {
        if (isAdminActorError(error)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        throw error;
    }
    const decision = String(req.body?.decision || '');
    if (!['approved', 'rejected'].includes(decision)) return res.status(422).json({ success: false, error: 'INVALID_DECISION' });
    const request = await ClientServiceRequest.findOneAndUpdate(
        { _id: req.params.id, status: 'pending_admin' },
        { $set: { status: decision, adminNote: String(req.body?.note || '').slice(0, 1000), reviewedById: actor.id, reviewedByName: actor.name, reviewedAt: actor.at }, $push: { audit: { action: decision, actorId: actor.id, actorName: actor.name, note: String(req.body?.note || '').slice(0, 1000) } } },
        { returnDocument: 'after' }
    );
    if (!request) return res.status(404).json({ success: false, error: 'REQUEST_NOT_FOUND_OR_REVIEWED' });
    return res.json({ success: true, request });
});

router.post('/api/complaints/:id/upload-proof', requireAuth, async (req, res) => {
    try {
        const actor = requireAdminActor(req);
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'الصورة مطلوبة' });

        const tx = await Transaction.findOne(adminVisibleTransactionQuery(tenantScope(req), { _id: req.params.id }));
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
        
        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم إرفاق إثبات جديد بواسطة: ${actor.name}]`);
        await tx.save();

        res.json({ success: true, imageUrl: `/proxy/image/${tx._id}/${tx.proofImages.length - 1}` });
    } catch (e) {
        if (isAdminActorError(e)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/resolve', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });

        const actor = requireAdminActor(req);
        const tx = await Transaction.findOne(adminVisibleTransactionQuery(tenantScope(req), { _id: txId }));
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });

        tx.adminNotes = appendAdminNoteText(tx.adminNotes, `[تم حل الشكوى بواسطة: ${actor.name} | السبب: ${reason}]`);
        
        // Unset complaint fields
        tx.complaintText = undefined;
        tx.emergencyAlert = undefined;
        await tx.save();

        res.json({ success: true });
    } catch (e) {
        if (isAdminActorError(e)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

router.post('/api/complaints/:id/cancel', requireAuth, async (req, res) => {
    try {
        const txId = req.params.id;
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ error: 'السبب مطلوب' });

        const actor = requireAdminActor(req);
        const tx = await Transaction.findOne(adminVisibleTransactionQuery(tenantScope(req), { _id: txId }));
        if (tx) {
            const groupId = tx.executorGroupId;
            const managerGroupId = tx.managerGroupId;
            const result = await reversalService.reverseTransaction(txId, reason, actor.name, { status: 'cancelled_by_admin' });

            if (!result.success) {
                return res.status(400).json({ error: result.message });
            }

            await Transaction.updateOne(
                { _id: tx._id, ...tenantScope(req) },
                { $unset: { complaintText: '', emergencyAlert: '' }, $set: { updatedAt: new Date(), ...cancellationFields(actor) } },
                { timestamps: false }
            );
            await auditAdminAction(req, actor, {
                action: 'TRANSACTION_CANCELLED_BY_ADMIN',
                targetId: tx._id,
                newData: { status: 'cancelled_by_admin', cancelledBy: actor.name },
                metadata: { reason, cancellationNumber: result.cancellationNumber }
            });

            if (groupId) await syncBotBalance(groupId);
            if (managerGroupId) await syncBotBalance(managerGroupId);

            return res.json({ success: true, cancellationNumber: result.cancellationNumber });
        }
        if (!tx) return res.status(404).json({ error: 'العملية غير موجودة' });
    } catch (e) {
        if (isAdminActorError(e)) return res.status(401).json({ success: false, error: ACTOR_MESSAGE });
        res.status(500).json({ error: 'خطأ داخلي: ' + e.message });
    }
});

module.exports = router;
