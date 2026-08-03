# توثيق تحديثات 2026-08-03

## نطاق التحديث

- تفعيل التوجيه التلقائي للمعاملات الجديدة إلى المنفذ المحدد في إعدادات المنظومة عند تشغيل الخيار.
- إرسال معاملات API إلى المنفذ المختار تلقائيا.
- عند استلام الرقم المرجعي من مزود API تتحول العملية إلى ناجحة مباشرة بدون انتظار.
- تسجيل قيد رصيد المنفذ عند نجاح عملية API، مع حفظ الرقم المرجعي وبيانات المزود داخل تفاصيل العملية.
- توليد إيصال عربي منسق واحترافي للعمليات الملغية مع رقم إلغاء مستقل وبيانات الإرجاع.
- إضافة صفحة الحركات المالية لعرض كل حركات دفتر الأستاذ مع البحث، الفلاتر، الإحصائيات، التصدير، وعرض التفاصيل.
- إضافة اختبارات تغطي التوجيه التلقائي وسلوك نجاح API الفوري عند وصول الرقم المرجعي.

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

- Test Suites: 6 passed, 6 total
- Tests: 27 passed, 27 total
- Snapshots: 0 total

## ملاحظات تشغيل

- لا يوجد انتظار بعد وصول الرقم المرجعي من مزود API؛ العملية تتحول إلى ناجحة فورا.
- صفحة الحركات المالية تعتمد على بيانات `Ledger` وتربط الحركة بالعملية الأصلية عند توفر `customId`.
- إيصال الإلغاء يحفظ داخل مسار الإثباتات ويرتبط بالعملية كصورة إثبات/تسوية.
