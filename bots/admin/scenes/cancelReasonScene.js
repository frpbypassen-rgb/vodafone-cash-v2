// bots/admin/scenes/cancelReasonScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const Transaction = require('../../../models/Transaction');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');
const { updateClientTracking } = require('../../../services/clientTrackingService');

const cancelReasonScene = new Scenes.WizardScene(
    'CANCEL_REASON_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        await ctx.reply(
            '⚠️ <b>إلغاء الطلب من الإدارة</b>\n\n📝 الرجاء كتابة سبب الإلغاء لتحديث لوحة العميل:', 
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_action')]]) }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_action') {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText('✅ تم التراجع عن الإلغاء.');
            return ctx.scene.leave();
        }

        const reason = ctx.message?.text?.trim();
        if (!reason) return ctx.reply('⚠️ يرجى كتابة السبب في رسالة نصية.');

        try {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            if (!tx) {
                await ctx.reply('❌ الطلب غير موجود.');
                return ctx.scene.leave();
            }

            if (tx.clientBotId) {
                await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: tx.costLYD } });
            } else {
                await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: tx.costLYD } });
            }

            tx.status = 'rejected';
            tx.notes = (tx.notes ? tx.notes + '\n' : '') + `[تم الإلغاء من الإدارة | السبب: ${reason}]`;
            await tx.save();

            // 🚀 استدعاء محرك التتبع للإلغاء
            await updateClientTracking(tx._id, 'rejected', reason);

            await ctx.reply(`✅ <b>تم إلغاء الطلب وتحديث لوحة العميل.</b>\n\n📝 السبب الذي سيظهر له: ${reason}`, { parse_mode: 'HTML' });

        } catch (err) {
            console.error(err);
            await ctx.reply('❌ حدث خطأ فني أثناء الإلغاء.');
        }
        return ctx.scene.leave();
    }
);

module.exports = cancelReasonScene;