// bots/executor/scenes/employeeRegisterScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const mongoose = require('mongoose');
const Employee = require('../../../models/Employee');
const Admin = require('../../../models/Admin');

const employeeRegisterWizard = new Scenes.WizardScene(
    'EMP_REGISTER_SCENE',
    async (ctx) => {
        try {
            // 🟢 حفظ بيانات البوت في الذاكرة الدائمة
            ctx.wizard.state.botData = ctx.scene.state.botData;
            
            await ctx.reply(
                '👋 <b>أهلاً بك في غرفة العمليات!</b>\n\nيبدو أنك غير مسجل في طاقم عمل هذا البوت.\nيرجى كتابة <b>اسمك الحقيقي (ثلاثي)</b> لبدء التسجيل:', 
                { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
            );
            return ctx.wizard.next();
        } catch (e) {
            await ctx.reply('❌ حدث خطأ في بدء التسجيل.');
            return ctx.scene.leave();
        }
    },
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) {
            return ctx.reply('⚠️ يرجى كتابة اسمك بشكل صحيح كرسالة نصية.');
        }

        ctx.wizard.state.empName = ctx.message.text.trim();

        await ctx.reply(
            '📱 ممتاز! الآن يرجى مشاركة رقم هاتفك بالضغط على الزر بالأسفل:', 
            Markup.keyboard([
                [Markup.button.contactRequest('📞 مشاركة رقم الهاتف المربوط بالتيليجرام')]
            ]).resize().oneTime()
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || (!ctx.message.contact && !ctx.message.text)) {
            return ctx.reply('⚠️ يرجى مشاركة رقم هاتفك عبر الزر المخصص.');
        }

        const phone = ctx.message.contact ? ctx.message.contact.phone_number : ctx.message.text.trim();
        const botData = ctx.wizard.state.botData;

        if (!botData || !botData._id) {
            await ctx.reply('❌ فقدان الاتصال بالخادم، يرجى إعادة المحاولة بإرسال /start');
            return ctx.scene.leave();
        }

        try {
            const existingEmp = await Employee.findOne({ telegramId: ctx.from.id.toString(), botId: botData._id });
            if (existingEmp) {
                await ctx.reply('✅ أنت مسجل بالفعل في نظام هذا البوت.');
                return ctx.scene.leave();
            }

            // 🟢 استخدام الحقن المباشر (InsertOne) لتخطي أي Mongoose Hooks مكسورة تسبب خطأ (next is not a function)
            const newEmpData = {
                _id: new mongoose.Types.ObjectId(),
                telegramId: ctx.from.id.toString(),
                name: ctx.wizard.state.empName,
                phone: phone,
                botId: new mongoose.Types.ObjectId(botData._id),
                role: 'operator',
                status: 'pending',
                createdAt: new Date(),
                updatedAt: new Date(),
                __v: 0
            };

            await Employee.collection.insertOne(newEmpData);

            await ctx.reply(
                '⏳ <b>تم إرسال طلبك بنجاح!</b>\n\nحسابك الآن قيد المراجعة. يرجى الانتظار حتى يوافق المدير على انضمامك لفريق العمل.', 
                { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
            );

            // 🔔 إرسال إشعارات لمديري البوت والإدارة العليا
            try {
                const msgText = `👤 <b>طلب انضمام موظف جديد!</b>\n\n🏢 <b>غرفة العمليات:</b> ${botData.name}\n📝 <b>الاسم:</b> ${ctx.wizard.state.empName}\n📞 <b>الرقم:</b> ${phone}`;
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ قبول الموظف', `mgrApproveEmp_${newEmpData._id.toString()}`)],
                    [Markup.button.callback('❌ رفض الموظف', `mgrRejectEmp_${newEmpData._id.toString()}`)]
                ]);

                const managers = await Employee.find({ botId: botData._id, role: 'manager', status: 'active' });
                const botAPI = new Telegram(botData.token);
                for (const mgr of managers) {
                    if (mgr.telegramId) await botAPI.sendMessage(mgr.telegramId, msgText, { parse_mode: 'HTML', ...keyboard }).catch(()=>{});
                }

                const adminAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const admins = await Admin.find({});
                for (const ad of admins) {
                    if (ad.telegramId) await adminAPI.sendMessage(ad.telegramId, msgText + '\n<i>(يمكن لمدير الوكالة قبوله من لوحته الخاصة)</i>', { parse_mode: 'HTML' }).catch(()=>{});
                }
            } catch (notifyError) {
                console.log('⚠️ فشل إرسال إشعار تسجيل الموظف:', notifyError.message);
            }

        } catch (error) {
            console.error('🚨 [Employee Registration Error]:', error);
            if (error.code === 11000) {
                await ctx.reply('❌ عذراً، رقم الهاتف أو الحساب مسجل مسبقاً في النظام.', { reply_markup: { remove_keyboard: true } });
            } else {
                await ctx.reply(`❌ حدث خطأ داخلي أثناء التسجيل: ${error.message}`, { reply_markup: { remove_keyboard: true } });
            }
        }

        return ctx.scene.leave();
    }
);

module.exports = employeeRegisterWizard;