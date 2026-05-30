// bots/client/manager.js
const { Telegraf, Markup, session, Scenes, Telegram } = require('telegraf');
const ExcelJS = require('exceljs');
const cron = require('node-cron'); 

const User = require('../../models/User');
const ClientBot = require('../../models/ClientBot');
const ClientEmployee = require('../../models/ClientEmployee');
const Transaction = require('../../models/Transaction');
const Settings = require('../../models/Settings');
const ExecutorBot = require('../../models/ExecutorBot');
const Admin = require('../../models/Admin');

const transferWizard = require('./scenes/transferScene');
const postTransferWizard = require('./scenes/postTransferScene'); 
const clientRegisterWizard = require('./scenes/clientRegisterScene');
const complaintWizard = require('./scenes/complaintScene');
const requestSenderPhoneWizard = require('./scenes/requestSenderPhoneScene'); 
const supportWizard = require('./scenes/supportScene'); // 🟢 تمت الإضافة

const activeClientBots = new Map();

const getArgb = (hex) => {
    return 'FF' + (hex || '#FFFFFF').replace('#', '').toUpperCase();
};

const buildInvoiceSheet = (sheet, name, phone, dateLabel, txs, deposits, currentBalance, set) => {
    sheet.views = [{ rightToLeft: true }];
    const borderStyle = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const thickBorder = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };
    const alignCenter = { vertical: 'middle', horizontal: 'center' };

    sheet.getColumn(1).width = 6.5;    
    sheet.getColumn(2).width = 28.75;  
    sheet.getColumn(3).width = 23.25;  
    sheet.getColumn(4).width = 23.5;   
    sheet.getColumn(5).width = 24.5;   
    sheet.getColumn(6).width = 25.625; 
    sheet.getColumn(7).width = 21.5;   
    sheet.getColumn(8).width = 17.5;   

    sheet.mergeCells('A1:H3');
    const titleCell = sheet.getCell('A1');
    titleCell.value = 'شــــركــــــــة الاهـــــــــــرام للاتـــصــــالات والــتــقــنــيــة';
    titleCell.font = { size: 26, bold: true, color: { argb: 'FFFFFFFF' } }; 
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002060' } }; 
    titleCell.alignment = alignCenter;
    titleCell.border = thickBorder;

    sheet.mergeCells('A4:F4');
    const nameCell = sheet.getCell('A4');
    nameCell.value = `السيد: "${name}"`;
    nameCell.font = { bold: true, size: 20, color: { argb: 'FF000000' } };
    nameCell.alignment = alignCenter;

    sheet.mergeCells('G4:H4');
    const dateCell = sheet.getCell('G4');
    dateCell.value = `التاريخ: ${dateLabel}`;
    dateCell.font = { bold: true, size: 16, color: { argb: 'FF000000' } };
    dateCell.alignment = alignCenter;

    const headers = ['ت', 'التسلسل', 'رقم المحفظة', 'القيمة بالجنيه', 'سعر الصرف', 'الإجمالي بالدينار', 'التاريخ', 'ملاحظات'];
    const headerRow = sheet.getRow(6);
    headerRow.values = headers;
    headerRow.height = 35;
    headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC00000' } }; 
        cell.alignment = alignCenter;
        cell.border = borderStyle;
    });

    let totalLYD = 0; 
    let totalEGP = 0; 
    let startRow = 7;

    txs.forEach((t, index) => {
        totalLYD += t.costLYD; 
        totalEGP += t.amount;
        const rateDisplay = t.exchangeRate ? t.exchangeRate.toFixed(3) : (t.costLYD ? (t.amount / t.costLYD).toFixed(3) : '0.00');
        
        const rowValues = [
            index + 1,
            t.customId || t._id.toString().slice(-6),
            t.vodafoneNumber || t.accountNumber || '-',
            t.amount,
            rateDisplay,
            t.costLYD,
            t.updatedAt.toLocaleDateString('en-GB'),
            t.notes || ''
        ];

        const row = sheet.getRow(startRow);
        row.values = rowValues;
        row.height = 28;
        row.eachCell((cell, colNumber) => {
            cell.border = borderStyle;
            cell.alignment = alignCenter;
            cell.font = { size: 14 };
            if (colNumber === 4 || colNumber === 6) cell.numFmt = '#,##0.00';
        });
        startRow++;
    });

    let totalDeposits = 0;
    deposits.forEach(d => totalDeposits += Math.abs(d.amount)); 

    const grandTotal = currentBalance || 0;
    const previousValue = grandTotal + totalLYD - totalDeposits;

    sheet.mergeCells(`A${startRow}:C${startRow}`);
    const row1 = sheet.getRow(startRow);
    row1.height = 30;
    row1.getCell(1).value = 'شغل اليومي';
    row1.getCell(1).font = { bold: true, size: 16 };
    row1.getCell(1).alignment = alignCenter;

    row1.getCell(4).value = totalEGP;
    row1.getCell(4).numFmt = '#,##0.00';
    row1.getCell(4).font = { bold: true, size: 16 };
    row1.getCell(4).alignment = alignCenter;

    row1.getCell(5).value = 'شغل اليومي';
    row1.getCell(5).font = { bold: true, size: 16 };
    row1.getCell(5).alignment = alignCenter;

    row1.getCell(6).value = totalLYD;
    row1.getCell(6).numFmt = '#,##0.00';
    row1.getCell(6).font = { bold: true, size: 18 };
    row1.getCell(6).alignment = alignCenter;

    const row2 = sheet.getRow(startRow + 1);
    row2.height = 28;
    row2.getCell(5).value = 'القيمة السابقة';
    row2.getCell(5).font = { bold: true, size: 16 };
    row2.getCell(5).alignment = alignCenter;
    
    row2.getCell(6).value = previousValue;
    row2.getCell(6).numFmt = '#,##0.00';
    row2.getCell(6).font = { bold: true, size: 16 };
    row2.getCell(6).alignment = alignCenter;

    const row3 = sheet.getRow(startRow + 2);
    row3.height = 28;
    row3.getCell(5).value = 'المدفوع';
    row3.getCell(5).font = { bold: true, size: 16 };
    row3.getCell(5).alignment = alignCenter;

    row3.getCell(6).value = totalDeposits;
    row3.getCell(6).numFmt = '#,##0.00';
    row3.getCell(6).font = { bold: true, size: 16 };
    row3.getCell(6).alignment = alignCenter;

    const row4 = sheet.getRow(startRow + 3);
    row4.height = 32;
    row4.getCell(5).value = 'المجموع المتبقي';
    row4.getCell(5).font = { bold: true, size: 16 };
    row4.getCell(5).alignment = alignCenter;

    row4.getCell(6).value = grandTotal;
    row4.getCell(6).numFmt = '#,##0.00';
    row4.getCell(6).font = { bold: true, size: 18, color: { argb: grandTotal < 0 ? 'FFFF0000' : 'FF000000' } };
    row4.getCell(6).alignment = alignCenter;
    row4.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } }; 
    row4.getCell(6).border = thickBorder;
};

const sendSingleEntityReport = async (targetId, type) => {
    try {
        const now = new Date();
        const start = new Date(now); start.setHours(0,0,0,0);
        const end = new Date(now); end.setHours(23,59,59,999);
        const dateLabel = start.toLocaleDateString('en-GB');
        const fileDate = dateLabel.replace(/\//g, '-');

        const targetObj = type === 'USER' ? await User.findById(targetId) : await ClientBot.findById(targetId);
        if (!targetObj) return;

        const filter = type === 'USER' ? { userId: targetObj.telegramId, clientBotId: null } : { clientBotId: targetObj._id };
        const txs = await Transaction.find({ ...filter, status: 'completed', updatedAt: { $gte: start, $lte: end } }).sort({ updatedAt: 1 });
        const deposits = await Transaction.find({ ...filter, status: 'deposit', updatedAt: { $gte: start, $lte: end } });

        if (txs.length === 0 && deposits.length === 0) return;

        const set = await Settings.findOne({}) || await Settings.create({});
        const wb = new ExcelJS.Workbook();
        buildInvoiceSheet(wb.addWorksheet('كشف حساب'), targetObj.name, targetObj.phone, dateLabel, txs, deposits, targetObj.balance, set);
        const buffer = await wb.xlsx.writeBuffer();

        if (type === 'USER') {
            const mainBotAPI = new Telegram(process.env.CLIENT_BOT_TOKEN);
            await mainBotAPI.sendDocument(targetObj.telegramId, { source: Buffer.from(buffer), filename: `Invoice_${fileDate}.xlsx` }, { caption: '📊 **كشف حسابك اليومي (تقفيل النظام)**' }).catch(()=>{});
        } else {
            const compBotAPI = new Telegram(targetObj.token);
            const emps = await ClientEmployee.find({ clientBotId: targetObj._id, status: 'active' });
            for (const emp of emps) {
                await compBotAPI.sendDocument(emp.telegramId, { source: Buffer.from(buffer), filename: `Company_Invoice_${fileDate}.xlsx` }, { caption: '📊 **كشف الحساب اليومي للشركة (تقفيل النظام)**' }).catch(()=>{});
            }
        }
    } catch (err) { console.error('Error sending single report:', err); }
};

const checkAndSendDelayedReport = async (telegramId, clientBotId) => {
    try {
        const set = await Settings.findOne({});
        if (set && set.isManualClosed) {
            if (clientBotId) {
                const activeTxs = await Transaction.countDocuments({ clientBotId: clientBotId, status: { $in: ['pending', 'processing', 'accepted'] } });
                if (activeTxs === 0) await sendSingleEntityReport(clientBotId, 'COMPANY');
            } else {
                const activeTxs = await Transaction.countDocuments({ userId: telegramId, clientBotId: null, status: { $in: ['pending', 'processing', 'accepted'] } });
                if (activeTxs === 0) {
                    const user = await User.findOne({ telegramId });
                    if (user) await sendSingleEntityReport(user._id, 'USER');
                }
            }
        }
    } catch (err) { console.error(err); }
};

const handleManualCloseReports = async () => {
    const users = await User.find({ status: 'active' });
    for (const user of users) {
        const activeTxs = await Transaction.countDocuments({ userId: user.telegramId, clientBotId: null, status: { $in: ['pending', 'processing', 'accepted'] } });
        if (activeTxs === 0) await sendSingleEntityReport(user._id, 'USER');
    }

    const companies = await ClientBot.find({ status: 'active' });
    for (const comp of companies) {
        const activeTxs = await Transaction.countDocuments({ clientBotId: comp._id, status: { $in: ['pending', 'processing', 'accepted'] } });
        if (activeTxs === 0) await sendSingleEntityReport(comp._id, 'COMPANY');
    }
};

const sendDailyReportsToAll = async () => {
    const users = await User.find({ status: 'active' });
    for (const user of users) await sendSingleEntityReport(user._id, 'USER');

    const companies = await ClientBot.find({ status: 'active' });
    for (const comp of companies) await sendSingleEntityReport(comp._id, 'COMPANY');
};

const generateClientExcel = async (ctx, botData, type) => {
    const telegramId = ctx.from.id.toString();
    const isMainBot = botData.name === 'البوت الرئيسي';
    let targetName = '', targetPhone = '', entityFilter = {}, currentDbBalance = 0;
    try {
        if (isMainBot) {
            const user = await User.findOne({ telegramId });
            if (!user || user.status !== 'active') return ctx.reply('⛔️ حسابك غير مفعل.');
            targetName = user.name; targetPhone = user.phone;
            entityFilter = { userId: telegramId, clientBotId: null };
            currentDbBalance = user.balance;
        } else {
            const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
            if (!emp || emp.status !== 'active') return ctx.reply('⛔️ غير مصرح لك.');
            const company = await ClientBot.findById(botData._id);
            targetName = company.name; targetPhone = company.phone;
            entityFilter = { clientBotId: botData._id };
            currentDbBalance = company.balance;
        }
        
        const now = new Date();
        let start, end, dateLabel;
        if (type === 'daily') {
            start = new Date(now); start.setHours(0, 0, 0, 0);
            end = new Date(now); end.setHours(23, 59, 59, 999);
            dateLabel = start.toLocaleDateString('en-GB');
        } else {
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            dateLabel = `شهر ${now.getMonth() + 1} - ${now.getFullYear()}`;
        }

        const txs = await Transaction.find({ status: 'completed', ...entityFilter, updatedAt: { $gte: start, $lte: end } }).sort({ updatedAt: 1 });
        const deposits = await Transaction.find({ status: 'deposit', ...entityFilter, updatedAt: { $gte: start, $lte: end } });
        
        if (txs.length === 0 && deposits.length === 0) return ctx.reply('✅ لا توجد عمليات مسجلة للتقرير في هذه الفترة.');
        
        const set = await Settings.findOne({}) || await Settings.create({});
        const workbook = new ExcelJS.Workbook();
        buildInvoiceSheet(workbook.addWorksheet('كشف حساب'), targetName, targetPhone, dateLabel, txs, deposits, currentDbBalance, set);
        const buffer = await workbook.xlsx.writeBuffer();
        
        await ctx.replyWithDocument(
            { source: Buffer.from(buffer), filename: `Account_Statement_${dateLabel.replace(/\//g, '-')}.xlsx` }, 
            { caption: `📊 <b>كشف حساب ${type === 'daily' ? 'يومي' : 'شهري'}</b>\n👤 الجهة: ${targetName}\n📅 التاريخ: ${dateLabel}`, parse_mode: 'HTML' }
        );
    } catch (error) { 
        console.error(error); 
        ctx.reply('❌ حدث خطأ فني أثناء استخراج التقرير.'); 
    }
};

const launchClientBot = (botData) => {
    try {
        if (activeClientBots.has(botData.token)) return;
        const bot = new Telegraf(botData.token);
        
        // 🟢 تمت إضافة المشهد
        const stage = new Scenes.Stage([transferWizard, postTransferWizard, clientRegisterWizard, complaintWizard, requestSenderPhoneWizard, supportWizard]);
        bot.use(session());
        bot.use(stage.middleware());

        // 🟢 تمت إضافة زر الدعم
        const mainKeyboard = Markup.keyboard([
            ['💸 تحويل فودافون كاش (مصر)', '📮 تحويل بريد'],
            ['👤 حسابي', '🎧 الدعم الفني وتواصل معنا']
        ]).resize();

        bot.command('web', async (ctx) => {
            const args = ctx.message.text.split(' ');
            if (args.length !== 3) {
                return ctx.reply('🌐 <b>لتفعيل حسابك على الموقع الإلكتروني:</b>\n\nأرسل الأمر متبوعاً باسم مستخدم وكلمة مرور، هكذا:\n\n<code>/web username password</code>\n\nمثال:\n<code>/web ahmed123 12345678</code>', { parse_mode: 'HTML' });
            }

            const username = args[1].toLowerCase().trim();
            const password = args[2].trim();
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';

            try {
                let account;
                if (isMainBot) {
                    account = await User.findOne({ telegramId });
                } else {
                    account = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                }

                if (!account) return ctx.reply('⛔️ حسابك غير مسجل في النظام.');

                const userExists = await User.findOne({ webUsername: username });
                const empExists = await ClientEmployee.findOne({ webUsername: username });

                if ((userExists && userExists.telegramId !== telegramId) || (empExists && empExists.telegramId !== telegramId)) {
                    return ctx.reply('⚠️ اسم المستخدم هذا محجوز لشخص آخر، يرجى اختيار اسم مختلف.');
                }

                account.webUsername = username;
                account.webPassword = password;
                await account.save();

                ctx.reply(`✅ <b>تم تفعيل حسابك على الموقع بنجاح!</b>\n\n👤 اسم المستخدم: <code>${username}</code>\n🔑 كلمة المرور: <code>${password}</code>\n\nيمكنك الآن تسجيل الدخول عبر الرابط الخاص بالموقع.`, { parse_mode: 'HTML' });
            } catch (e) {
                ctx.reply('❌ حدث خطأ أثناء تفعيل الحساب.');
            }
        });

        bot.hears('📞 طلب رقم منفذ الحوالة', (ctx) => ctx.scene.enter('REQUEST_SENDER_PHONE_SCENE'));
        bot.hears('⚠️ شكاوي العمليات', (ctx) => ctx.scene.enter('COMPLAINT_SCENE'));

        bot.start(async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            try {
                let settings = await Settings.findOne();
                if (!settings) settings = await Settings.create({});
                const welcomeMsg = settings.welcomeMessage || 'مرحباً بك في منظومة الأهرام الرقمية للصرافة.';

                if (isMainBot) {
                    const user = await User.findOne({ telegramId });
                    if (!user || !user.name || !user.phone) return ctx.scene.enter('CLIENT_REGISTER_SCENE', { botData, isMainBot });
                    await ctx.reply(`${welcomeMsg}\n\nأهلاً بك مجدداً يا ${user.name} 🚀\n💰 الرصيد الحالي: ${user.balance.toFixed(2)} دينار`, mainKeyboard);
                } else {
                    const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                    if (!emp) return ctx.scene.enter('CLIENT_REGISTER_SCENE', { botData, isMainBot });
                    const company = await ClientBot.findById(botData._id);
                    await ctx.reply(`🏢 بوت شركة [ ${company.name} ] 🚀\n\n${welcomeMsg}\n💰 الرصيد الحالي: ${company.balance.toFixed(2)} دينار`, mainKeyboard);
                }
            } catch (e) { console.error(e); }
        });

        bot.hears('🏠 القائمة الرئيسية (ابدأ)', async (ctx) => {
            if (ctx.scene) await ctx.scene.leave(); 
            
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            try {
                let settings = await Settings.findOne();
                if (!settings) settings = await Settings.create({});
                const welcomeMsg = settings.welcomeMessage || 'مرحباً بك في منظومة الأهرام الرقمية للصرافة.';

                if (isMainBot) {
                    const user = await User.findOne({ telegramId });
                    if (!user) return;
                    await ctx.reply(`🔄 تم تحديث البوت!\n\n${welcomeMsg}\n💰 الرصيد الحالي: ${user.balance.toFixed(2)} دينار`, mainKeyboard);
                } else {
                    const company = await ClientBot.findById(botData._id);
                    await ctx.reply(`🔄 تم تحديث البوت!\n\n🏢 بوت شركة [ ${company.name} ] 🚀\n\n${welcomeMsg}\n💰 الرصيد الحالي: ${company.balance.toFixed(2)} دينار`, mainKeyboard);
                }
            } catch (e) { console.error(e); }
        });

        bot.hears('⏳ العمليات المعلقة', async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            let filter = isMainBot ? { userId: telegramId, clientBotId: null } : { clientBotId: botData._id };
            filter.status = { $in: ['pending', 'processing', 'accepted'] };

            try {
                const pendingTxs = await Transaction.find(filter).sort({ createdAt: -1 });

                if (pendingTxs.length === 0) {
                    return ctx.reply('✅ لا توجد لديك أي عمليات معلقة حالياً. جميع طلباتك مكتملة!');
                }

                await ctx.reply(`⏳ <b>لديك ${pendingTxs.length} عملية تحت التنفيذ:</b>`, { parse_mode: 'HTML' });

                for (const tx of pendingTxs) {
                    const statusNames = { 'pending': '⏳ بانتظار المدير', 'processing': '⚙️ قيد المعالجة', 'accepted': '✅ تم القبول (بانتظار التنفيذ)' };
                    const time = tx.createdAt.toLocaleString('ar-EG');
                    
                    let typeLabel = 'فودافون كاش';
                    if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                    if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                    const msg = `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                `نوع التحويل: ${typeLabel}\n` +
                                `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n` +
                                `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                                `🚦 <b>الحالة:</b> ${statusNames[tx.status]}\n` +
                                `📅 <b>الوقت:</b> ${time}`;

                    await ctx.reply(msg, {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('🔔 تذكير الإدارة', `remindAdmin_${tx._id}`)]
                        ])
                    });
                }
            } catch (e) { ctx.reply('❌ حدث خطأ أثناء جلب العمليات.'); }
        });

        bot.action(/^remindAdmin_(.+)$/, async (ctx) => {
            const txId = ctx.match[1];
            try {
                const tx = await Transaction.findById(txId);
                if (!tx || ['completed', 'rejected'].includes(tx.status)) {
                    return ctx.answerCbQuery('⚠️ هذه العملية لم تعد معلقة.');
                }

                await ctx.answerCbQuery('🚀 جاري إرسال تذكير للإدارة...');

                const isMainBot = !tx.clientBotId;
                let clientInfo = '';
                if (isMainBot) {
                    const user = await User.findOne({ telegramId: tx.userId });
                    clientInfo = `👤 <b>العميل الفردي:</b> ${user ? user.name : 'غير معروف'}`;
                } else {
                    const company = await ClientBot.findById(tx.clientBotId);
                    clientInfo = `🏢 <b>الشركة:</b> ${company ? company.name : 'غير معروف'}\n👨‍💻 <b>الموظف:</b> ${tx.employeeName || 'غير مسجل'}`;
                }

                let executorInfo = '❌ لم يتم التوجيه لمنفذ بعد';
                if (tx.executorBotId) {
                    const execBot = await ExecutorBot.findById(tx.executorBotId);
                    executorInfo = `🤖 <b>البوت المنفذ:</b> ${execBot ? execBot.name : 'غير معروف'}`;
                }

                let typeLabel = 'فودافون كاش';
                if(tx.transferType === 'post_account') typeLabel = 'حساب بريد';
                if(tx.transferType === 'post_card') typeLabel = 'بطاقة عميل';

                const adminReminder = `🔔 <b>تذكير من عميل بطلب معلق! (${typeLabel})</b>\n\n` +
                                      `🧾 <b>رقم الطلب:</b> <code>${tx.customId || tx._id}</code>\n` +
                                      `${clientInfo}\n` +
                                      `📞 <b>الرقم/الحساب:</b> <code>${tx.vodafoneNumber || tx.accountNumber || '---'}</code>\n` +
                                      `💵 <b>المبلغ:</b> ${tx.amount} EGP\n` +
                                      `${executorInfo}\n` +
                                      `━━━━━━━━━━━━━━\n` +
                                      `⚠️ العميل يطلب استعجال التنفيذ.`;

                const adminBotAPI = new Telegram(process.env.ADMIN_BOT_TOKEN);
                const admins = await Admin.find({});
                const adminIds = new Set(admins.map(a => a.telegramId));
                if (process.env.ADMIN_TELEGRAM_ID) adminIds.add(process.env.ADMIN_TELEGRAM_ID);

                for (const adminId of adminIds) {
                    await adminBotAPI.sendMessage(adminId, adminReminder, { parse_mode: 'HTML' }).catch(()=>{});
                }

                await ctx.reply('✅ تم إرسال التذكير بنجاح لجميع مديري المنظومة.');

            } catch (e) { ctx.answerCbQuery('❌ حدث خطأ أثناء التذكير.'); }
        });

        bot.hears('👤 حسابي', async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            try {
                let name, phone, idDisplay, balance, tier, joinDate, targetId;
                
                const set = await Settings.findOne({}) || await Settings.create({});

                if (isMainBot) {
                    const user = await User.findOne({ telegramId });
                    if (!user) return;
                    name = user.name; phone = user.phone; idDisplay = user.telegramId;
                    balance = user.balance; 
                    tier = user.tier || 1; joinDate = user.createdAt; targetId = { userId: telegramId, clientBotId: null };
                } else {
                    const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                    if (!emp) return;
                    const company = await ClientBot.findById(botData._id);
                    name = emp.name; phone = emp.phone; idDisplay = emp.telegramId;
                    balance = company.balance; 
                    tier = company.tier || 1; joinDate = emp.createdAt; targetId = { clientBotId: botData._id };
                }

                const totalTxs = await Transaction.aggregate([
                    { $match: { ...targetId, status: 'completed' } },
                    { $group: { _id: null, total: { $sum: "$costLYD" } } }
                ]);
                const totalTransferred = totalTxs.length > 0 ? totalTxs[0].total.toFixed(2) : "0.00";

                let currentRate = set.rateLevel1 || 6.40;
                if (tier === 2) currentRate = set.rateLevel2 || 6.45;
                if (tier === 3) currentRate = set.rateLevel3 || 6.50;

                const availableFunds = balance.toFixed(2);
                const joinDateStr = joinDate.toLocaleDateString('en-GB');

                const cardMessage = 
                    `🪪 <b>بـطـاقـة تـعـريـف عـمـيـل (VIP)</b>\n` +
                    `━━━━━━━━━━━━━━\n` +
                    `👤 <b>الاسم:</b> ${name}\n` +
                    `📱 <b>الهاتف:</b> ${phone}\n` +
                    `🆔 <b>رقم الحساب:</b> <code>${idDisplay}</code>\n` +
                    `📅 <b>تاريخ الانضمام:</b> ${joinDateStr}\n` +
                    `━━━━━━━━━━━━━━\n` +
                    `💱 <b>سعر الصرف المعتمد الأساسي:</b> ${currentRate}\n` + 
                    `💰 <b>الرصيد الحالي:</b> ${availableFunds} دينار\n` +
                    `📤 <b>إجمالي المحول:</b> ${totalTransferred} دينار\n` +
                    `━━━━━━━━━━━━━━\n` +
                    `🎧 <b>للتواصل والدعم:</b> ${set.supportContact || '@AhramSupport'}\n` +
                    `✨ <i>شكراً لثقتكم في شركة الأهرام الرقمية</i>`;

                await ctx.reply(cardMessage, { parse_mode: 'HTML' });
            } catch (error) { ctx.reply('❌ خطأ في عرض البيانات.'); }
        });

        bot.hears('💸 تحويل فودافون كاش (مصر)', async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            if (isMainBot) {
                const user = await User.findOne({ telegramId });
                if (!user || user.status !== 'active') return ctx.reply('⛔️ حسابك غير مفعل.');
                ctx.scene.enter('TRANSFER_SCENE', { isMainBot, botData });
            } else {
                const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                if (!emp || emp.status !== 'active') return ctx.reply('⛔️ حسابك غير مفعل.');
                ctx.scene.enter('TRANSFER_SCENE', { isMainBot, botData });
            }
        });

        bot.hears('📮 تحويل بريد', async (ctx) => {
            const telegramId = ctx.from.id.toString();
            const isMainBot = botData.name === 'البوت الرئيسي';
            if (isMainBot) {
                const user = await User.findOne({ telegramId });
                if (!user || user.status !== 'active') return ctx.reply('⛔️ حسابك غير مفعل.');
                ctx.scene.enter('POST_TRANSFER_SCENE', { isMainBot, botData });
            } else {
                const emp = await ClientEmployee.findOne({ telegramId, clientBotId: botData._id });
                if (!emp || emp.status !== 'active') return ctx.reply('⛔️ حسابك غير مفعل.');
                ctx.scene.enter('POST_TRANSFER_SCENE', { isMainBot, botData });
            }
        });

        // 🟢 الاستماع لزر الدعم الفني
        bot.hears('🎧 الدعم الفني وتواصل معنا', (ctx) => {
            const isMainBot = botData.name === 'البوت الرئيسي';
            ctx.scene.enter('SUPPORT_SCENE', { botData, isMainBot });
        });

        bot.hears('📁 التقارير', (ctx) => {
            ctx.reply('📊 <b>استخراج كشف حساب (Excel)</b>\nالرجاء تحديد نوع الكشف المطلوب من القائمة:', {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📅 كشف اليوم الحالي', 'gen_report_daily')],
                    [Markup.button.callback('📆 كشف الشهر بالكامل', 'gen_report_monthly')]
                ])
            });
        });

        bot.action(/gen_report_(daily|monthly)/, async (ctx) => {
            try {
                await ctx.answerCbQuery('⏳ جاري إعداد التقرير، لحظات...').catch(() => {});
                const type = ctx.match[1];
                await generateClientExcel(ctx, botData, type);
            } catch (error) {
                console.error(error);
            }
        });

        bot.launch().then(() => {
            console.log(`[Client Bot] ${botData.name} is running 🚀`);
            bot.telegram.setMyCommands([
                { command: 'start', description: '🏠 القائمة الرئيسية (تحديث)' },
                { command: 'web', description: '🌐 تفعيل حساب الموقع الإلكتروني' }
            ]).catch(()=>{});
        });
        
        activeClientBots.set(botData.token, bot);
    } catch (error) { console.error(error); }
};

const startAllClientBots = async () => {
    try {
        if (process.env.CLIENT_BOT_TOKEN) launchClientBot({ name: 'البوت الرئيسي', token: process.env.CLIENT_BOT_TOKEN });
        const bots = await ClientBot.find({ status: 'active' });
        bots.forEach(botData => launchClientBot(botData));
        cron.schedule('59 23 * * *', () => sendDailyReportsToAll(), { timezone: 'Africa/Tripoli' });
    } catch (error) { console.error(error); }
};

module.exports = { startAllClientBots, launchClientBot, checkAndSendDelayedReport, handleManualCloseReports };