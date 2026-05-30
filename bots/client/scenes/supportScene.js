// bots/client/scenes/supportScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const SupportTicket = require('../../../models/SupportTicket');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');
const ClientEmployee = require('../../../models/ClientEmployee');
const Admin = require('../../../models/Admin');

const supportWizard = new Scenes.WizardScene(
    'SUPPORT_SCENE',
    async (ctx) => {
        await ctx.reply(
            '🎧 <b>الدعم الفني والمساعدة</b>\n\n' +
            'الرجاء كتابة رسالتك أو استفسارك في رسالة واحدة، وسيقوم فريق الدعم بالرد عليك في أقرب وقت ممكن.\n\n' +
            '<i>(يمكنك إرسال نص، أو صورة مع توضيح)</i>\n' +
            'لإلغاء العملية أرسل الغاء ❌',
            { parse_mode: 'HTML', ...Markup.keyboard([['الغاء ❌']]).resize() }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.message && (ctx.message.text === '/cancel' || ctx.message.text === 'الغاء ❌')) {
            await ctx.reply('✅ تم إلغاء الإرسال.', Markup.keyboard([
                ['💸 تحويل فودافون كاش (مصر)', '📮 تحويل بريد'],
                ['👤 حسابي', '🎧 الدعم الفني وتواصل معنا']
            ]).resize());
            return ctx.scene.leave();
        }

        if (!ctx.message || (!ctx.message.text && !ctx.message.photo)) {
            await ctx.reply('⚠️ الرجاء إرسال رسالة نصية أو صورة توضح مشكلتك.');
            return;
        }

        try {
            const botData = ctx.scene.state.botData;
            const isMainBot = ctx.scene.state.isMainBot;
            const telegramId = ctx.from.id.toString();
            
            let entityType, entityId, name, phone;

            if (isMainBot) {
                const user = await User.findOne({ telegramId });
                entityType = 'client_user';
                entityId = user._id;
                name = user.name;
                phone = user.phone;
            } else {
                const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                const comp = await ClientBot.findById(botData._id);
                entityType = 'client_company';
                entityId = comp._id;
                name = `${comp.name} - ${emp.name}`;
                phone = emp.phone;
            }

            let text = ctx.message.text || ctx.message.caption || 'تم إرسال صورة بدون نص';
            let imageUrl = '';
            if (ctx.message.photo) {
                imageUrl = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            }

            let ticket = await SupportTicket.findOne({ telegramId, status: { $ne: 'closed' } });

            if (!ticket) {
                ticket = new SupportTicket({
                    entityType, entityId, telegramId, name, phone,
                    botToken: botData.token, messages: []
                });
            }

            ticket.messages.push({ sender: 'user', text: text, imageUrl: imageUrl, createdAt: new Date() });
            ticket.status = 'open';
            ticket.unreadAdmin += 1;
            await ticket.save();

            await ctx.reply('✅ <b>تم استلام رسالتك بنجاح!</b>\nسيقوم فريق الدعم بالرد عليك في أقرب وقت.', { 
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    ['💸 تحويل فودافون كاش (مصر)', '📮 تحويل بريد'],
                    ['👤 حسابي', '🎧 الدعم الفني وتواصل معنا']
                ]).resize()
            });

            // 🟢 تنبيه الإدارة عبر التيليجرام بوجود رسالة جديدة
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            const admins = await Admin.find({});
            for (const admin of admins) {
                await adminAPI.sendMessage(admin.telegramId, `🚨 <b>رسالة دعم فني جديدة!</b>\n\n👤 من: ${name}\n💬 الرسالة: ${text}\n\nيرجى مراجعة لوحة التحكم للرد.`, { parse_mode: 'HTML' }).catch(()=>{});
            }

            return ctx.scene.leave();
        } catch (err) {
            console.error(err);
            await ctx.reply('❌ حدث خطأ، يرجى المحاولة لاحقاً.');
            return ctx.scene.leave();
        }
    }
);
module.exports = supportWizard;