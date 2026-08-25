const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const Admin = require('../models/Admin');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SupportTicket = require('../models/SupportTicket');
const { syncBotBalance } = require('../utils/helpers');
const { logAction } = require('../services/auditService');
const { acquireLock, releaseLock } = require('../services/lockService');
const {
    acceptExecutorTask,
    findOwnedAcceptedExecutorTask,
    routingErrorMessage
} = require('../services/executorTaskRoutingService');
const {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    generateManualExecutorReceiptBase64
} = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('../services/manualExecutorReceiptReferenceService');
const { attachCancellationReceipt } = require('../services/cancellationReceiptService');
const { calculateTransferCostLYD, isSourceToLydRate } = require('../utils/transferPricing');
const {
    ExecutorSenderEntriesError,
    normalizeExecutorSenderEntries
} = require('../utils/executorSenderEntries');
const { readExecutorManualPolicy } = require('../utils/executorManualPolicy');

const MAX_PROOF_IMAGES = 5;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const objectIdString = (value) => String(value?._id || value || '');

const parseProofImage = (value) => {
    const match = String(value || '').match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
    if (!match) throw new Error('INVALID_PROOF_IMAGE');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_PROOF_BYTES) throw new Error('INVALID_PROOF_IMAGE');
    const extension = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    return { buffer, extension };
};

const getProofImages = (body = {}) => {
    const rawImages = Array.isArray(body.imagesBase64) && body.imagesBase64.length
        ? body.imagesBase64
        : (body.imageBase64 ? [body.imageBase64] : []);
    if (rawImages.length === 0) return [];
    if (rawImages.length > MAX_PROOF_IMAGES) throw new Error('TOO_MANY_PROOFS');
    return rawImages.map(parseProofImage);
};

const saveProofBuffer = ({ tx, proofsDir, savedPaths, buffer, extension, suffix = '' }) => {
    const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeId}_${Date.now().toString(36)}${suffix ? `_${suffix}` : ''}.${extension}`;
    const filePath = path.join(proofsDir, fileName);
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
    return fileName;
};

const saveProofImageBase64 = ({ tx, proofsDir, savedPaths, imageBase64, suffix = '' }) => {
    if (!imageBase64) return null;
    const parsed = parseProofImage(imageBase64);
    return saveProofBuffer({
        tx,
        proofsDir,
        savedPaths,
        buffer: parsed.buffer,
        extension: parsed.extension,
        suffix
    });
};

const getTransferServiceLabel = (transferType) => {
    const labels = {
        post_account: 'بريد حساب',
        post_card: 'بريد بطاقة',
        bank_account: 'حساب بنكي',
        bank_transfer: 'تحويل بنكي',
        instapay: 'إنستاباي',
        sefa_niger: 'سيفا النيجر',
        bankak_sudan: 'بنكك السودان'
    };
    return labels[String(transferType || '').trim().toLowerCase()] || 'محافظ كاش';
};

const generateManualExecutorReceiptProof = async ({ tx, executionNumber, executorReference, proofsDir, savedPaths }) => {
    const receiptBase64 = await generateManualExecutorReceiptBase64({
        amount: tx.amount,
        customerPhone: tx.vodafoneNumber || tx.accountNumber || tx.serviceDetails?.clientPhone || '---',
        executionNumber,
        customId: tx.customId || tx._id.toString().slice(-6),
        executorReference,
        serviceName: tx.transferType === 'sefa_niger' ? 'سيفا النيجر' : 'محافظ كاش',
        amountCurrencyLabel: tx.transferType === 'sefa_niger' ? 'سيفا' : 'ج.م',
        transferType: tx.transferType,
        completedAt: tx.completedAt || new Date()
    });
    const imageData = String(receiptBase64 || '').replace(/^data:image\/(?:jpeg|jpg);base64,/i, '');
    const buffer = Buffer.from(imageData, 'base64');
    if (!buffer.length) throw new Error('AUTO_RECEIPT_GENERATION_FAILED');

    const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${safeId}_manual_${Date.now().toString(36)}.jpg`;
    const filePath = path.join(proofsDir, fileName);
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
    return fileName;
};

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const appendAdminNote = (tx, note) => {
    tx.adminNotes = appendNoteText(tx.adminNotes, note);
};

const appendCustomerReference = (tx, label, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return;
    const line = `[${label}: ${cleanValue}]`;
    if (!String(tx.notes || '').includes(line)) {
        tx.notes = appendNoteText(tx.notes, line);
    }
};

const findClientUserForTx = async (tx) => {
    const isCompany = !!tx.companyId;
    if (isCompany) {
        const ClientEmployee = require('../models/ClientEmployee');
        const query = { $or: [] };
        if (tx.userId) {
            query.$or.push({ webUsername: tx.userId });
            query.$or.push({ phone: tx.userId });
            if (mongoose.Types.ObjectId.isValid(tx.userId)) {
                query.$or.push({ _id: tx.userId });
            }
        }
        if (query.$or.length === 0) return null;
        return await ClientEmployee.findOne(query);
    } else {
        const User = require('../models/User');
        const query = { $or: [] };
        if (tx.userId) {
            query.$or.push({ webUsername: tx.userId });
            query.$or.push({ phone: tx.userId });
            if (mongoose.Types.ObjectId.isValid(tx.userId)) {
                query.$or.push({ _id: tx.userId });
            }
        }
        if (query.$or.length === 0) return null;
        return await User.findOne(query);
    }
};

const notifyAdmins = async (msgText) => {
    try {
        const Notification = require('../models/Notification');
        const admins = await Admin.find({});
        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'تنبيه إداري',
                message: msgText.replace(/<[^>]*>?/gm, ''),
                type: 'system_alert'
            }).catch(()=>{});
        }
    } catch(e) {}
};

exports.postRequestDeposit = async (req, res) => {
    try {
        const { amount } = req.body;
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.json({ success: false, error: 'مبلغ غير صالح' });
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        const tx = await Transaction.create({ userId: 'admin', executorGroupId: emp.groupId._id, operatorId: emp._id.toString(), amount: parsedAmount, costLYD: 0, vodafoneNumber: 'طلب إيداع', status: 'deposit_pending', customId: 'DEPREQ-' + Date.now().toString().slice(-6), companyName: 'طلب إيداع من منفذ', employeeName: emp.name, executorName: emp.name });
        
        const Notification = require('../models/Notification');
        const admins = await Admin.find({});
        const msgText = '📥 طلب إيداع نقدية جديد!\n👤 المنفذ: ' + emp.name + '\n🤖 البوت: ' + emp.groupId.name + '\n💵 المبلغ المطلوب: ' + parsedAmount + ' EGP\n🧾 رقم: ' + tx.customId + '\n\nيمكنك الرد من لوحة تحكم الموقع.';
        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'طلب إيداع نقدية جديد',
                message: msgText,
                type: 'deposit_pending'
            }).catch(()=>{});
        }
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postAcceptTask = async (req, res) => {
    try {
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp || !emp.groupId) return res.status(401).json({ success: false, error: 'حساب المنفذ غير صالح.' });
        const result = await acceptExecutorTask({ transactionId: req.params.id, executor: emp });
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
    } catch(e) { return res.status(500).json({ success: false, error: 'تعذر سحب العملية.' }); }
};

exports.postEditAmount = async (req, res) => {
    try {
        const { newAmount, reason } = req.body;
        const emp = await Employee.findById(req.session.executorId);
        const tx = await Transaction.findOne({ _id: req.params.id, status: 'accepted', operatorId: emp._id.toString() });
        if (!tx) return res.json({ success: false, error: 'العملية غير صالحة أو لا تملك صلاحية تعديلها' });

        const parsedAmount = parseFloat(newAmount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) return res.json({ success: false, error: 'مبلغ غير صالح' });

        const oldAmount = tx.amount || 0;
        const oldCost = tx.costLYD || 0;
        const actualRate = tx.exchangeRate || (oldAmount > 0 && oldCost > 0
            ? (isSourceToLydRate(tx.transferType) ? oldCost / oldAmount : oldAmount / oldCost)
            : 0);
        const newCost = calculateTransferCostLYD({
            serviceKey: tx.transferType,
            amount: parsedAmount,
            exchangeRate: actualRate
        });
        if (!actualRate) return res.json({ success: false, error: 'تعذر احتساب سعر الصرف للعملية' });
        const diffCost = newCost - oldCost; 

        if (tx.companyId) {
            const comp = await ClientCompany.findById(tx.companyId);
            if (diffCost > 0) {
                const updated = await ClientCompany.findOneAndUpdate(
                    { _id: tx.companyId, balance: { $gte: diffCost - (comp.creditLimit || 0) } },
                    { $inc: { balance: -diffCost } },
                    { new: true }
                );
                if (!updated) return res.json({ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' });
            } else if (diffCost < 0) {
                await ClientCompany.findByIdAndUpdate(tx.companyId, { $inc: { balance: Math.abs(diffCost) } });
            }
        } else if (tx.userId) {
            const user = await User.findOne({ $or: [{ phone: tx.userId }, { webUsername: tx.userId }] });
            if (user) {
                if (diffCost > 0) {
                    const updated = await User.findOneAndUpdate(
                        { _id: user._id, balance: { $gte: diffCost - (user.creditLimit || 0) } },
                        { $inc: { balance: -diffCost } },
                        { new: true }
                    );
                    if (!updated) return res.json({ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' });
                } else if (diffCost < 0) {
                    await User.updateOne({ _id: user._id }, { $inc: { balance: Math.abs(diffCost) } });
                }
            }
        }

        tx.amount = parsedAmount; tx.costLYD = newCost;
        appendAdminNote(tx, `[تعديل المبلغ من ${oldAmount} إلى ${parsedAmount} | السبب: ${reason}]`);
        await tx.save();
        res.json({ success: true, newAmount: parsedAmount });
    } catch(e) { res.json({ success: false, error: e.message }); }
};

exports.postCancelTask = async (req, res) => {
    try {
        const reason = String(req.body?.reason || '').trim();
        if (!reason) {
            return res.status(400).json({ success: false, error: 'سبب الإلغاء مطلوب.' });
        }
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId);

        if (tx && tx.status === 'accepted' && tx.operatorId === emp._id.toString()) {
            if (tx.companyId) await ClientCompany.findByIdAndUpdate(tx.companyId, { $inc: { balance: tx.costLYD } });
            else if (tx.userId) await User.findOneAndUpdate({ $or: [{ phone: tx.userId }, { webUsername: tx.userId }] }, { $inc: { balance: tx.costLYD } });

            const cancelledAt = new Date();
            tx.status = 'rejected';
            tx.cancellationReason = reason;
            tx.cancelledBy = emp.name || 'المنفذ';
            tx.cancelledAt = cancelledAt;
            appendAdminNote(tx, `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`);
            await tx.save();
            try {
                await attachCancellationReceipt(tx, {
                    reason,
                    performedBy: emp.name || 'المنفذ',
                    cancelledAt
                });
            } catch (receiptError) {
                appendAdminNote(tx, `[تعذر توليد إيصال الإلغاء: ${receiptError.message}]`);
                await tx.save();
            }

            // WhatsApp notification removed

            const adminMsg = `🚨 <b>تنبيه للإدارة: تم إلغاء عملية من قِبل المنفذ!</b>\n\n🏢 <b>الجهة/العميل:</b> ${tx.companyName || 'عميل فردي'}\n👤 <b>الموظف الطالب:</b> ${tx.employeeName || 'غير محدد'}\n🤖 <b>بواسطة المنفذ:</b> ${emp.name}\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة المسترجعة:</b> ${tx.costLYD.toFixed(2)} LYD\n⚠️ <b>سبب الإلغاء:</b> <b>${reason}</b>`;
            notifyAdmins(adminMsg);
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'العملية غير صالحة' });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postReturnTask = async (req, res) => {
    try {
        const { reason } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId);

        if (tx && tx.status === 'accepted' && tx.operatorId === emp._id.toString()) {
            tx.status = 'pending'; tx.executorGroupId = undefined; tx.managerGroupId = undefined;
            tx.executorName = undefined; tx.operatorId = undefined; tx.assignedExecutorId = undefined; tx.assignedExecutorName = undefined; tx.assignedExecutorAt = undefined; tx.broadcastMessages = [];
            appendAdminNote(tx, `[إرجاع للإدارة | السبب: ${reason}]`);
            await tx.save();
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'العملية غير صالحة' });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postCompleteTask = async (req, res) => {
    let lock = null;
    const savedPaths = [];
    let transactionCompleted = false;
    try {
        lock = await acquireLock(`executor-complete:${req.params.id}`, 30000, { retryCount: 1 });
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId).populate('groupId');
        if (!emp || emp.status !== 'active' || !emp.groupId || emp.groupId.status !== 'active') {
            return res.status(401).json({ success: false, error: 'حساب المنفذ غير مفعل.' });
        }

        const manualPolicy = readExecutorManualPolicy(emp.groupId);
        const tx = await findOwnedAcceptedExecutorTask({
            transactionId: req.params.id,
            executor: emp
        });
        if (!tx) {
            return res.status(409).json({ success: false, error: 'العملية غير متاحة للإنهاء أو تم إنهاؤها مسبقاً.' });
        }

        const requestedSenderEntries = Array.isArray(req.body.senderEntries)
            ? req.body.senderEntries.map((entry, index) => ({
                phone: entry?.phone,
                amount: entry?.amount,
                proofImage: entry?.proofImageBase64 || entry?.proofImage || null
            }))
            : null;
        let senderEntries;
        try {
            senderEntries = normalizeExecutorSenderEntries({
                requestedSenderEntries,
                senderPhone: req.body.executionNumber ?? req.body.senderPhone,
                operationAmount: tx.amount,
                group: emp.groupId
            });
        } catch (error) {
            if (error instanceof ExecutorSenderEntriesError) {
                return res.status(error.statusCode).json({ success: false, error: error.message });
            }
            throw error;
        }

        const executionNumber = String(
            req.body.executionNumber
            ?? req.body.senderPhone
            ?? senderEntries[0]?.phone
            ?? ''
        ).trim();
        let maskedExecutionNumber = '';
        try {
            maskedExecutionNumber = maskManualExecutionNumber(executionNumber || senderEntries[0]?.phone || '');
        } catch (error) {
            if (error instanceof ManualExecutionNumberError) {
                return res.status(400).json({ success: false, error: error.message });
            }
            throw error;
        }

        const proofs = getProofImages(req.body);
        if (manualPolicy.proofRequired && proofs.length === 0 && senderEntries.every((entry) => !entry.proofImage)) {
            return res.status(400).json({ success: false, error: 'إرفاق صورة الإثبات إجباري لهذا المنفذ.' });
        }

        const executorReceipt = await reserveManualExecutorReceiptReference({ group: emp.groupId });
        const completedAt = new Date();
        tx.completedAt = completedAt;

        const localFileNames = [];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        localFileNames.push(await generateManualExecutorReceiptProof({
            tx,
            executionNumber: maskedExecutionNumber,
            executorReference: executorReceipt.reference,
            proofsDir,
            savedPaths
        }));

        const persistedSenderEntries = senderEntries.map((entry, index) => {
            const proofImage = saveProofImageBase64({
                tx,
                proofsDir,
                savedPaths,
                imageBase64: entry.proofImage,
                suffix: `sender_${index + 1}`
            });
            return {
                phone: entry.phone,
                amount: entry.amount,
                proofImage
            };
        });

        for (let i = 0; i < proofs.length; i++) {
            localFileNames.push(saveProofBuffer({
                tx,
                proofsDir,
                savedPaths,
                buffer: proofs[i].buffer,
                extension: proofs[i].extension,
                suffix: `${i + 1}`
            }));
        }

        const proofSource = proofs.length || persistedSenderEntries.some((entry) => entry.proofImage)
            ? 'system-generated-with-executor-upload'
            : 'system-generated';
        const systemReceiptId = localFileNames[0];
        const executorProofImages = localFileNames.slice(1);
        appendAdminNote(tx, `[تم توليد إيصال تنفيذ يدوي | مرجع المنفذ: ${executorReceipt.reference}]`);

        tx.status = 'completed';
        tx.proofImage = systemReceiptId;
        tx.proofImages = systemReceiptId ? [systemReceiptId] : [];
        tx.executorProofImages = executorProofImages;
        tx.executorExecutionNumber = executionNumber || senderEntries[0]?.phone || undefined;
        tx.executorSenderPhone = maskedExecutionNumber || undefined;
        tx.executorExecutionNumberMasked = maskedExecutionNumber || undefined;
        tx.executorSenderEntries = persistedSenderEntries;
        tx.manualExecutorReceiptReference = executorReceipt.reference;
        tx.completedAt = completedAt;
        tx.completedBy = emp._id;
        tx.broadcastMessages = [];
        tx.adminMessages = [];
        await tx.save();
        transactionCompleted = true;

        const groupId = emp.groupId._id || emp.groupId;
        const parentGroupId = emp.groupId.parentGroupId || emp.groupId.parentBotId;
        await syncBotBalance(groupId).catch(() => {});
        if (parentGroupId) await syncBotBalance(parentGroupId).catch(() => {});

        await logAction({
            action: 'TRANSFER_COMPLETED',
            req,
            performedById: emp._id,
            performedByModel: 'Employee',
            performedByName: emp.name,
            targetId: tx._id,
            targetModel: 'Transaction',
            oldData: { status: 'accepted' },
            newData: {
                status: 'completed',
                proofCount: tx.proofImages.length,
                executorProofCount: executorProofImages.length,
                proofSource,
                proofRequired: manualPolicy.proofRequired,
                senderEntryCount: persistedSenderEntries.length,
                manualExecutorReceiptReference: executorReceipt.reference,
                executorExecutionNumberMasked: maskedExecutionNumber || null
            },
            metadata: { customId: tx.customId, amount: tx.amount, transferType: tx.transferType }
        }).catch(() => {});

        try {
            require('../services/eventBus').publish('transfer:completed', { tx, emp });
        } catch (_) {}

        return res.json({ success: true, message: 'تم إنهاء العملية وحفظ الإيصال بنجاح.' });
    } catch (e) {
        if (!transactionCompleted) {
            savedPaths.forEach((filePath) => {
                try { fs.unlinkSync(filePath); } catch (_) {}
            });
        }
        if (e.message === 'TOO_MANY_PROOFS') return res.status(400).json({ success: false, error: `الحد الأقصى ${MAX_PROOF_IMAGES} صور.` });
        if (e.message === 'INVALID_PROOF_IMAGE') return res.status(400).json({ success: false, error: 'صيغة صورة الإثبات غير صالحة أو حجمها كبير.' });
        if (e.message === 'AUTO_RECEIPT_GENERATION_FAILED') return res.status(500).json({ success: false, error: 'تعذر توليد الإيصال التلقائي، يرجى إعادة المحاولة.' });
        if (e.code && String(e.code).startsWith('MANUAL_RECEIPT_')) {
            return res.status(500).json({ success: false, error: 'تعذر إنشاء المرجع التسلسلي للإيصال.' });
        }
        if (String(e.message || '').includes('LOCK')) return res.status(409).json({ success: false, error: 'العملية قيد المعالجة حالياً.' });
        console.error('[executor/complete-task] failed:', e.stack || e.message);
        return res.status(500).json({ success: false, error: 'تعذر إنهاء العملية.' });
    } finally {
        await releaseLock(lock);
    }
};

// ===============================================
// الدعم الفني
// ===============================================
exports.getSupport = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        res.render('executor/support', { emp });
    } catch(e) { res.redirect('/executor-portal/dashboard'); }
};

exports.getSupportMessages = async (req, res) => {
    try {
        const emp = await Employee.findById(req.session.executorId);
        let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id }).sort({ createdAt: -1 });
        if (ticket) {
            ticket.unreadUser = 0;
            await ticket.save();
            res.json({ success: true, messages: ticket.messages, status: ticket.status });
        } else {
            res.json({ success: true, messages: [], status: 'closed' });
        }
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postSupportMessages = async (req, res) => {
    try {
        const { text, imageBase64 } = req.body;
        if (!text && !imageBase64) return res.json({ success: false, error: 'الرسالة فارغة' });

        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id, status: { $ne: 'closed' } });

        if (!ticket) {
            ticket = new SupportTicket({ entityType: 'executor', entityId: emp._id, telegramId: emp.phone || emp.webUsername, name: emp.name || 'منفذ', phone: emp.phone || 'غير مسجل', messages: [] });
        }

        const newMsg = { sender: 'user', text: text || '', imageUrl: imageBase64 || '', createdAt: new Date() };
        ticket.messages.push(newMsg);
        ticket.status = 'open';
        ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
        await ticket.save();

        const Notification = require('../models/Notification');
        const admins = await Admin.find({});
        const notifyMsg = `🚨 <b>رسالة دعم فني جديدة (منفذ)!</b>\n\n👤 من: ${emp.name}\n💬 الرسالة: ${text || 'صورة مرفقة'}\n\nيرجى مراجعة لوحة التحكم للرد.`;

        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'رسالة دعم فني جديدة',
                message: notifyMsg.replace(/<[^>]*>?/gm, ''),
                type: 'support_message'
            }).catch(()=>{});
        }

        res.json({ success: true, message: newMsg });
    } catch (e) { res.json({ success: false, error: e.message }); }
};


exports.executeViaZaynPay = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId).populate('groupId');

        if (!emp || emp.webUsername !== 'zaynapi@ahram.com') {
            return res.json({ success: false, error: 'غير مصرح لك باستخدام بوابة ZaynPay' });
        }

        if (!tx) return res.json({ success: false, error: 'الطلب غير موجود' });
        if (tx.status === 'completed') return res.json({ success: false, error: 'الطلب مكتمل مسبقاً' });

        const zaynpay = require('../services/zaynpayApi');
        const walletNumber = tx.vodafoneNumber || tx.accountNumber;
        
        if (!walletNumber) return res.json({ success: false, error: 'رقم المحفظة غير متوفر' });

        // 1. Inquiry
        let paymentBillInfo;
        try {
            paymentBillInfo = await zaynpay.inquiry(walletNumber, tx.amount);
        } catch (err) {
            return res.json({ success: false, error: err.message });
        }

        // 2. Payment
        const paymentRes = await zaynpay.pay(paymentBillInfo, walletNumber, tx.amount);
        
        if (!paymentRes.success) {
            return res.json({ success: false, error: paymentRes.error });
        }

        // 3. Success - use the same system receipt for API and manual executors.
        const completedAt = new Date();
        const apiReference = paymentRes.refNumber || paymentRes.transactionNumber || tx.customId || tx._id.toString();
        const receiptBase64 = await generateManualExecutorReceiptBase64({
            amount: tx.amount,
            customerPhone: walletNumber,
            executionNumber: apiReference,
            executorReference: paymentRes.transactionNumber || apiReference,
            executionReferenceLabel: 'مرجع تنفيذ API',
            executionNumberLabel: 'رقم تنفيذ API',
            customId: tx.customId || tx._id.toString().slice(-6),
            serviceName: 'محافظ كاش',
            completedAt
        });

        const buffers = [Buffer.from(receiptBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64')];
        const localFileNames = [];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        
        const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
        const fileName = `${safeId}_zaynpay.jpg`;
        fs.writeFileSync(path.join(proofsDir, fileName), buffers[0]);
        localFileNames.push(fileName);

        const parentGroupId = emp.groupId.parentGroupId || emp.groupId.parentBotId;
        if (parentGroupId) { await ExecutorGroup.findByIdAndUpdate(parentGroupId, { $inc: { balance: -tx.amount } }); }
        await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });

        tx.status = 'completed'; 
        tx.proofImage = localFileNames[0]; 
        tx.proofImages = localFileNames;
        appendCustomerReference(tx, 'الرقم المرجعي', paymentRes.refNumber);
        appendCustomerReference(tx, 'رقم العملية الخارجي', paymentRes.transactionNumber);
        appendAdminNote(tx, `[ZaynPay Auto-Executed | Ref: ${paymentRes.refNumber} | TxNo: ${paymentRes.transactionNumber}]`);
        tx.completedAt = completedAt;
        tx.completedBy = emp._id;
        tx.executorBotId = emp.groupId.token;
        await tx.save();

        let typeLabel = 'فودافون كاش';
        if (tx.transferType === 'post_account') typeLabel = 'حساب بريد';
        if (tx.transferType === 'post_card') typeLabel = 'بطاقة بريد';
        if (tx.transferType === 'instapay') typeLabel = 'انستاباي';

        let senderPhoneDisplay = `\n📞 <b>رقم المُرسل:</b> <code>${walletNumber}</code>`;
        let clientNoteDisplay = tx.notes ? `\n📝 <b>ملاحظة:</b> ${tx.notes}` : '';
        let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${walletNumber}</code>\n`;
        if (tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

        const clientMsg = `✅ <b>تـم تـنـفـيـذ طـلـبـك بـنـجـاح! (${typeLabel})</b> 🎉\n\n` +
                          `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` + accDetails +
                          `💵 <b>المبلغ:</b> ${tx.amount} EGP\n💸 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD` + senderPhoneDisplay + clientNoteDisplay + `\n\n👇 <b>إثبات التحويل:</b>`;

        const sourceInfo = tx.companyId ? `🏢 <b>الشركة:</b> ${tx.companyName}\n👤 <b>الموظف المحول:</b> ${tx.employeeName}` : `👤 <b>العميل الفردي:</b> ${tx.employeeName}`;
        const adminMsgCaption = `✅ <b>تم تنفيذ طلب تحويل (${typeLabel}) بنجاح (ZaynPay)!</b>\n\n${sourceInfo}\n━━━━━━━━━━━━━━\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD\n👨‍💻 <b>المنفذ:</b> ${emp.name}\n🤖 <b>البوت:</b> ${emp.groupId.name}${senderPhoneDisplay}${clientNoteDisplay}`;

        const mediaGroupClient = [{ type: 'photo', media: { source: buffers[0] }, caption: clientMsg, parse_mode: 'HTML' }];
        const mediaGroupAdmin = [{ type: 'photo', media: { source: buffers[0] }, caption: adminMsgCaption, parse_mode: 'HTML' }];

        // WhatsApp notification removed

        return res.json({ success: true, transactionNumber: paymentRes.transactionNumber });
    } catch (e) {
        console.error('ZaynPay Execute Error:', e);
        res.json({ success: false, error: e.message });
    }
};


exports.postRateExecutor = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const employeeGroupId = objectIdString(emp.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!ownsExecutorTask && !ownsManagerTask) return res.status(403).json({ success: false, error: 'Forbidden' });
        const { rating, note } = req.body;
        if (!Number.isFinite(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) {
            return res.status(400).json({ success: false, error: 'التقييم يجب أن يكون بين 1 و 5.' });
        }
        tx.executorRating = Number(rating);
        tx.executorRatingNote = String(note || '').trim() || null;
        tx.executorRatedAt = new Date();
        await tx.save();
        return res.json({ success: true, rating: tx.executorRating });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: 'تعذر حفظ التقييم.' });
    }
};

exports.postVoiceNote = async (req, res) => {
    try {
        const tx = await Transaction.findById(req.params.id);
        if (!tx) return res.status(404).json({ success: false, error: 'العملية غير موجودة.' });
        const emp = req.executorEmployee || await Employee.findById(req.session.executorId);
        if (!emp) return res.status(401).json({ success: false, error: 'Unauthorized' });
        const employeeGroupId = objectIdString(emp.groupId);
        const ownsExecutorTask = objectIdString(tx.executorGroupId) === employeeGroupId;
        const ownsManagerTask = objectIdString(tx.managerGroupId) === employeeGroupId;
        if (!ownsExecutorTask && !ownsManagerTask) return res.status(403).json({ success: false, error: 'Forbidden' });
        const { base64 } = req.body;
        if (!base64 || !base64.startsWith('data:audio/')) {
            return res.status(400).json({ success: false, error: 'ملاحظة صوتية غير صالحة.' });
        }
        tx.voiceNote = String(base64);
        await tx.save();
        return res.json({ success: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: 'تعذر حفظ الملاحظة الصوتية.' });
    }
};
