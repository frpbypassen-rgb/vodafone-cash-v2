# توثيق تحديثات 2026-08-03

## نطاق التحديث

- تفعيل التوجيه التلقائي للمعاملات الجديدة إلى المنفذ المحدد في إعدادات المنظومة عند تشغيل الخيار.
- إرسال معاملات API إلى المنفذ المختار تلقائيا، ثم إبقاء العملية على قيد التنفيذ لمدة 25 ثانية بعد استلام الرقم المرجعي قبل تحويلها إلى ناجحة.
- توليد إيصال منسق للعمليات الملغية مع رقم إلغاء مستقل وبيانات الإرجاع.
- إضافة صفحة الحركات المالية لعرض كل حركات دفتر الأستاذ مع البحث، الفلاتر، الإحصائيات، التصدير، وعرض التفاصيل.
- إضافة اختبارات تغطي التوجيه التلقائي وسلوك تنفيذ API المؤجل.

## مسارات رئيسية

- صفحة الحركات المالية: `/financial-movements`
- تصدير الحركات المالية CSV: `/financial-movements/export.csv`
- إعدادات التوجيه التلقائي: تعتمد على `autoRouteEnabled` و `autoRouteBotId` داخل إعدادات المنظومة.

## التحقق المنفذ

تم تشغيل الفحوصات التالية بنجاح:

```powershell
node --check app.js
node --check routes\financialMovements.js
node --check services\cancellationReceiptService.js
node --check services\apiExecutionLifecycleService.js
node --check services\autoRouteService.js
```

تم التحقق من قوالب الواجهة:

```powershell
node -e "const fs=require('fs'); const ejs=require('ejs'); ejs.compile(fs.readFileSync('views/financial_movements.ejs','utf8'), {filename:'views/financial_movements.ejs'}); ejs.compile(fs.readFileSync('views/partials/sidebar.ejs','utf8'), {filename:'views/partials/sidebar.ejs'}); console.log('views compiled')"
```

تم تشغيل اختبارات Jest المستهدفة:

```powershell
node node_modules\jest\bin\jest.js --runTestsByPath tests/transferService.test.js tests/controllers.test.js tests/reversalService.test.js tests/queueService.test.js tests/autoRouteService.test.js --runInBand
```

النتيجة:

- Test Suites: 5 passed, 5 total
- Tests: 26 passed, 26 total
- Snapshots: 0 total

## ملاحظات تشغيل

- مدة الانتظار قبل تحويل عملية API من قيد التنفيذ إلى ناجحة هي 25 ثانية افتراضيا.
- يمكن تعديل مدة الانتظار عبر متغير البيئة `API_COMPLETION_DELAY_MS`.
- صفحة الحركات المالية تعتمد على بيانات `Ledger` وتربط الحركة بالعملية الأصلية عند توفر `customId`.
