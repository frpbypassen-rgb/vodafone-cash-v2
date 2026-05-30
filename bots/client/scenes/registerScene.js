// bots/client/scenes/transferScene.js
const { Scenes, Markup, Telegram } = require('telegraf');
const User = require('../../../models/User');
const ClientBot = require('../../../models/ClientBot');
const ClientEmployee = require('../../../models/ClientEmployee');
const Transaction = require('../../../models/Transaction');
const Settings = require('../../../models/Settings');
const Admin = require('../../../models/Admin');

const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);

// ==========================================
// 🚀 دالة مساعدة للبث الجماعي لجميع المديرين
// ==========================================
const notifyAdmins = async (msgText, markup) => {
    try {
        const allAdmins = await Admin.find({});
        const adminIds = new Set(allAdmins.map(a => a.telegramId));
        if (process.env.ADMIN_TELEGRAM_ID) adminIds.add(process.env.ADMIN_TELEGRAM_ID);

        for (const targetAdminId of adminIds) {
            try {
                await adminBotAPI.sendMessage(targetAdminId, msgText, { parse_mode: 'HTML', ...markup });
            } catch (err) {
                // تجاهل أخطاء الحظر من قبل بعض المديرين
            }
        }
    } catch (error) {
        console.error('Broadcast Error:', error);
    }
};

const transferWizard = new Scenes.WizardScene(
    'TRANSFER_SCENE',
    
    // 📍 الخطوة 1: طلب رقم الهاتف
    async (ctx) => {
        ctx.wizard.state.isMainBot = ctx.scene.state.isMainBot;
        ctx.wizard.state.botData = ctx.scene.state.botData;
        
        await ctx.reply(
            '📞 <b>من فضلك، أرسل رقم فودافون كاش المراد التحويل إليه:</b>\n(يجب أن يتكون من 11 رقم ويبدأ بـ 01)', 
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء الإجراء', 'cancel_transfer')]])
            }
        );
        return ctx.wizard.next();
    },
    
    // 📍 الخطوة 2: التحقق من الرقم وطلب المبلغ
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_transfer') {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText('❌ تم إلغاء عملية التحويل بنجاح.');
            return ctx.scene.leave();
        }
        
        const phone = ctx.message?.text?.trim();
        // التحقق من صحة الرقم المصري
        if (!phone || !/^01[0125][0-9]{8}$/.test(phone)) {
            return ctx.reply('⚠️ رقم غير صحيح! يرجى إدخال رقم فودافون كاش صحيح مكون من 11 رقم:');
        }
        
        ctx.wizard.state.targetNumber = phone;
        await ctx.reply(
            `✅ تم قبول الرقم: <code>${phone}</code>\n\n💵 <b>الآن أرسل المبلغ المراد تحويله بالجنيه المصري (EGP):</b>`, 
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🔙 إلغاء الإجراء', 'cancel_transfer')]])
            }
        );
        return ctx.wizard.next();
    },
    
    // 📍 الخطوة 3: التحقق من الرصيد والمديونية وعرض ملخص العملية
    async (ctx) => {
        if (ctx.callbackQuery?.data === 'cancel_transfer') {
            await ctx.answerCbQuery().catch(()=>{});
            await ctx.editMessageText('❌ تم إلغاء عملية التحويل بنجاح.');
            return ctx.scene.leave();
        }
        
        const amountEGP = parseFloat(ctx.message?.text?.trim());
        if (isNaN(amountEGP) || amountEGP <= 0) {
            return ctx.reply('⚠️ مبلغ غير صحيح! يرجى إدخال أرقام صحيحة أكبر من الصفر:');
        }
        
        const telegramId = ctx.from.id.toString();
        const { isMainBot, botData, targetNumber } = ctx.wizard.state;
        
        try {
            let user, company, employee;
            let tier = 1;
            let currentBalance = 0;
            let creditLimit = 0;
            let senderName = '';
            
            // جلب بيانات الحساب
            if (isMainBot) {
                user = await User.findOne({ telegramId });
                if (!user || user.status !== 'active') {
                    await ctx.reply('⛔️ حسابك غير مفعل.');
                    return ctx.scene.leave();
                }
                tier = user.tier || 1;
                currentBalance = user.balance;
                creditLimit = user.creditLimit || 0;
                senderName = user.name;
            } else {
                employee = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                if (!employee || employee.status !== 'active') {
                    await ctx.reply('⛔️ حسابك غير مفعل.');
                    return ctx.scene.leave();
                }
                company = await ClientBot.findById(botData._id);
                tier = company.tier || 1;
                currentBalance = company.balance;
                creditLimit = company.creditLimit || 0;
                senderName = `شركة ${company.name} (الموظف: ${employee.name})`;
            }
            
            // جلب أسعار الصرف من الإعدادات
            const set = await Settings.findOne({}) || await Settings.create({});
            let currentRate = set.rateLevel1 || 6.40;
            if (tier === 2) currentRate = set.rateLevel2 || 6.45;
            if (tier === 3) currentRate = set.rateLevel3 || 6.50;
            
            // حساب التكلفة الإجمالية بالدينار الليبي
            const costLYD = amountEGP * currentRate;
            
            // 🚀 التحقق الصارم من المديونية والحد الائتماني
            // المعادلة: إذا كان (الرصيد الفعلي - التكلفة) أصغر من (الحد الائتماني بالسالب)
            if ((currentBalance - costLYD) < -creditLimit) {
                await ctx.reply('⚠️ <b>عذراً، لا يمكن تنفيذ العملية لتجاوز الحد الأقصى للمديونية.</b>\nيرجى تسديد المديونية لإكمال العمل 💳', { parse_mode: 'HTML' });
                return ctx.scene.leave();
            }
            
            // تخزين البيانات للخطوة النهائية
            ctx.wizard.state.amountEGP = amountEGP;
            ctx.wizard.state.costLYD = costLYD;
            ctx.wizard.state.exchangeRate = currentRate;
            ctx.wizard.state.senderName = senderName;
            ctx.wizard.state.userObj = user;
            ctx.wizard.state.companyObj = company;
            ctx.wizard.state.employeeObj = employee;
            
            const confirmMsg = `🧾 <b>مراجعة وتأكيد بيانات التحويل:</b>\n\n` +
                               `📞 <b>رقم المحفظة:</b> <code>${targetNumber}</code>\n` +
                               `🇪🇬 <b>المبلغ:</b> ${amountEGP} EGP\n` +
                               `💱 <b>سعر الصرف المعتمد:</b> ${currentRate}\n` +
                               `🇱🇾 <b>التكلفة الإجمالية:</b> ${costLYD.toFixed(2)} دينار\n` +
                               `━━━━━━━━━━━━━━\n` +
                               `هل أنت متأكد من رغبتك في تنفيذ هذه العملية؟`;
                               
            await ctx.reply(confirmMsg, { 
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ تأكيد وإرسال للإدارة', 'confirm_transfer')],
                    [Markup.button.callback('❌ إلغاء العملية', 'cancel_transfer')]
                ])
            });
            return ctx.wizard.next();
            
        } catch (err) {
            console.error(err);
            await ctx.reply('❌ حدث خطأ فني أثناء قراءة البيانات.');
            return ctx.scene.leave();
        }
    },
    
    // 📍 الخطوة 4: خصم الرصيد، إنشاء المعاملة، إبلاغ الإدارة
    async (ctx) => {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(()=>{});
        
        if (ctx.callbackQuery?.data === 'cancel_transfer') {
            await ctx.editMessageText('❌ تم إلغاء عملية التحويل بنجاح.');
            return ctx.scene.leave();
        }
        
        if (ctx.callbackQuery?.data === 'confirm_transfer') {
            await ctx.editMessageText('⏳ جاري تنفيذ العملية، تحديث الأرصدة وإبلاغ الإدارة...');
            
            const { isMainBot, botData, targetNumber, amountEGP, costLYD, exchangeRate, senderName, userObj, companyObj, employeeObj } = ctx.wizard.state;
            const telegramId = ctx.from.id.toString();
            
            try {
                // إنشاء المعاملة في قاعدة البيانات
                const newTx = await Transaction.create({
                    userId: telegramId,
                    clientBotId: isMainBot ? null : botData._id,
                    operatorId: isMainBot ? null : telegramId, // الآي دي الخاص بالموظف للشركات
                    employeeName: employeeObj ? employeeObj.name : null, // لحفظ اسم الموظف صراحة للتقارير الختامية
                    amount: amountEGP,
                    costLYD: costLYD,
                    exchangeRate: exchangeRate, // 🚀 تخزين سعر الصرف اللحظي
                    vodafoneNumber: targetNumber,
                    status: 'processing'
                });
                
                // توليد Custom ID بسيط واحترافي للعملية
                newTx.customId = `TX-${newTx._id.toString().slice(-6).toUpperCase()}`;
                await newTx.save();
                
                // خصم الرصيد من قاعدة البيانات بشكل فعلي
                if (isMainBot) {
                    await User.findByIdAndUpdate(userObj._id, { $inc: { balance: -costLYD } });
                } else {
                    await ClientBot.findByIdAndUpdate(companyObj._id, { $inc: { balance: -costLYD } });
                }
                
                await ctx.reply(
                    `✅ <b>تم استلام طلبك وتحديث رصيدك بنجاح!</b>\n\n🧾 رقم العملية: <code>${newTx.customId}</code>\n⏳ الطلب الآن قيد التنفيذ والمراجعة من قبل الإدارة.`, 
                    { parse_mode: 'HTML' }
                );
                
                // بث إشعار فوري لجميع المديرين
                const adminMsg = `🚨 <b>طلب تحويل جديد!</b>\n\n` +
                                 `👤 <b>الجهة/العميل:</b> ${senderName}\n` +
                                 `📞 <b>الرقم المطلوب:</b> <code>${targetNumber}</code>\n` +
                                 `🇪🇬 <b>المبلغ:</b> ${amountEGP} EGP\n` +
                                 `🇱🇾 <b>التكلفة:</b> ${costLYD.toFixed(2)} دينار (بسعر: ${exchangeRate})\n` +
                                 `━━━━━━━━━━━━━━\n` +
                                 `🧾 <b>رقم العملية:</b> <code>${newTx.customId}</code>`;
                                 
                const adminMarkup = Markup.inlineKeyboard([
                    [Markup.button.callback('✅ موافقة وتحويل لمنفذ', `approveTx_${newTx._id}`)],
                    [Markup.button.callback('❌ رفض وإرجاع الرصيد', `rejectTx_${newTx._id}`)]
                ]);
                
                await notifyAdmins(adminMsg, adminMarkup);
                
            } catch (err) {
                console.error('Transfer Execution Error:', err);
                await ctx.reply('❌ حدث خطأ أثناء تنفيذ المعاملة وحفظها في قاعدة البيانات.');
            }
        }
        return ctx.scene.leave();
    }
);

module.exports = transferWizard;