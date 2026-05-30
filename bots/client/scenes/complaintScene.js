// bots/client/scenes/complaintScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const mongoose = require('mongoose'); // 🟢 تمت إضافة Mongoose لتفادي خطأ الـ ID
const Transaction = require('../../../models/Transaction');
const ExecutorBot = require('../../../models/ExecutorBot');
const Admin = require('../../../models/Admin');

const complaintWizard = new Scenes.WizardScene(
    'COMPLAINT_SCENE',
    // 1️⃣ الخطوة الأولى: عرض آخر 10 عمليات
    async (ctx) => {
        // تصفير عدادات الأخطاء
        ctx.wizard.state.searchAttempts = 0;
        ctx.wizard.state.reasonAttempts = 0;

        const telegramId = ctx.from.id.toString();
        const txs = await Transaction.find({ userId: telegramId, status: 'completed' }).sort({ updatedAt: -1 }).limit(10);
        
        if (txs.length === 0) {
            await ctx.reply('❌ لا توجد عمليات مكتملة لتقديم شكوى عليها حالياً.');
            return ctx.scene.leave();
        }

        let msg = '📑 <b>آخر عمليات تحويل خاصة بك:</b>\n\nاختر العملية التي تريد تقديم شكوى بخصوصها:';
        const buttons = txs.map(t => [Markup.button.callback(`📞 ${t.vodafoneNumber} | 💵 ${t.amount} EGP`, `selectTx_${t._id}`)]);
        
        buttons.push([Markup.button.callback('🔍 البحث برقم الحوالة', 'search_tx')]);
        buttons.push([Markup.button.callback('🔙 رجوع', 'cancel_complaint')]);

        await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        return ctx.wizard.next();
    },
    // 2️⃣ الخطوة الثانية: معالجة الاختيار أو طلب رقم الحوالة
    async (ctx) => {
        const action = ctx.callbackQuery?.data;
        if (action === 'cancel_complaint') { await ctx.editMessageText('✅ تم الإلغاء.'); return ctx.scene.leave(); }
        
        if (action === 'search_tx') {
            await ctx.editMessageText('🔎 من فضلك أرسل رقم الحوالة (رقم الطلب) المطلوب البحث عنه:');
            return ctx.wizard.next();
        }

        if (action && action.startsWith('selectTx_')) {
            ctx.wizard.state.txId = action.split('_')[1];
            return proceedToReason(ctx);
        }
    },
    // 3️⃣ الخطوة الثالثة: البحث عن الحوالة بالرقم مع عداد المحاولات 🟢
    async (ctx) => {
        try {
            ctx.wizard.state.searchAttempts = ctx.wizard.state.searchAttempts || 0;
            const searchId = ctx.message?.text?.trim();

            if (!searchId) {
                ctx.wizard.state.searchAttempts += 1;
                if (ctx.wizard.state.searchAttempts >= 2) {
                    await ctx.reply('❌ لقد قمت بإدخال بيانات غير صالحة مرتين متتاليتين.\nتم إلغاء العملية لحماية النظام.');
                    return ctx.scene.leave();
                }
                await ctx.reply('⚠️ <b>يرجى إرسال رقم الحوالة كنص صحيح (تتبقى لك محاولة واحدة):</b>', { parse_mode: 'HTML' });
                return;
            }

            // فلترة ذكية لتجنب انهيار قاعدة البيانات
            let queryOptions = [];
            queryOptions.push({ customId: searchId }); 

            if (mongoose.Types.ObjectId.isValid(searchId)) {
                queryOptions.push({ _id: searchId });
            }

            const tx = await Transaction.findOne({ 
                $or: queryOptions, 
                userId: ctx.from.id.toString(),
                status: 'completed'
            });
            
            if (!tx) {
                ctx.wizard.state.searchAttempts += 1;
                if (ctx.wizard.state.searchAttempts >= 2) {
                    await ctx.reply('❌ فشل العثور على الحوالة للمرة الثانية.\nتم إلغاء العملية، يرجى مراجعة رقم الطلب والمحاولة لاحقاً من القائمة الرئيسية.');
                    return ctx.scene.leave();
                }
                await ctx.reply('❌ <b>لم يتم العثور على حوالة مكتملة بهذا الرقم!</b>\nتأكد من الرقم وأعد المحاولة <b>(تتبقى لك محاولة واحدة)</b>:', { parse_mode: 'HTML' });
                return;
            }
            
            ctx.wizard.state.searchAttempts = 0; // تصفير العداد لنجاح الخطوة
            ctx.wizard.state.txId = tx._id;
            return proceedToReason(ctx);
        } catch (error) {
            console.error('Search TX Error:', error);
            ctx.reply('❌ حدث خطأ داخلي، يرجى المحاولة لاحقاً.');
            return ctx.scene.leave();
        }
    },
    // 4️⃣ الخطوة الرابعة: اختيار سبب الشكوى
    async (ctx) => {
        const action = ctx.callbackQuery?.data;
        if (action === 'reason_3') {
            await ctx.editMessageText('📝 من فضلك اكتب تفاصيل الشكوى بوضوح في رسالة واحدة:');
            return ctx.wizard.next();
        }
        
        const reasons = { 'reason_1': 'صورة التحويل غير مطابقة', 'reason_2': 'القيمة لم تصل كاملة' };
        ctx.wizard.state.complaintReason = reasons[action];
        return sendComplaintToAdmin(ctx);
    },
    // 5️⃣ الخطوة الخامسة: استقبال السبب اليدوي مع عداد المحاولات 🟢
    async (ctx) => {
        ctx.wizard.state.reasonAttempts = ctx.wizard.state.reasonAttempts || 0;

        if (!ctx.message?.text) {
            ctx.wizard.state.reasonAttempts += 1;
            if (ctx.wizard.state.reasonAttempts >= 2) {
                await ctx.reply('❌ لقد قمت بإدخال بيانات غير صالحة مرتين متتاليتين.\nتم إلغاء العملية لحماية النظام.');
                return ctx.scene.leave();
            }
            await ctx.reply('❌ <b>يرجى كتابة الشكوى في رسالة نصية (تتبقى لك محاولة واحدة):</b>', { parse_mode: 'HTML' });
            return;
        }

        ctx.wizard.state.reasonAttempts = 0; // تصفير العداد
        ctx.wizard.state.complaintReason = ctx.message.text;
        return sendComplaintToAdmin(ctx);
    }
);

// =====================================
// 🛠 دوال مساعدة
// =====================================

const proceedToReason = async (ctx) => {
    await ctx.reply('❓ <b>ما هو سبب الشكوى؟</b>', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('1️⃣ صورة التحويل غير مطابقة', 'reason_1')],
            [Markup.button.callback('2️⃣ القيمة لم تصل كاملة', 'reason_2')],
            [Markup.button.callback('3️⃣ سبب آخر (كتابة يدوية)', 'reason_3')]
        ])
    });
    ctx.wizard.selectStep(3);
};

// 🚀 إرسال الشكوى لجميع المديرين
const sendComplaintToAdmin = async (ctx) => {
    try {
        await ctx.reply('⏳ جاري إرسال الشكوى للإدارة، يرجى الانتظار ثوانٍ...');

        const tx = await Transaction.findById(ctx.wizard.state.txId);
        
        tx.complaintText = ctx.wizard.state.complaintReason;
        await tx.save();

        const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

        const msg = `🚨 <b>شكوى جديدة من عميل!</b>\n\n` +
                    `👤 <b>المرسل:</b> ${tx.employeeName || 'غير محدد'}\n` +
                    `📞 <b>المحفظة:</b> <code>${tx.vodafoneNumber}</code>\n` +
                    `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                    `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                    `⚠️ <b>السبب:</b> ${tx.complaintText}\n` +
                    `👨‍💻 <b>الأيدي للمنفذ:</b> <code>${tx.operatorId || 'غير معروف'}</code>`;

        const keyboardMarkup = Markup.inlineKeyboard([
            [Markup.button.callback('🤖 تحويل للمنفذ', `compFwd_${tx._id}`)],
            [Markup.button.callback('✅ تم حل المشكلة', `compSolved_${tx._id}`)],
            [Markup.button.callback('❌ إلغاء وخصم القيمة', `compCancel_${tx._id}`)]
        ]);

        let photoBuffer = null;
        if (tx.proofImage && tx.executorBotId) {
            try {
                const execBotDoc = await ExecutorBot.findById(tx.executorBotId);
                if (execBotDoc) {
                    const execAPI = new Telegram(execBotDoc.token);
                    const fileLink = await execAPI.getFileLink(tx.proofImage);
                    const response = await fetch(fileLink.href);
                    const arrayBuffer = await response.arrayBuffer();
                    photoBuffer = Buffer.from(arrayBuffer);
                }
            } catch (fetchErr) { console.error('Failed to fetch image buffer:', fetchErr.message); }
        }

        const allAdmins = await Admin.find({});
        const adminIds = new Set(allAdmins.map(a => a.telegramId));
        if (process.env.ADMIN_TELEGRAM_ID) adminIds.add(process.env.ADMIN_TELEGRAM_ID);

        const sendPromises = Array.from(adminIds).map(targetAdminId => {
            if (photoBuffer) {
                return adminBotAPI.sendPhoto(targetAdminId, { source: photoBuffer }, { caption: msg, parse_mode: 'HTML', ...keyboardMarkup });
            } else {
                return adminBotAPI.sendMessage(targetAdminId, msg + '\n\n⚠️ *(تعذر جلب صورة الإثبات تلقائياً)*', { parse_mode: 'HTML', ...keyboardMarkup });
            }
        });

        await Promise.all(sendPromises);
        await ctx.reply('✅ تم إرسال شكواك للإدارة بنجاح مع كافة التفاصيل والصور.\nسيتم مراجعتها واتخاذ الإجراء اللازم فوراً.');

    } catch (error) {
        console.error('Complaint Error:', error);
        await ctx.reply('❌ حدث خطأ داخلي أثناء معالجة الشكوى.');
    }
    return ctx.scene.leave();
};

module.exports = complaintWizard;