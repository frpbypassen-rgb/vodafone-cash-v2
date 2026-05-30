// bots/client/scenes/clientRegisterScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const User = require('../../../models/User');
const ClientEmployee = require('../../../models/ClientEmployee');
const Admin = require('../../../models/Admin'); 

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

// ==========================================
// 🚀 دالة مساعدة للبث الجماعي لجميع المديرين
// ==========================================
const notifyAllAdmins = async (text, markup) => {
    try {
        const allAdmins = await Admin.find({});
        const adminIds = new Set(allAdmins.map(a => a.telegramId));
        if (process.env.ADMIN_TELEGRAM_ID) adminIds.add(process.env.ADMIN_TELEGRAM_ID);

        for (const targetAdminId of adminIds) {
            try {
                await adminBotAPI.sendMessage(targetAdminId, text, { parse_mode: 'HTML', ...markup });
            } catch (err) {
                console.error(`⚠️ فشل إرسال الإشعار للمدير ${targetAdminId}`);
            }
        }
    } catch (error) {
        console.error('Broadcast Error:', error);
    }
};

const clientRegisterWizard = new Scenes.WizardScene(
    'CLIENT_REGISTER_SCENE',
    async (ctx) => {
        ctx.wizard.state.botData = ctx.scene.state.botData;
        ctx.wizard.state.isMainBot = ctx.scene.state.isMainBot;
        
        const companyName = ctx.wizard.state.isMainBot ? 'خدمات الأهرام' : ctx.wizard.state.botData.name;
        await ctx.reply(`مرحباً بك في نظام [ ${companyName} ] 🚀\n\n📝 **لبدء الاستخدام، يرجى إرسال اسمك الثلاثي:**`);
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return;
        const name = ctx.message.text;
        if (name.split(' ').length < 2) {
            return ctx.reply('❌ يرجى كتابة اسمك بشكل كامل (ثنائي على الأقل):');
        }
        ctx.wizard.state.name = name;
        await ctx.reply(
            `أهلاً بك يا ${name} 🤝\n\n📱 **للتحقق من هويتك وتأمين حسابك:**\nيرجى الضغط على الزر بالأسفل لمشاركة رقم هاتفك:`,
            Markup.keyboard([[Markup.button.contactRequest('📱 مشاركة رقم الهاتف للتحقق')]]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.contact) return ctx.reply('❌ يرجى استخدام الزر الموجود بالأسفل لمشاركة رقمك.');
        if (ctx.message.contact.user_id !== ctx.from.id) return ctx.reply('❌ عذراً، لا يمكنك مشاركة رقم شخص آخر!');

        const telegramId = ctx.from.id.toString();
        const phone = ctx.message.contact.phone_number;
        const { name, isMainBot, botData } = ctx.wizard.state;

        try {
            await ctx.reply('⏳ جاري تسجيل بياناتك...', Markup.removeKeyboard());

            if (isMainBot) {
                let user = await User.findOne({ telegramId });
                if (!user) user = await User.create({ telegramId, name, phone, balance: 0, status: 'pending' });
                else { user.name = name; user.phone = phone; user.status = 'pending'; await user.save(); }
                
                await ctx.reply('✅ **تم استلام بياناتك بنجاح!**\n⏳ حسابك الآن قيد المراجعة من الإدارة.');
                
                const notifyText = `🔔 <b>طلب تسجيل عميل فردي جديد!</b>\n\n👤 <b>الاسم:</b> ${name}\n📱 <b>الهاتف:</b> <code>${phone}</code>\n🆔 <b>الأيدي:</b> <code>${telegramId}</code>`;
                const notifyMarkup = Markup.inlineKeyboard([[Markup.button.callback('✅ تفعيل العميل', `activate_${telegramId}`)]]);
                await notifyAllAdmins(notifyText, notifyMarkup);

            } else {
                let emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                if (!emp) emp = await ClientEmployee.create({ telegramId, name, phone, clientBotId: botData._id, status: 'pending' });
                else { emp.name = name; emp.phone = phone; emp.status = 'pending'; await emp.save(); }

                await ctx.reply(`✅ **تم استلام بياناتك!**\n\n⏳ طلب انضمامك لشركة [ ${botData.name} ] معلق بانتظار موافقة الإدارة المركزية.`);
                
                const notifyText = `🏢 <b>طلب انضمام موظف لشركة!</b>\n\n🏢 <b>الشركة:</b> ${botData.name}\n👤 <b>الموظف:</b> ${name}\n📱 <b>الهاتف:</b> <code>${phone}</code>\n🆔 <b>الأيدي:</b> <code>${telegramId}</code>`;
                const notifyMarkup = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ قبول في الشركة', `acceptClientEmp_${emp._id}`)],
                    [Markup.button.callback('❌ رفض وحظر', `banClientEmp_${emp._id}`)]
                ]);
                await notifyAllAdmins(notifyText, notifyMarkup);
            }
        } catch (error) {
            console.error(error);
            await ctx.reply('❌ حدث خطأ داخلي.');
        }
        return ctx.scene.leave();
    }
);

// 🚀 هذا هو السطر الأهم الذي يضمن تصدير المشهد بشكل صحيح ليتعرف عليه Telegraf
module.exports = clientRegisterWizard;