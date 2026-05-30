// bots/client/scenes/requestSenderPhoneScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const Admin = require('../../../models/Admin');
const ExecutorBot = require('../../../models/ExecutorBot');

const requestSenderPhoneWizard = new Scenes.WizardScene(
    'REQUEST_SENDER_PHONE_SCENE',
    async (ctx) => {
        const telegramId = ctx.from.id.toString();
        const txs = await Transaction.find({ userId: telegramId, status: 'completed' }).sort({ updatedAt: -1 }).limit(10);
        if (txs.length === 0) {
            await ctx.reply('❌ لا توجد عمليات مكتملة لطلب رقم المنفذ لها.');
            return ctx.scene.leave();
        }
        let msg = '📞 <b>طلب رقم منفذ الحوالة</b>\n\nاختر العملية التي تريد معرفة الرقم الذي تم التحويل منه:';
        const buttons = txs.map(t => [Markup.button.callback(`💵 ${t.amount} EGP | 📞 ${t.vodafoneNumber}`, `reqPhoneTx_${t._id}`)]);
        buttons.push([Markup.button.callback('🔙 رجوع', 'cancel_req')]);
        await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        return ctx.wizard.next();
    },
    async (ctx) => {
        const action = ctx.callbackQuery?.data;
        if (action === 'cancel_req') { await ctx.editMessageText('✅ تم الإلغاء.'); return ctx.scene.leave(); }
        if (action && action.startsWith('reqPhoneTx_')) {
            const txId = action.split('_')[1];
            const tx = await Transaction.findById(txId);
            if (!tx) return ctx.scene.leave();

            await ctx.editMessageText('⏳ جاري إرسال الطلب للإدارة والموظف المنفذ...');

            // 1. الإرسال لجروب/بوت الإدارة وحفظ الرسالة
            const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            const adminMsgText = `📞 <b>طلب رقم منفذ الحوالة!</b>\n\nالعميل يطلب معرفة الرقم الذي تم تحويل العملية منه.\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>المحول إليه:</b> <code>${tx.vodafoneNumber}</code>\n👨‍💻 <b>الموظف المنفذ:</b> ${tx.executorName}\n\n⏳ <i>في انتظار إرفاق الرقم من الموظف...</i>`;
            const allAdmins = await Admin.find({});
            tx.phoneReqAdminMessages = [];
            for (const admin of allAdmins) {
                try {
                    const sent = await adminBotAPI.sendMessage(admin.telegramId, adminMsgText, { parse_mode: 'HTML' });
                    tx.phoneReqAdminMessages.push({ telegramId: admin.telegramId, messageId: sent.message_id });
                } catch (e) {}
            }

            // 2. إرسال الطلب للموظف المنفذ
            if (tx.executorBotId && tx.operatorId) {
                const execBot = await ExecutorBot.findById(tx.executorBotId);
                if (execBot) {
                    const execAPI = new Telegram(execBot.token);
                    const execMsg = `📞 <b>طلب هام من العميل!</b>\n\nالعميل يطلب معرفة <b>رقم فودافون كاش</b> الذي قمت بالتحويل منه للطلب:\n🧾 <code>${tx.customId || tx._id}</code>\n📞 المحول إليه: <code>${tx.vodafoneNumber}</code>\n💵 المبلغ: ${tx.amount} EGP`;
                    try {
                        await execAPI.sendMessage(tx.operatorId, execMsg, {
                            parse_mode: 'HTML',
                            ...Markup.inlineKeyboard([[Markup.button.callback('📱 إرفاق رقم الهاتف', `providePhone_${tx._id}`)]])
                        });
                    } catch (e) {}
                }
            }
            await tx.save();
            await ctx.reply('✅ تم إرسال طلبك. سيصلك إشعار بالرقم فور إرفاقه من الموظف المنفذ.');
            return ctx.scene.leave();
        }
    }
);
module.exports = requestSenderPhoneWizard;