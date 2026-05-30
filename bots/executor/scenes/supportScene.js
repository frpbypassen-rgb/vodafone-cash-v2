// bots/executor/scenes/supportScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const SupportTicket = require('../../../models/SupportTicket');
const Employee = require('../../../models/Employee');
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
        const botData = ctx.scene.state.botData;
        const telegramId = ctx.from.id.toString();

        if (ctx.message && (ctx.message.text === '/cancel' || ctx.message.text === 'الغاء ❌')) {
            const emp = await Employee.findOne({ telegramId, botId: botData._id });
            let kbd = [];
            if (emp && emp.role === 'operator') {
                kbd = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], ['🎧 الدعم الفني وتواصل معنا']];
            } else {
                const toggleBtn = botData.status === 'paused' ? '🔴 استئناف عمل البوت' : '🟢 إيقاف مؤقت للبوت';
                if (botData.isManagerBot) kbd = [[toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
                else kbd = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], [toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
            }
            await ctx.reply('✅ تم إلغاء الإرسال.', Markup.keyboard(kbd).resize());
            return ctx.scene.leave();
        }

        if (!ctx.message || (!ctx.message.text && !ctx.message.photo)) {
            await ctx.reply('⚠️ الرجاء إرسال رسالة نصية أو صورة توضح مشكلتك.');
            return;
        }

        try {
            const emp = await Employee.findOne({ telegramId, botId: botData._id });
            const entityType = 'executor';
            const entityId = emp._id;
            const name = emp.name;
            const phone = emp.phone;

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

            let kbd = [];
            if (emp.role === 'operator') {
                kbd = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], ['🎧 الدعم الفني وتواصل معنا']];
            } else {
                const toggleBtn = botData.status === 'paused' ? '🔴 استئناف عمل البوت' : '🟢 إيقاف مؤقت للبوت';
                if (botData.isManagerBot) kbd = [[toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
                else kbd = [['🟠 الطلبات المعلقة', '🟡 طلبات قيد التنفيذ'], [toggleBtn], ['🎧 الدعم الفني وتواصل معنا']];
            }

            await ctx.reply('✅ <b>تم استلام رسالتك بنجاح!</b>\nسيقوم فريق الدعم بالرد عليك في أقرب وقت.', { 
                parse_mode: 'HTML',
                ...Markup.keyboard(kbd).resize()
            });

            // 🟢 تنبيه الإدارة عبر التيليجرام
            const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
            const admins = await Admin.find({});
            for (const admin of admins) {
                await adminAPI.sendMessage(admin.telegramId, `🚨 <b>رسالة دعم فني جديدة! (طاقم التنفيذ)</b>\n\n👤 من: ${name}\n💬 الرسالة: ${text}\n\nيرجى مراجعة لوحة التحكم للرد.`, { parse_mode: 'HTML' }).catch(()=>{});
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