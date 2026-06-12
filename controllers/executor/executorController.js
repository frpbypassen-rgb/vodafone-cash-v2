// controllers/executor/executorController.js
// ===============================================
// 👷 Controller — عمليات المنفذين
// ===============================================
'use strict';

const Transaction = require('../../models/Transaction');
const Employee = require('../../models/Employee');
const ExecutorGroup = require('../../models/ExecutorGroup');
const Admin = require('../../models/Admin');
const transferService = require('../../services/transferService');
const { logAction } = require('../../services/auditService');
const { acquireLock, releaseLock } = require('../../services/lockService');

/**
 * GET /executor/live-tasks — المهام المتاحة
 */
const getLiveTasks = async (req, res) => {
    try {
        const { userId, executorGroupId, accountType } = req.user;
        if (accountType !== 'executor') return res.status(403).json({ success: false });

        const tasks = await Transaction.find({
            executorGroupId, status: { $in: ['processing', 'accepted'] }
        }).sort({ createdAt: 1 }).lean();

        const alerts = await Transaction.find({
            executorGroupId,
            emergencyAlert: { $exists: true, $ne: null },
            status: { $in: ['processing', 'accepted'] }
        }).lean();

        res.json({ success: true, tasks, alerts });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
};

/**
 * POST /executor/accept-task/:id — قبول مهمة
 */
const acceptTask = async (req, res) => {
    try {
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') return res.status(403).json({ success: false });

        const emp = await Employee.findOne({ webUsername: userId }).populate('groupId');
        if (!emp) return res.status(404).json({ success: false, code: 'EMPLOYEE_NOT_FOUND', message: 'لم يتم العثور على حساب المنفذ' });

        const tx = await Transaction.findOneAndUpdate(
            { _id: req.params.id, status: 'processing' },
            { $set: { status: 'accepted', operatorId: emp._id.toString(), executorName: emp.name, emergencyAlert: undefined } },
            { new: true }
        );

        if (!tx) return res.json({ success: false, code: 'ALREADY_TAKEN', message: 'عذراً، تم سحب الطلب من قِبل زميل آخر' });

        // 🟢 الإشعارات ستتم عبر Socket.IO بدلاً من التيليجرام

        // Audit Log
        await logAction({
            action: 'TASK_ACCEPTED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            metadata: { customId: tx.customId, amount: tx.amount }
        });

        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
};

/**
 * POST /executor/cancel-task/:id — إلغاء مهمة
 */
const cancelTask = async (req, res) => {
    try {
        const { reason } = req.body;
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') return res.status(403).json({ success: false, code: 'FORBIDDEN' });

        const result = await transferService.cancelTransfer({
            taskId: req.params.id,
            userId,
            reason,
            req
        });
        return res.status(result.statusCode).json(result);
    } catch (e) {
        res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'فشل الإلغاء' });
    }
};

/**
 * POST /executor/complete-task/:id — إتمام مهمة
 */
const completeTask = async (req, res) => {
    const lockKey = `tx:${req.params.id}`;
    let lock;
    try {
        lock = await acquireLock(lockKey, 10000);
    } catch (lockError) {
        return res.status(429).json({ success: false, message: 'العملية قيد المعالجة حالياً' });
    }

    try {
        const { imageBase64, senderPhone } = req.body;
        const { userId, accountType } = req.user;
        if (accountType !== 'executor') {
            await releaseLock(lock);
            return res.status(403).json({ success: false });
        }
        if (!imageBase64) {
            await releaseLock(lock);
            return res.json({ success: false, message: 'يرجى إرفاق صورة الإثبات' });
        }

        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findOne({ webUsername: userId }).populate('groupId');

        if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
            await releaseLock(lock);
            return res.json({ success: false, message: 'الطلب غير متاح للإنهاء' });
        }

        // خصم العهدة
        if (emp.groupId.parentGroupId) {
            await ExecutorGroup.findByIdAndUpdate(emp.groupId.parentGroupId, { $inc: { balance: -tx.amount } });
        }
        await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });

        // إرسال الإثبات
        const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        
        // 🟢 إشعارات الإدارة ستتم عبر Socket.IO بدلاً من التيليجرام
        // حفظ الصورة في قاعدة البيانات (في النسخة الحقيقية قد تحفظها في Cloud Storage)
        let savedFileId = `proof_${Date.now()}.jpg`; 
        
        tx.status = 'completed';
        tx.proofImage = savedFileId;
        if (senderPhone) tx.executorSenderPhone = senderPhone;
        await tx.save();

        // Audit Log
        await logAction({
            action: 'TRANSFER_COMPLETED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            oldData: { status: 'accepted' },
            newData: { status: 'completed', proofImage: savedFileId, senderPhone: senderPhone || null },
            metadata: { customId: tx.customId, amount: tx.amount, transferType: tx.transferType }
        });

        // نشر حدث إتمام التحويل بنجاح لفك الاقتران والتشغيل الخلفي
        const eventBus = require('../../services/eventBus');
        eventBus.publish('transfer:completed', { tx, emp });

        await releaseLock(lock);
        res.json({ success: true, message: 'تم إرسال الإثبات بنجاح' });
    } catch (e) {
        await releaseLock(lock);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
    }
};

module.exports = { getLiveTasks, acceptTask, cancelTask, completeTask };
