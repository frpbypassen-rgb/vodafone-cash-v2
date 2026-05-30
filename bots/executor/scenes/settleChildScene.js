const { Scenes, Markup } = require('telegraf');
const ExecutorBot = require('../../../models/ExecutorBot');
const Transaction = require('../../../models/Transaction');

const settleChildWizard = new Scenes.WizardScene(
    'SETTLE_CHILD_SCENE',
    async (ctx) => {
        const botData = ctx.scene.state.botData;
        const childBots = await ExecutorBot.find({ parentBotId: botData._id });

        if (childBots.length === 0) {
            await ctx.reply('❌ لا يوجد بوتات فرعية تابعة لك.');
            return ctx.scene.leave();
        }

        const buttons = childBots.map(b => [Markup.button.callback(`🤖 ${b.name} | المديونية: ${Math.abs(b.balance || 0)}`, `settle_child_${b._id}`)]);
        buttons.push([Markup.button.callback('❌ إلغاء العملية', 'cancel_settle')]);

        await ctx.reply('👇 <b>اختر البوت الذي قام بتسليم العهدة النقدية (السداد):</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_settle') {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText('✅ تم الإلغاء.');
            return ctx.scene.leave();
        }

        if (ctx.callbackQuery && ctx.callbackQuery.data.startsWith('settle_child_')) {
            const childId = ctx.callbackQuery.data.split('settle_child_')[1];
            ctx.wizard.state.childId = childId;
            await ctx.answerCbQuery().catch(()=>{});

            const childBot = await ExecutorBot.findById(childId);
            await ctx.editMessageText(`💰 <b>تسديد حساب البوت الفرعي:</b> ${childBot.name}\n📊 <b>المديونية الحالية:</b> ${Math.abs(childBot.balance || 0)} EGP\n\nالرجاء إدخال <b>المبلغ المسدد</b> بالأرقام الإنجليزية:\n(للإلغاء أرسل /cancel)`, { parse_mode: 'HTML' });
            return ctx.wizard.next();
        }
    },
    async (ctx) => {
        if (ctx.message && ctx.message.text === '/cancel') {
            await ctx.reply('✅ تم الإلغاء.');
            return ctx.scene.leave();
        }

        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('⚠️ الرجاء إدخال مبلغ صحيح بالأرقام.');
            return;
        }

        try {
            const botData = ctx.scene.state.botData;
            const childBot = await ExecutorBot.findById(ctx.wizard.state.childId);

            // 🟢 تسجيل الإيداع في قاعدة البيانات بحيث يخصم من مديونية الفرعي ولا يؤثر على مديونية الوكيل
            await Transaction.create({
                userId: 'admin',
                executorBotId: childBot._id,
                managerBotId: botData._id,
                amount: amount,
                costLYD: 0,
                vodafoneNumber: 'تسديد داخلي للوكيل',
                status: 'deposit',
                customId: `PAY-${Date.now().toString().slice(-6)}`,
                companyName: 'سداد عهدة للوكيل',
                employeeName: 'تسديد من منفذ',
                executorName: botData.name
            });

            // تحديث رصيد البوت الفرعي لتقليل المديونية
            childBot.balance += amount; 
            await childBot.save();

            await ctx.reply(`✅ <b>تم تسديد مبلغ ${amount} EGP بنجاح من حساب ${childBot.name}.</b>\nالمديونية المتبقية للبوت: ${Math.abs(childBot.balance)} EGP`, { parse_mode: 'HTML' });
            return ctx.scene.leave();
        } catch (e) {
            await ctx.reply('❌ حدث خطأ أثناء التسديد.');
            return ctx.scene.leave();
        }
    }
);

module.exports = settleChildWizard;