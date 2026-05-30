// bots/executor/scenes/financialClosingScene.js
const { Scenes } = require('telegraf');
const ExcelJS = require('exceljs');
const Transaction = require('../../../models/Transaction');
const Employee = require('../../../models/Employee');

const financialClosingWizard = new Scenes.WizardScene(
    'FINANCIAL_CLOSING_SCENE',
    async (ctx) => {
        if (ctx.scene.state.botData) {
            ctx.wizard.state.botData = ctx.scene.state.botData;
        }
        await ctx.reply(
            '📅 **استخراج ملف تقفيل مالي سابق**\n\nيرجى إدخال التاريخ المطلوب بالصيغة التالية (سنة-شهر-يوم)\nمثال: `2026-04-20`',
            { parse_mode: 'Markdown' }
        );
        return ctx.wizard.next();
    },
    async (ctx) => {
        const dateInput = ctx.message?.text;
        const botData = ctx.wizard.state.botData;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
            await ctx.reply('❌ صيغة التاريخ غير صحيحة. يرجى المحاولة مرة أخرى.');
            return ctx.scene.leave();
        }

        try {
            await ctx.reply(`⏳ جاري البحث عن السجلات وتوليد تقرير يوم ${dateInput}...`);

            const requestedDate = new Date(dateInput);
            const startOfDay = new Date(requestedDate.setHours(0, 0, 0, 0));
            const endOfDay = new Date(requestedDate.setHours(23, 59, 59, 999));

            const todayTx = await Transaction.find({
                executorBotId: botData._id,
                status: 'completed',
                updatedAt: { $gte: startOfDay, $lte: endOfDay }
            }).sort({ updatedAt: 1 });

            if (todayTx.length === 0) {
                await ctx.reply(`✅ لا توجد أي عمليات تحويل ناجحة مسجلة في تاريخ ${dateInput}.`);
                return ctx.scene.leave();
            }

            const totalToday = todayTx.reduce((sum, tx) => sum + tx.amount, 0);
            const previousTx = await Transaction.aggregate([
                { $match: { executorBotId: botData._id, status: 'completed', updatedAt: { $lt: startOfDay } } },
                { $group: { _id: null, sum: { $sum: "$amount" } } }
            ]);
            const previousTotal = previousTx.length > 0 ? previousTx[0].sum : 0;
            const adminDeposit = 0; 
            const currentTotal = previousTotal + totalToday + adminDeposit;

            const workbook = new ExcelJS.Workbook();
            const sheet = workbook.addWorksheet(`تقفيل ${dateInput}`);

            sheet.mergeCells('A1:E2');
            const titleCell = sheet.getCell('A1');
            titleCell.value = 'شركة الأهرام للخدمات الرقمية';
            titleCell.font = { size: 22, bold: true, color: { argb: 'FFFFFFFF' } };
            titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003366' } };
            titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

            sheet.mergeCells('A3:E3');
            sheet.getCell('A3').value = `تقرير التقفيل المستخرج - بوت: [ ${botData.name} ]`;
            sheet.getCell('A3').alignment = { horizontal: 'center' };
            sheet.getCell('A3').font = { bold: true };

            sheet.mergeCells('A4:E4');
            sheet.getCell('A4').value = `تاريخ التقرير المالي: ${dateInput}`;
            sheet.getCell('A4').alignment = { horizontal: 'center' };

            const firstTxId = todayTx[0].customId || todayTx[0]._id.toString();
            const lastTxId = todayTx[todayTx.length - 1].customId || todayTx[todayTx.length - 1]._id.toString();
            sheet.mergeCells('A5:E5');
            sheet.getCell('A5').value = `من عملية: ${firstTxId}  ---  إلى عملية: ${lastTxId}`;
            sheet.getCell('A5').alignment = { horizontal: 'center' };
            sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

            sheet.addRow([]);

            const headerRow = sheet.addRow(['رقم العملية', 'الوقت والتاريخ', 'رقم الهاتف', 'المبلغ (جنيه)', 'اسم الموظف']);
            headerRow.font = { bold: true };
            headerRow.alignment = { horizontal: 'center' };
            sheet.columns = [
                { key: 'id', width: 30 }, { key: 'date', width: 25 }, 
                { key: 'phone', width: 20 }, { key: 'amount', width: 15 }, { key: 'operator', width: 25 }
            ];

            // 🚀 البحث عن كل الموظفين لضمان ظهور الاسم الرسمي للموظف بدلاً من رقم الـ ID
            const allEmployees = await Employee.find();
            const empMap = {};
            allEmployees.forEach(e => empMap[e.telegramId] = e.name);

            todayTx.forEach(t => {
                const row = sheet.addRow([
                    t.customId || t._id.toString(), // 🚀 الرقم التسلسلي هنا
                    t.updatedAt.toLocaleString('ar-EG'),
                    t.vodafoneNumber,
                    t.amount,
                    empMap[t.operatorId] || t.operatorId || 'غير معروف'
                ]);
                row.alignment = { horizontal: 'center' };
            });

            sheet.addRow([]);
            sheet.addRow([]);

            const summaryStyle = { font: { bold: true, size: 12 }, alignment: { horizontal: 'right' } };
            
            const rowTotal = sheet.addRow(['', '', '', 'إجمالي اليوم:', `${totalToday} EGP`]);
            rowTotal.getCell(4).style = summaryStyle; rowTotal.getCell(5).style = summaryStyle;

            const rowPrev = sheet.addRow(['', '', '', 'القيمة السابقة:', `${previousTotal} EGP`]);
            rowPrev.getCell(4).style = summaryStyle; rowPrev.getCell(5).style = summaryStyle;

            const rowDep = sheet.addRow(['', '', '', 'إيداعات الإدارة:', `${adminDeposit} EGP`]);
            rowDep.getCell(4).style = summaryStyle; rowDep.getCell(5).style = summaryStyle;

            const rowCurr = sheet.addRow(['', '', '', 'المبلغ الحالي الكلي:', `${currentTotal} EGP`]);
            rowCurr.getCell(4).style = { font: { bold: true, size: 14, color: { argb: 'FF0000FF' } }, alignment: { horizontal: 'right' } };
            rowCurr.getCell(5).style = { font: { bold: true, size: 14, color: { argb: 'FF0000FF' } }, alignment: { horizontal: 'right' } };

            const buffer = await workbook.xlsx.writeBuffer();
            const fileName = `تقفيل_الأهرام_${dateInput}.xlsx`;

            await ctx.replyWithDocument(
                { source: buffer, filename: fileName },
                { caption: `📊 **ملف التقفيل ليوم ${dateInput}**\n\n✅ تم استخراج التقرير بنجاح.` }
            );

        } catch (err) {
            console.error('[Financial Closing Scene Error]:', err);
            await ctx.reply('❌ حدث خطأ أثناء استخراج التقرير.');
        }

        return ctx.scene.leave();
    }
);

module.exports = financialClosingWizard;