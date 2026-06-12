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
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
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
        const emp = await Employee.findById(req.session.executorId).populate('groupId');
        const operatorIdentifier = emp._id.toString();
        const groupId = emp.groupId && (emp.groupId._id || emp.groupId);
        if (!groupId) return res.json({ success: false, error: 'Ø§Ù„Ù…Ù†ÙØ° ØºÙŠØ± Ù…Ø±Ø¨ÙˆØ· Ø¨Ù…Ø¬Ù…ÙˆØ¹Ø© ØµØ§Ù„Ø­Ø©' });

        const tx = await Transaction.findOneAndUpdate(
            {
                _id: req.params.id,
                status: 'processing',
                $or: [{ executorGroupId: groupId }, { managerGroupId: groupId }]
            },
            { $set: { status: 'accepted', operatorId: operatorIdentifier, executorName: emp.name, emergencyAlert: undefined } },
            { new: true }
        );

        if (!tx) return res.json({ success: false, error: 'تم قبول الطلب مسبقاً من زميل آخر أو لم يعد متاحاً' });
        res.json({ success: true });
    } catch(e) { res.json({ success: false, error: e.message }); }
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
        const actualRate = tx.exchangeRate || (oldAmount / oldCost);
        const newCost = parseFloat((parsedAmount / actualRate).toFixed(3));
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
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تعديل المبلغ من ${oldAmount} إلى ${parsedAmount} | السبب: ${reason}]`;
        await tx.save();
        res.json({ success: true, newAmount: parsedAmount });
    } catch(e) { res.json({ success: false, error: e.message }); }
};

exports.postCancelTask = async (req, res) => {
    try {
        const { reason } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId);

        if (tx && tx.status === 'accepted' && tx.operatorId === emp._id.toString()) {
            if (tx.companyId) await ClientCompany.findByIdAndUpdate(tx.companyId, { $inc: { balance: tx.costLYD } });
            else if (tx.userId) await User.findOneAndUpdate({ $or: [{ phone: tx.userId }, { webUsername: tx.userId }] }, { $inc: { balance: tx.costLYD } });

            tx.status = 'rejected';
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم الإلغاء | المنفذ: ${emp.name} | السبب: ${reason}]`;
            await tx.save();

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
            tx.executorName = undefined; tx.operatorId = undefined; tx.broadcastMessages = [];
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[إرجاع للإدارة | السبب: ${reason}]`;
            await tx.save();
            return res.json({ success: true });
        }
        res.json({ success: false, error: 'العملية غير صالحة' });
    } catch (e) { res.json({ success: false, error: e.message }); }
};

exports.postCompleteTask = async (req, res) => {
    try {
        const { imageBase64, imagesBase64, senderPhone } = req.body;
        const tx = await Transaction.findById(req.params.id);
        const emp = await Employee.findById(req.session.executorId).populate('groupId');

        if (!tx) return res.json({ success: false, error: 'الطلب غير موجود' });

        let imagesArray = [];
        if (imagesBase64 && Array.isArray(imagesBase64) && imagesBase64.length > 0) {
            imagesArray = imagesBase64;
        } else if (imageBase64) {
            imagesArray = [imageBase64]; 
        }

        if (imagesArray.length === 0) {
            let maskedPhone = senderPhone ? senderPhone.trim() : '';
            if (maskedPhone.length === 11) {
                maskedPhone = maskedPhone.substring(0, 4) + '****' + maskedPhone.substring(8);
            } else if (maskedPhone.length > 0 && maskedPhone.length <= 4) {
                maskedPhone = '01******' + maskedPhone;
            } else if (maskedPhone.length > 4) {
                const firstPart = Math.floor(maskedPhone.length / 3);
                const lastPart = Math.floor(maskedPhone.length / 3);
                const middlePart = maskedPhone.length - firstPart - lastPart;
                maskedPhone = maskedPhone.substring(0, firstPart) + '*'.repeat(middlePart) + maskedPhone.substring(maskedPhone.length - lastPart);
            } else {
                maskedPhone = '---';
            }

            const { generateReceiptBase64 } = require('../utils/receiptGenerator');
            const receiptBase64 = await generateReceiptBase64({
                amount: tx.amount,
                walletNumber: tx.vodafoneNumber || tx.accountNumber || '---',
                senderPhone: maskedPhone,
                customId: tx.customId || tx._id.toString().slice(-6),
                accountName: tx.companyName || tx.employeeName || 'غير محدد',
                date: new Date().toLocaleDateString('en-GB')
            });
            imagesArray = [receiptBase64];
        }

        if (emp.groupId.parentBotId) { await ExecutorGroup.findByIdAndUpdate(emp.groupId.parentBotId, { $inc: { balance: -tx.amount } }); }
        await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });

        let typeLabel = 'فودافون كاش';
        if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
        if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

        let senderPhoneDisplay = '';
        if (senderPhone && senderPhone.trim() !== '') {
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[رقم المحول: ${senderPhone.trim()}]`;
            senderPhoneDisplay = `\n📞 <b>رقم المُرسل:</b> <code>${senderPhone.trim()}</code>`;
        }

        let clientNoteDisplay = tx.notes ? `\n📝 <b>ملاحظة:</b> ${tx.notes}` : '';
        let accDetails = `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n`;
        if (tx.accountName) accDetails += `👤 <b>الاسم:</b> ${tx.accountName}\n`;

        const clientMsg = `✅ <b>تـم تـنـفـيـذ طـلـبـك بـنـجـاح! (${typeLabel})</b> 🎉\n\n` +
                          `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` + accDetails +
                          `💵 <b>المبلغ:</b> ${tx.amount} EGP\n💸 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD` + senderPhoneDisplay + clientNoteDisplay + `\n\n👇 <b>إثبات التحويل:</b>`;

        const sourceInfo = tx.companyId ? `🏢 <b>الشركة:</b> ${tx.companyName}\n👤 <b>الموظف المحول:</b> ${tx.employeeName}` : `👤 <b>العميل الفردي:</b> ${tx.employeeName}`;
        const adminMsgCaption = `✅ <b>تم تنفيذ طلب تحويل (${typeLabel}) بنجاح!</b>\n\n${sourceInfo}\n━━━━━━━━━━━━━━\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n${accDetails}💵 <b>المبلغ:</b> ${tx.amount} EGP\n🇱🇾 <b>التكلفة:</b> ${tx.costLYD.toFixed(2)} LYD\n👨‍💻 <b>المنفذ:</b> ${emp.name}\n🤖 <b>البوت:</b> ${emp.groupId.name}${senderPhoneDisplay}${clientNoteDisplay}`;

        const buffers = imagesArray.slice(0, 10).map(base64 => Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), 'base64'));
        const localFileNames = [];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        for (let i = 0; i < buffers.length; i++) {
            const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
            const suffix = buffers.length > 1 ? `_${i}` : '';
            const fileName = `${safeId}${suffix}.jpg`;
            fs.writeFileSync(path.join(proofsDir, fileName), buffers[i]);
            localFileNames.push(fileName);
        }

        const mediaGroupClient = buffers.map((buf, index) => ({ type: 'photo', media: { source: buf }, caption: index === 0 ? clientMsg : undefined, parse_mode: 'HTML' }));
        const mediaGroupAdmin = buffers.map((buf, index) => ({ type: 'photo', media: { source: buf }, caption: index === 0 ? adminMsgCaption : undefined, parse_mode: 'HTML' }));

        // WhatsApp notification removed
        const clientFileIds = [];

        tx.status = 'completed'; 
        if (typeof localFileNames !== 'undefined' && localFileNames.length > 0) { tx.proofImage = localFileNames[0]; tx.proofImages = localFileNames; } 
        else if (clientFileIds && clientFileIds.length > 0) { tx.proofImage = clientFileIds[0]; tx.proofImages = clientFileIds; }
        tx.updatedAt = new Date();

        const execTime = new Date().toLocaleString('en-GB');
        const completionMsg = `✅ <b>تـم الـتـنـفـيـذ بـنـجـاح</b>\n\n🧾 <b>الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n💵 <b>المبلغ:</b> ${tx.amount} EGP\n👨‍💻 <b>المنفذ:</b> ${tx.executorName}${senderPhoneDisplay}\n⏱️ <b>الوقت:</b> ${execTime}`;

        // Telegram broadcast and admin messages removed
        tx.broadcastMessages = [];
        tx.adminMessages = [];

        await tx.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
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

        // 3. Success - Mark completed and generate receipt
        const { generateReceiptBase64 } = require('../utils/receiptGenerator');
        
        // Use masked phone for receipt
        let maskedPhone = walletNumber.trim();
        if (maskedPhone.length === 11) {
            maskedPhone = maskedPhone.substring(0, 4) + '****' + maskedPhone.substring(8);
        } else if (maskedPhone.length > 0 && maskedPhone.length <= 4) {
            maskedPhone = '01******' + maskedPhone;
        } else if (maskedPhone.length > 4) {
            const firstPart = Math.floor(maskedPhone.length / 3);
            const lastPart = Math.floor(maskedPhone.length / 3);
            const middlePart = maskedPhone.length - firstPart - lastPart;
            maskedPhone = maskedPhone.substring(0, firstPart) + '*'.repeat(middlePart) + maskedPhone.substring(maskedPhone.length - lastPart);
        } else {
            maskedPhone = '---';
        }

        const receiptBase64 = await generateReceiptBase64({
            amount: tx.amount,
            walletNumber: walletNumber,
            senderPhone: maskedPhone,
            customId: tx.customId || tx._id.toString().slice(-6),
            accountName: tx.companyName || tx.employeeName || 'غير محدد',
            date: new Date().toLocaleDateString('en-GB')
        });

        const buffers = [Buffer.from(receiptBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64')];
        const localFileNames = [];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        
        const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
        const fileName = `${safeId}_zaynpay.jpg`;
        fs.writeFileSync(path.join(proofsDir, fileName), buffers[0]);
        localFileNames.push(fileName);

        if (emp.groupId.parentBotId) { await ExecutorGroup.findByIdAndUpdate(emp.groupId.parentBotId, { $inc: { balance: -tx.amount } }); }
        await ExecutorGroup.findByIdAndUpdate(emp.groupId._id, { $inc: { balance: -tx.amount } });

        tx.status = 'completed'; 
        tx.proofImage = localFileNames[0]; 
        tx.proofImages = localFileNames;
        tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[ZaynPay Auto-Executed | Ref: ${paymentRes.refNumber} | TxNo: ${paymentRes.transactionNumber}]`;
        tx.completedAt = new Date();
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
