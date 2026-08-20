# دليل نشر إصلاحات P0 الأمنية

هذا الدليل مخصص لنشر إصلاحات المرحلة الحرجة دون كسر مسار العمل الحالي. لا يعني نجاحه أن جميع متطلبات الجاهزية الإنتاجية اكتملت؛ فهو بوابة إلزامية قبل النشر فقط.

## 1. الشروط المسبقة

- نسخة احتياطية حديثة ومشفرة من MongoDB، مع تسجيل مكانها ووقت إنشائها.
- إمكانية الرجوع إلى رقم Commit سابق معروف أنه يعمل.
- MongoDB يعمل كـ Replica Set أو Sharded Cluster؛ وضع Standalone مرفوض للعمليات المالية.
- ملف `.env` موجود على الخادم فقط، غير متتبع في Git، وصلاحيته مقيدة لحساب الخدمة.
- مفاتيح JWT والجلسة وOTP وWeb Push وWhatsApp حقيقية ومختلفة، وليست قيمًا تجريبية.
- لا توجد عملية مالية يدوية أو تسوية جارية أثناء نافذة النشر.

## 2. فحص ما قبل النشر

نفذ من مجلد المشروع على الخادم:

```powershell
git status --short
git rev-parse --short HEAD
node scripts/repairProductionEnv.js .env
node scripts/auditProductionEnv.js .env
node scripts/checkMongoTransactionSupport.js .env
node scripts/migrateTenantIsolation.js
```

الأمران `repairProductionEnv` و`migrateTenantIsolation` في هذه المرحلة للمعاينة فقط ولا يكتبان أي تغيير. يجب أن ينجح فحص البيئة وفحص معاملات MongoDB قبل المتابعة.

## 3. النسخ الاحتياطي

مثال عند استخدام MongoDB محلي مع أدوات MongoDB Database Tools:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
mongodump --uri $env:MONGO_URI --archive="backup-$stamp.archive" --gzip
Get-FileHash "backup-$stamp.archive" -Algorithm SHA256
```

انقل النسخة إلى موقع منفصل ومشفر. لا تعتبر النسخة صالحة قبل اختبار استعادتها دوريًا على بيئة Staging معزولة.

## 4. تطبيق التحديث

```powershell
git fetch origin
git checkout main
git pull --ff-only origin main
npm ci --omit=dev
node scripts/repairProductionEnv.js .env --apply
node scripts/ensureWebPushKeys.js
node scripts/auditProductionEnv.js .env
node scripts/checkMongoTransactionSupport.js .env
node scripts/migrateTenantIsolation.js --apply --create-default
pm2 reload ecosystem.config.js --env production --update-env
pm2 save
```

لا تستخدم `||` داخل Windows PowerShell القديم. إذا فشل `pm2 reload`، نفذ `pm2 start ecosystem.config.js --env production` كأمر منفصل بعد مراجعة سبب الفشل.

## 5. التحقق بعد النشر

```powershell
pm2 status
pm2 logs --lines 100
curl.exe -fsS https://ahrampay.com/health
node scripts/auditProductionEnv.js .env
node scripts/checkMongoTransactionSupport.js .env
```

اختبارات القبول اليدوية المطلوبة:

1. تسجيل دخول إداري وعميل ومنفذ، والتأكد من رفض OTP الخاطئ.
2. تحديث Refresh Token مرة واحدة، والتأكد من رفض إعادة استخدام الرمز القديم.
3. إنشاء تحويل تجريبي محدود، ثم التحقق من الخصم والقيد والإيصال مرة واحدة فقط.
4. محاولة إرسال العملية نفسها مجددًا والتأكد من منع التكرار.
5. تجربة إلغاء/عكس العملية والتأكد من إنشاء قيد عكسي بدل تعديل القيد الأصلي.
6. التأكد من عدم قدرة حساب تابع لمؤسسة على قراءة بيانات مؤسسة أخرى.

## 6. معايير الإيقاف والرجوع

ابدأ الرجوع فورًا عند حدوث أي مما يلي:

- فشل فحص معاملات MongoDB.
- اختلاف الرصيد عن Ledger أو ظهور قيد غير متوازن.
- ارتفاع أخطاء HTTP 5xx أو فشل تسجيل الدخول العام.
- تسرب بيانات بين المؤسسات.
- تكرار خصم أو تنفيذ عملية مالية.

الرجوع إلى الإصدار السابق:

```powershell
$previousSha = '<LAST_KNOWN_GOOD_SHA>'
git fetch origin
git checkout --detach $previousSha
npm ci --omit=dev
pm2 reload ecosystem.config.js --env production --update-env
```

حقول `tenantId` التي تضيفها الهجرة توسعية ولا تحتاج إلى حذفها عند رجوع الكود. لا تستعد نسخة قاعدة البيانات تلقائيًا إلا إذا ثبت أن هجرة البيانات نفسها أتلفت بيانات، وبعد موافقة مالية وإدارية موثقة.

## 7. الأدلة التي تحفظ مع كل نشر

- SHA الإصدار السابق والجديد.
- نتيجة CI والاختبارات الأمنية.
- نتيجة فحص البيئة ومعاملات MongoDB.
- وقت النسخة الاحتياطية وSHA-256 الخاص بها.
- نتائج اختبارات القبول الستة.
- اسم منفذ النشر ووقت البدء والانتهاء.
- أي قرار رجوع أو قبول مخاطر مع صاحبه وسببه.
