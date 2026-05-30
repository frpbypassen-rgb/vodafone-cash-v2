// bots/executor/scenes/editAmountScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Transaction = require('../../../models/Transaction');
const ClientBot = require('../../../models/ClientBot');
const Admin = require('../../../models/Admin');
const User = require('../../../models/User');
const { updateClientTracking } = require('../../../services/clientTrackingService');

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

const editAmountWizard = new Scenes.WizardScene(
    'EDIT_AMOUNT_SCENE',
    async (ctx) => {
        ctx.wizard.state.txId = ctx.scene.state.txId;
        ctx.wizard.state.promptMsgId = ctx.scene.state.promptMsgId;
        const tx = await Transaction.findById(ctx.wizard.state.txId);
        await editPrompt(ctx, `✏️ <b>تعديل المبلغ (تحويل جزئي)</b>\n\nالمبلغ الأصلي: <b>${tx.amount} EGP</b>\n\nالرجاء إرسال المبلغ الجديد (الذي تم تحويله فعلياً):`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'edit_back') {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            const execMsg = `⚙️ <b>أنت الآن تقوم بتنفيذ هذا الطلب!</b>\n\n🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n📞 <b>رقم المحفظة:</b> <code>${tx.vodafoneNumber}</code>\n💵 <b>المبلغ المطلوب:</b> ${tx.amount} EGP\n${tx.notes ? `📝 <b>الملاحظة:</b> ${tx.notes}\n` : ''}━━━━━━━━━━━━━━`;
            await editPrompt(ctx, execMsg, Markup.inlineKeyboard([
                [Markup.button.callback('✅ تم التحويل (إرفاق الإثبات)', `done_task_${tx._id}`)],
                [Markup.button.callback('✏️ تعديل المبلغ المحول', `editAmount_${tx._id}`)],
                [Markup.button.callback('❌ إلغاء الحوالة (يوجد مشكلة)', `cancelExec_${tx._id}`)]
            ]));
            return ctx.scene.leave();
        }

        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            const newAmount = parseFloat(ctx.message.text?.trim());
            if (isNaN(newAmount) || newAmount <= 0) {
                await editPrompt(ctx, '⚠️ <b>مبلغ غير صالح!</b>\nالرجاء كتابة رقم صحيح:', Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
                return;
            }

            ctx.wizard.state.newAmount = newAmount;
            await editPrompt(ctx, `✅ تم حفظ المبلغ الجديد: <b>${newAmount} EGP</b>\n\n📸 الرجاء إرسال صورة الإثبات الآن:`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'edit_back') {
            const tx = await Transaction.findById(ctx.wizard.state.txId);
            await editPrompt(ctx, `✏️ <b>تعديل المبلغ (تحويل جزئي)</b>\n\nالمبلغ الأصلي: <b>${tx.amount} EGP</b>\n\nالرجاء إرسال المبلغ الجديد (الذي تم تحويله فعلياً):`, Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'cancel_scene')]]));
            ctx.wizard.selectStep(1);
            return;
        }
        if (ctx.message) {
            await ctx.deleteMessage().catch(()=>{});
            if (!ctx.message.photo) {
                await editPrompt(ctx, '⚠️ <b>يجب إرسال صورة.</b>\nالرجاء إرسال صورة الإثبات:', Markup.inlineKeyboard([[Markup.button.callback('🔙 تراجع', 'edit_back')]]));
                return;
            }

            await editPrompt(ctx, '⏳ <i>جاري معالجة الإثبات وإغلاق الطلب...</i>');
            const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            
            try {
                const tx = await Transaction.findById(ctx.wizard.state.txId);
                const oldAmount = tx.amount;
                const oldLYD = tx.costLYD;
                const newAmount = ctx.wizard.state.newAmount;

                let originalNote = tx.notes ? tx.notes.split('\n[')[0].split('\n---')[0].trim() : '';
                let noteText = originalNote ? `\n📝 <b>ملاحظة العميل:</b> ${originalNote}` : '';

                const newLYD = parseFloat((newAmount / tx.exchangeRate).toFixed(3));
                const refundLYD = oldLYD - newLYD;

                // 🟢 سحب الصورة وحفظها كملف فعلي
                let photoBuffer = null;
                let localImagePath = null;
                try {
                    const fileLink = await ctx.telegram.getFileLink(photoId);
                    const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                    photoBuffer = Buffer.from(response.data);

                    const uploadDir = path.join(process.cwd(), 'uploads', 'proofs');
                    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                    const fileName = `proof_${tx._id}_${Date.now()}.jpg`;
                    fs.writeFileSync(path.join(uploadDir, fileName), photoBuffer);
                    localImagePath = `/uploads/proofs/${fileName}`;
                } catch (fetchErr) {}

                tx.amount = newAmount;
                tx.costLYD = newLYD;
                tx.proofImage = photoId;
                tx.proofImages = [photoId];
                tx.status = 'completed';
                tx.set('localProofImage', localImagePath, { strict: false }); // 🟢 الحفظ بالهارد ديسك
                await tx.save();

                if (refundLYD > 0) {
                    if (tx.clientBotId) await ClientBot.findByIdAndUpdate(tx.clientBotId, { $inc: { balance: refundLYD } });
                    else await User.findOneAndUpdate({ telegramId: tx.userId }, { $inc: { balance: refundLYD } });
                }

                const refundNote = `تم تحويل ${newAmount} جنيه بدلاً من ${oldAmount} جنيه، وإرجاع ${refundLYD.toFixed(2)} دينار لرصيدك.`;
                await updateClientTracking(tx._id, 'completed_modified', refundNote, photoBuffer);

                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const adminMsg = `⚠️ <b>تم تنفيذ حوالة بنجاح (مع تعديل المبلغ)!</b>\n\n` +
                                 `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                 `📞 <b>الرقم المحول إليه:</b> <code>${tx.vodafoneNumber}</code>\n` +
                                 `💵 <b>المبلغ الجديد:</b> ${newAmount} EGP (كان ${oldAmount})\n` +
                                 `💰 <b>تم إرجاع:</b> ${refundLYD.toFixed(2)} LYD للعميل.` + noteText;

                const allAdmins = await Admin.find({});
                for (const admin of allAdmins) {
                    try {
                        if (photoBuffer) {
                            await adminAPI.sendPhoto(admin.telegramId, { source: photoBuffer }, { caption: adminMsg, parse_mode: 'HTML' });
                        } else {
                            await adminAPI.sendMessage(admin.telegramId, adminMsg, { parse_mode: 'HTML' });
                        }
                    } catch (adminErr) {}
                }

                await editPrompt(ctx, `✅ <b>اكتملت العملية بنجاح وتم الرفع!</b>\n\nتم التنفيذ بمبلغ ${newAmount} واسترجاع الفارق للعميل.`, {});

            } catch (e) {}
            return ctx.scene.leave();
        }
    }
);
module.exports = editAmountWizard;