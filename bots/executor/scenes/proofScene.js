// bots/executor/scenes/proofScene.js
const { Scenes, Telegram } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Transaction = require('../../../models/Transaction');
const Admin = require('../../../models/Admin');
const { updateClientTracking } = require('../../../services/clientTrackingService');

const proofWizard = new Scenes.WizardScene(
    'PROOF_SCENE',
    async (ctx) => {
        try {
            const txId = ctx.scene.state.txId;
            if (!txId) return ctx.scene.leave();
            const tx = await Transaction.findById(txId);
            if (!tx || tx.status !== 'accepted') return ctx.scene.leave();

            ctx.wizard.state.tx = tx;
            await ctx.reply(`📸 <b>تم التحويل!</b>\n\nيرجى إرسال <b>صورة إثبات التحويل</b> الآن لإنهاء الطلب.\n<i>(لإلغاء أرسل /cancel)</i>`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
            return ctx.wizard.next();
        } catch (e) { return ctx.scene.leave(); }
    },
    async (ctx) => {
        try {
            if (ctx.message?.text === '/cancel') { await ctx.reply('✅ تم الإلغاء.'); return ctx.scene.leave(); }
            if (!ctx.message?.photo) return ctx.reply('⚠️ يرجى إرسال صورة الإثبات.');

            await ctx.reply('⏳ جاري رفع الإثبات للسيرفر وإرساله للعميل...');
            const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const tx = ctx.wizard.state.tx;

            let originalNote = tx.notes ? tx.notes.split('\n[')[0].split('\n---')[0].trim() : '';
            let noteText = originalNote ? `\n📝 <b>ملاحظة العميل:</b> ${originalNote}` : '';

            // 🟢 سحب الصورة وحفظها كملف فعلي (Local File)
            let photoBuffer = null;
            let localImagePath = null;
            try {
                const fileLink = await ctx.telegram.getFileLink(fileId);
                const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
                photoBuffer = Buffer.from(response.data);

                const uploadDir = path.join(process.cwd(), 'uploads', 'proofs');
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
                const fileName = `proof_${tx._id}_${Date.now()}.jpg`;
                fs.writeFileSync(path.join(uploadDir, fileName), photoBuffer);
                localImagePath = `/uploads/proofs/${fileName}`;
            } catch (err) {}

            tx.status = 'completed';
            tx.proofImage = fileId; 
            tx.proofImages = [fileId];
            tx.set('localProofImage', localImagePath, { strict: false }); // 🟢 الحفظ بالهارد ديسك
            tx.notes = (tx.notes || '') + '\n[تم التنفيذ وإرفاق الإثبات من قبل الموظف]';
            await tx.save();

            await updateClientTracking(tx._id, 'completed', '', photoBuffer);

            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            const admins = await Admin.find({});
            for (const admin of admins) {
                if (admin.telegramId) await adminAPI.sendPhoto(admin.telegramId, fileId, { caption: `✅👨‍💻 <b>تم التنفيذ اليدوي بنجاح!</b>\n🧾 الطلب: <code>${tx.customId}</code>\n💵 بقيمة: ${tx.amount} EGP.\n👨‍💻 بواسطة المنفذ: ${tx.executorName}${noteText}`, parse_mode: 'HTML' }).catch(()=>{});
            }

            if (ctx.scene.state.promptMsgId) {
                await ctx.telegram.editMessageCaption(ctx.from.id, ctx.scene.state.promptMsgId, null, `✅ <b>تم إنهاء الطلب بنجاح.</b>\n🧾 الطلب: <code>${tx.customId}</code>`, { parse_mode: 'HTML' }).catch(()=>{});
            }

            await ctx.reply('🎉 <b>تم إغلاق الطلب، وتحديث لوحة العميل، ورفع الإثبات بنجاح!</b>', { parse_mode: 'HTML' });
            return ctx.scene.leave();
        } catch (error) { return ctx.scene.leave(); }
    }
);

module.exports = proofWizard;