const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const ClientBot = require('../../../models/ClientBot');
const Notification = require('../../../models/Notification'); 

const editPrompt = async (ctx, text, markup = {}) => {
    try {
        if (ctx.wizard.state.promptMsgId) {
            await ctx.telegram.editMessageText(ctx.chat.id, ctx.wizard.state.promptMsgId, null, text, { parse_mode: 'HTML', ...markup });
        } else {
            const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
            ctx.wizard.state.promptMsgId = sent.message_id;
        }
    } catch (e) {
        const sent = await ctx.reply(text, { parse_mode: 'HTML', ...markup });
        ctx.wizard.state.promptMsgId = sent.message_id;
    }
};

const provideSenderPhoneWizard = new Scenes.WizardScene(
    'PROVIDE_SENDER_PHONE_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        ctx.wizard.state.promptMsgId = ctx.scene.state.promptMsgId;
        await editPrompt(ctx, '📱 <b>إرفاق رقم منفذ الحوالة</b>\n\nالرجاء كتابة رقم فودافون كاش الذي قمت بتحويل هذا الطلب منه:', Markup.inlineKeyboard([[Markup.button.callback('❌ التراجع والتجاهل', 'cancel_prov')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_prov') { 
            await editPrompt(ctx, '❌ تم تجاهل طلب إرفاق الرقم.', {}); 
            return ctx.scene.leave(); 
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            const phone = ctx.message.text?.trim();
            if (!phone) {
                await editPrompt(ctx, '⚠️ <b>الرجاء إرسال الرقم كنص:</b>', Markup.inlineKeyboard([[Markup.button.callback('❌ التراجع', 'cancel_prov')]]));
                return;
            }

            await editPrompt(ctx, '⏳ <i>جاري إرسال الرقم...</i>');

            const tx = await Transaction.findById(ctx.wizard.state.txId);
            if (!tx) return ctx.scene.leave();
            tx.executorSenderPhone = phone;

            let clientAPI;
            if (tx.clientBotId) {
                const comp = await ClientBot.findById(tx.clientBotId);
                if (comp) clientAPI = new Telegram(comp.token);
            }
            if (!clientAPI) clientAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);

            const clientMsg = `✅ <b>تم الرد على طلبك!</b>\n\nتم تحويل مبلغ ${tx.amount} EGP للرقم <code>${tx.vodafoneNumber}</code>\n📱 <b>تم التحويل من الرقم:</b> <code>${phone}</code>\n🧾 رقم الطلب: <code>${tx.customId || tx._id}</code>`;
            try { await clientAPI.sendMessage(tx.userId, clientMsg, { parse_mode: 'HTML' }); } catch (e) {}

            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            if (tx.phoneReqAdminMessages && tx.phoneReqAdminMessages.length > 0) {
                for (const msg of tx.phoneReqAdminMessages) {
                    await adminAPI.deleteMessage(msg.telegramId, msg.messageId).catch(()=>{});
                }
                tx.phoneReqAdminMessages = [];
            }

            const adminNewMsg = `📱 <b>تم إرفاق رقم منفذ الحوالة!</b>\n\n🧾 <b>الطلب:</b> <code>${tx.customId || tx._id}</code>\n👨‍💻 <b>الموظف:</b> ${tx.executorName}\n📱 <b>تم التنفيذ من:</b> <code>${phone}</code>`;
            const Admin = require('../../../models/Admin');
            const allAdmins = await Admin.find({});
            for (const admin of allAdmins) {
                await adminAPI.sendMessage(admin.telegramId, adminNewMsg, { parse_mode: 'HTML' }).catch(()=>{});
            }
            await tx.save();

            await Notification.create({
                title: 'إرفاق رقم منفذ حوالة',
                message: `الموظف ${tx.executorName} أرفق الرقم ${phone} للطلب ${tx.customId || tx._id}`,
                txId: tx._id.toString()
            });

            await editPrompt(ctx, `✅ <b>تم إرسال الرقم ${phone} للعميل وللإدارة بنجاح.</b>`, {});
            return ctx.scene.leave();
        }
    }
);
module.exports = provideSenderPhoneWizard;