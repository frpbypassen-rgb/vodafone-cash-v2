// bots/executor/scenes/resolveComplaintScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const Admin = require('../../../models/Admin');
const Employee = require('../../../models/Employee');

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

const resolveComplaintWizard = new Scenes.WizardScene(
    'RESOLVE_COMPLAINT_SCENE',
    // الخطوة 1
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        ctx.wizard.state.type = ctx.scene.state.type;
        const typeNames = { 'Solved': '✅ تم حل الشكوى', 'Tech': '🛠 مشكلة فنية', 'Return': '🔙 إرجاع للإدارة' };
        ctx.wizard.state.typeName = typeNames[ctx.wizard.state.type];

        await ctx.reply(`📝 <b>توضيح حل الشكوى: [ ${ctx.wizard.state.typeName} ]</b>\n\nمن فضلك اكتب "ملاحظة" تشرح فيها للإدارة كيف تم التعامل مع المشكلة:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء', 'cancel_resolve')]]) });
        return ctx.wizard.next();
    },
    // الخطوة 2
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_resolve') {
            await ctx.answerCbQuery().catch(() => {});
            await ctx.editMessageText('❌ تم إلغاء الإجراء.');
            return ctx.scene.leave();
        }
        if (!ctx.message?.text || ctx.message.text.length < 3) return ctx.reply('⚠️ يرجى كتابة توضيح بسيط:');
        ctx.wizard.state.resolutionNote = ctx.message.text;

        await ctx.reply(`📸 <b>الآن ارفق صورة إثبات للحل (اختياري):</b>\n\nأرسل صورة الآن، أو اضغط على الزر أدناه للإرسال بملاحظتك فقط:`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📤 إرسال بدون صورة', 'send_note_only')], [Markup.button.callback('🔙 إلغاء', 'cancel_resolve')]]) });
        return ctx.wizard.next();
    },
    // الخطوة 3
    async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
        if (ctx.callbackQuery?.data === 'cancel_resolve') {
            await ctx.editMessageText('❌ تم إلغاء الإجراء.');
            return ctx.scene.leave();
        }

        let photoId = null;
        let photoBuffer = null; // 🚀 هنا يكمن السحر لتخطي قيود تليجرام

        if (ctx.callbackQuery?.data === 'send_note_only') {
            photoId = null;
        } else if (ctx.message?.photo) {
            photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            
            // 🚀 تحويل الصورة إلى Buffer أثناء الطيران (On The Fly)
            try {
                const fileLink = await ctx.telegram.getFileLink(photoId);
                const response = await fetch(fileLink.href);
                photoBuffer = Buffer.from(await response.arrayBuffer());
            } catch (e) { console.error('Buffer fetch error:', e); }
        } else {
            return ctx.reply('⚠️ يرجى إرسال صورة أو الضغط على زر "إرسال بدون صورة":');
        }

        const tx = await Transaction.findById(ctx.wizard.state.txId);
        if (!tx) return ctx.reply('❌ خطأ: الطلب غير موجود.');

        // حفظ الصورة في الداتابيز
        if (photoId) {
            tx.resolutionImage = photoId;
            await tx.save();
        }

        const operator = await Employee.findOne({ telegramId: ctx.from.id.toString() });
        const opName = operator ? operator.name : ctx.from.first_name;

        const adminMsg = `🏁 <b>تقرير حل شكوى من المنفذ</b>\n\n` +
                         `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                         `📞 <b>رقم المحفظة:</b> <code>${tx.vodafoneNumber}</code>\n` +
                         `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                         `👤 <b>الموظف المسؤول:</b> ${opName}\n` +
                         `━━━━━━━━━━━━━━\n` +
                         `📌 <b>الإجراء المتخذ:</b> ${ctx.wizard.state.typeName}\n` +
                         `📝 <b>ملاحظة الموظف:</b>\n<i>"${ctx.wizard.state.resolutionNote}"</i>` +
                         (photoId ? '' : `\n\n⚠️ <i>(تم الإرسال بدون إرفاق صورة جديدة)</i>`);

        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ إغلاق الشكوى نهائياً', `compSolved_${tx._id}`)],
            [Markup.button.callback('❌ إلغاء وخصم القيمة', `compCancel_${tx._id}`)]
        ]);

        try {
            const allAdmins = await Admin.find({});
            const adminIds = new Set(allAdmins.map(a => a.telegramId));
            if (process.env.ADMIN_TELEGRAM_ID) adminIds.add(process.env.ADMIN_TELEGRAM_ID);

            for (const targetAdminId of adminIds) {
                if (photoBuffer) {
                    // 🚀 نستخدم الـ Buffer بدلاً من file_id لإرسالها عبر بوت الإدارة
                    await adminBotAPI.sendPhoto(targetAdminId, { source: photoBuffer }, { caption: adminMsg, parse_mode: 'HTML', ...adminKeyboard }).catch(()=>{});
                } else {
                    await adminBotAPI.sendMessage(targetAdminId, adminMsg, { parse_mode: 'HTML', ...adminKeyboard }).catch(()=>{});
                }
            }
            await ctx.reply(`🚀 تم إرسال تقرير الحل والصورة للإدارة بنجاح.`);
        } catch (err) {
            console.error(err);
            await ctx.reply('❌ حدث خطأ أثناء إرسال الإشعار للإدارة.');
        }
        return ctx.scene.leave();
    }
);
module.exports = resolveComplaintWizard;