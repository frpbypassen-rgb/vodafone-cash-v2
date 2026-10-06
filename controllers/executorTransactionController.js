'use strict';

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Admin = require('../models/Admin');
const { acceptExecutorTask, executorRequestTenantScope, routingErrorMessage } = require('../services/executorTaskRoutingService');
const { editExecutorAmount, cancelExecutorTask, returnExecutorTask } = require('../services/executorTransactionMutationService');
const { completeExecutorTask } = require('../services/executorCompletionService');
const { executeExecutorProviderTask } = require('../services/executorProviderExecutionService');
const { notifyExecutorCancellation } = require('../services/executorCancellationNotificationService');
const { ExecutorTransactionError, logExecutorFailure } = require('../services/executorTransactionError');
const { MAX_PROOF_IMAGES } = require('../services/executorProofStorageService');

const objectIdString = (value) => String(value?._id || value || '');

const loadOwnedExecutorTransaction = async (req, res) => {
    const tx = await Transaction.findById(req.params.id);
    if (!tx) {
        res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        return null;
    }
    const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
    if (!emp) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return null;
    }
    if (!req.executorEmployee) req.executorEmployee = emp;
    const employeeGroupId = objectIdString(emp.groupId);
    const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
    const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
    if (!ownsExecutorTask && !ownsManagerTask) {
        res.status(403).json({ success: false, error: 'Forbidden' });
        return null;
    }
    return tx;
};

const canAnnotateExecutorTask = (emp, tx) => {
    if (!emp || emp.role === 'accountant') return false;
    if (emp.role === 'manager') return true;
    const self = objectIdString(emp._id);
    return objectIdString(tx.operatorId) === self || objectIdString(tx.assignedExecutorId) === self;
};

const canRetryPartProof = (emp, tx) => {
    if (!emp || emp.role === 'accountant') return false;
    if (emp.role === 'manager') return true;
    const self = objectIdString(emp._id);
    const operatorId = objectIdString(tx.operatorId);
    const assignedId = objectIdString(tx.assignedExecutorId);
    if (!operatorId && !assignedId) return true;
    return operatorId === self || assignedId === self;
};

const rejectUnlessAllowed = (allowed, res) => {
    if (allowed) return false;
    res.status(403).json({ success: false, error: 'Forbidden' });
    return true;
};

const rejectUnownedAnnotation = (req, res, tx) =>
    rejectUnlessAllowed(canAnnotateExecutorTask(req.executorEmployee, tx), res);

const MAX_VOICE_NOTE_LENGTH = 2000000;
const VOICE_NOTE_PATTERN = /^data:audio\/(?:mpeg|mp3|wav|webm|ogg|mp4|x-m4a|aac)(?:;[\w=.-]+)*;base64,[A-Za-z0-9+/]+={0,2}$/;

const respondToError = (operation, error, res, fallback, defaultStatus = 500) => {
    let status = defaultStatus;
    let message = fallback;
    let code;
    if (error instanceof ExecutorTransactionError) {
        status = error.statusCode;
        message = error.message;
        code = error.code;
    } else if (error?.code === 'FINANCIAL_TRANSACTIONS_UNAVAILABLE') {
        status = 503;
        message = 'FINANCIAL_TRANSACTIONS_UNAVAILABLE';
        code = error.code;
    } else if (operation === 'completion') {
        const proofErrors = {
            TOO_MANY_PROOFS: [400, `الحد الأقصى ${MAX_PROOF_IMAGES} صور.`],
            INVALID_PROOF_IMAGE: [400, 'صيغة صورة الإثبات غير صالحة أو حجمها كبير.'],
            AUTO_RECEIPT_GENERATION_FAILED: [500, 'تعذر توليد الإيصال التلقائي، يرجى إعادة المحاولة.']
        };
        if (Object.hasOwn(proofErrors, error?.message)) {
            [status, message] = proofErrors[error.message];
        } else if (String(error?.code || '').startsWith('MANUAL_RECEIPT_')) {
            message = 'تعذر إنشاء المرجع التسلسلي للإيصال.';
        } else if (String(error?.message || '').includes('LOCK')) {
            status = 409;
            message = 'العملية قيد المعالجة حالياً.';
        }
    }
    if (!(error instanceof ExecutorTransactionError)) logExecutorFailure(operation, error);
    const payload = { success: false, error: message };
    if (code) payload.code = code;
    return res.status(status).json(payload);
};

exports.postRequestDeposit = async (req, res) => {
    try {
        const { amount } = req.body;
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.json({ success: false, error: 'مبلغ غير صالح' });
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        const tx = await Transaction.create({
            userId: 'admin',
            executorGroupId: emp.groupId._id,
            operatorId: emp._id.toString(),
            amount: parsedAmount,
            costLYD: 0,
            vodafoneNumber: 'طلب إيداع',
            status: 'deposit_pending',
            customId: 'DEPREQ-' + Date.now().toString().slice(-6),
            companyName: 'طلب إيداع من منفذ',
            employeeName: emp.name,
            executorName: emp.name
        });

        const Notification = require('../models/Notification');
        const admins = await Admin.find({});
        const msgText = '📥 طلب إيداع نقدية جديد!\n👤 المنفذ: ' + emp.name + '\n🤖 البوت: ' + emp.groupId.name + '\n💵 المبلغ المطلوب: ' + parsedAmount + ' EGP\n🧾 رقم: ' + tx.customId + '\n\nيمكنك الرد من لوحة تحكم الموقع.';
        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'طلب إيداع نقدية جديد',
                message: msgText,
                type: 'deposit_pending'
            }).catch((error) => logExecutorFailure('deposit-notification', error));
        }
        res.json({ success: true });
    } catch (error) {
        return respondToError('deposit-request', error, res, 'تعذر إنشاء طلب الإيداع.', 200);
    }
};

exports.postAcceptTask = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp || !emp.groupId) return res.status(401).json({ success: false, error: 'حساب المنفذ غير صالح.' });
        const result = await acceptExecutorTask({
            transactionId: req.params.id,
            executor: emp,
            tenantId: executorRequestTenantScope(req)
        });
        if (!result.ok) {
            const conflictCodes = new Set([
                'ACTIVE_TASK_EXISTS',
                'TASK_UNAVAILABLE',
                'TASK_NOT_FOUND',
                'TASK_TENANT_MISMATCH',
                'TASK_GROUP_MISMATCH',
                'TASK_TAKEN',
                'TASK_ASSIGNED_TO_OTHER',
                'TASK_STATE_CHANGED'
            ]);
            const status = conflictCodes.has(result.code) ? 409 : 400;
            const message = result.acceptedByName
                ? `${routingErrorMessage(result.code)} (${result.acceptedByName})`
                : result.assignedExecutorName
                ? `${routingErrorMessage(result.code)} (${result.assignedExecutorName})`
                : routingErrorMessage(result.code);
            return res.status(status).json({ success: false, code: result.code, error: message });
        }
        return res.json({ success: true, replayed: result.replayed === true });
    } catch (error) {
        return respondToError('accept', error, res, 'تعذر سحب العملية.');
    }
};

exports.postEditAmount = async (req, res) => {
    try {
        const newAmount = await editExecutorAmount({
            transactionId: req.params.id,
            executorId: req.session.executorId,
            newAmount: req.body.newAmount,
            reason: req.body.reason
        });
        return res.json({ success: true, newAmount });
    } catch (error) {
        return respondToError('edit-amount', error, res, 'تعذر تعديل مبلغ العملية.');
    }
};

exports.postCancelTask = async (req, res) => {
    try {
        const result = await cancelExecutorTask({
            transactionId: req.params.id,
            executorId: req.session.executorId,
            reason: req.body?.reason
        });
        if (!result) return res.json({ success: false, error: 'العملية غير صالحة' });
        await notifyExecutorCancellation(result).catch((error) => logExecutorFailure('cancellation-notification', error));
        return res.json({ success: true });
    } catch (error) {
        return respondToError('cancel', error, res, 'تعذر إلغاء العملية.');
    }
};

exports.postReturnTask = async (req, res) => {
    try {
        const returned = await returnExecutorTask({
            transactionId: req.params.id,
            executorId: req.session.executorId,
            reason: req.body.reason
        });
        return res.json(returned ? { success: true } : { success: false, error: 'العملية غير صالحة' });
    } catch (error) {
        return respondToError('return', error, res, 'تعذر إرجاع العملية.', 200);
    }
};

exports.postCompleteTask = async (req, res) => {
    try {
        const { bankTransfer } = await completeExecutorTask({
            transactionId: req.params.id,
            executorId: req.session.executorId,
            executor: req.executorEmployee,
            body: req.body,
            auditRequest: req
        });
        return res.json({
            success: true,
            message: bankTransfer
                ? 'تم إنهاء التحويل البنكي وإرسال إثبات التحويل للعميل.'
                : 'تم إنهاء العملية وحفظ الإيصال بنجاح.'
        });
    } catch (error) {
        return respondToError('completion', error, res, 'تعذر إنهاء العملية.');
    }
};

exports.executeViaZaynPay = async (req, res) => {
    try {
        const result = await executeExecutorProviderTask({
            transactionId: req.params.id,
            executorId: req.session.executorId,
            tenantId: executorRequestTenantScope(req)
        });
        return res.json({ success: true, ...result });
    } catch (error) {
        return respondToError('provider', error, res, 'تعذر تنفيذ العملية لدى مزود الدفع.');
    }
};

exports.postRetryPartProof = async (req, res) => {
    try {
        const tx = await loadOwnedExecutorTransaction(req, res);
        if (!tx || rejectUnlessAllowed(canRetryPartProof(req.executorEmployee, tx), res)) return;

        const { retrySplitPartProof } = require('../services/splitPartProofService');
        const result = await retrySplitPartProof(tx._id, req.params.partId);
        return res.status(result.ok ? 200 : 409).json({
            success: Boolean(result.ok),
            code: result.code,
            partId: result.partId,
            proofStatus: result.proofStatus || null,
            duplicate: Boolean(result.duplicate)
        });
    } catch (error) {
        logExecutorFailure('retry-part-proof', error);
        return res.status(500).json({ success: false, error: 'تعذر إعادة إرسال إثبات الجزء.' });
    }
};

exports.postRateExecutor = async (req, res) => {
    try {
        const tx = await loadOwnedExecutorTransaction(req, res);
        if (!tx || rejectUnownedAnnotation(req, res, tx)) return;
        const { rating, note } = req.body;
        if (!Number.isFinite(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) {
            return res.status(400).json({ success: false, error: 'التقييم يجب أن يكون بين 1 و 5.' });
        }
        tx.executorRating = Number(rating);
        tx.executorRatingNote = String(note || '').trim() || null;
        tx.executorRatedAt = new Date();
        await tx.save();
        return res.json({ success: true, rating: tx.executorRating });
    } catch (error) {
        logExecutorFailure('task-annotation', error);
        return res.status(500).json({ success: false, error: 'تعذر حفظ التقييم.' });
    }
};

exports.postVoiceNote = async (req, res) => {
    try {
        const tx = await loadOwnedExecutorTransaction(req, res);
        if (!tx || rejectUnownedAnnotation(req, res, tx)) return;
        const { base64 } = req.body;
        if (typeof base64 !== 'string' || base64.length > MAX_VOICE_NOTE_LENGTH || !VOICE_NOTE_PATTERN.test(base64)) {
            return res.status(400).json({ success: false, error: 'ملاحظة صوتية غير صالحة.' });
        }
        tx.voiceNote = String(base64);
        await tx.save();
        return res.json({ success: true });
    } catch (error) {
        logExecutorFailure('voice-note', error);
        return res.status(500).json({ success: false, error: 'تعذر حفظ الملاحظة الصوتية.' });
    }
};

const supportController = require('./executorSupportController');
exports.getSupport = supportController.getSupport;
exports.getSupportMessages = supportController.getSupportMessages;
exports.postSupportMessages = supportController.postSupportMessages;
