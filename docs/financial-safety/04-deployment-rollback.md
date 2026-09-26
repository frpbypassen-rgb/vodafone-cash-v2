# النشر والرجوع — Windows PowerShell

العملية: `Ahram_Core_API`. لا تستخدم اسم المتغير `$pid` (محجوز في PowerShell). لا `git reset` ولا force push على فرع الإنتاج. لا حذف `node_modules` أثناء تشغيل Node. لا تشغيل التعبئة على الإنتاج من هذه الوثيقة مباشرة.

المجلد أدناه مثال. استبدله بمسار النشر الفعلي.

```powershell
$appRoot = 'C:\Ahram\vodafone-cash-v2'
Set-Location $appRoot
```

## 1. نسخة احتياطية واستعادة تجريبية

خذ نسخة MongoDB بكل `oplog` إن أمكن، وانسخ مجلد النسخة إلى جهاز Staging. استعدها في قاعدة باسم مختلف. تأكد أن التطبيق على Staging يشير إلى القاعدة المستعادة وليس الإنتاج.

```powershell
mongodump --uri "$env:MONGO_URI" --archive="$appRoot\backup\pre-tenant-safety.archive" --gzip
# استعادة على Staging فقط، بعد تغيير اسم القاعدة في سلسلة الاتصال:
mongorestore --uri "$env:STAGING_MONGO_URI" --archive="$appRoot\backup\pre-tenant-safety.archive" --gzip --drop
```

`--drop` مسموح فقط على Staging. لا تشغّله على إنتاج.

## 2. تسجيل SHA الحالي

```powershell
git rev-parse HEAD | Tee-Object -FilePath "$appRoot\backup\previous-sha.txt"
Get-Content "$appRoot\backup\previous-sha.txt"
```

## 3. نشر متوافق والأعلام مطفأة

تأكد أن البيئة **لا** تعرّف هذه القيم على `true`:

`FINANCIAL_TENANT_GUARD` و`FINANCIAL_IDEMPOTENCY_REQUIRED` و`FINANCIAL_IDEMPOTENCY_STRICT_BINDING` و`FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` و`ALLOW_ACCOUNT_CODE_TENANT_INDEX`.

أبقِ `MONGO_TRANSACTIONS_REQUIRED=true`.

```powershell
git fetch origin
git checkout main
git pull origin main
pm2 restart Ahram_Core_API --update-env
```

## 4. الجاهزية لا الصحة فقط

`/health` لا يفحص القاعدة. `/health/ready` يفحص اتصال Mongo وجلسة المتجر وRedis عند `REDIS_REQUIRED`، ويعرض حالة الأعلام دون أن يفشل بسببها.

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

لا تكمل إذا كانت `status` غير `ok`.

## 5. تجربة التعبئة الجافة على Staging

```powershell
$env:MONGO_URI = '<سلسلة Staging المستعادة من نسخة إنتاج حديثة>'
node scripts/backfillFinancialTenantId.js
```

الافتراضي لا يكتب. راجع `confident` و`ambiguous` و`unresolvable`. الصف الغامض لا يُخمن.

## 6. مراجعة يدوية

اقرأ عينات `ambiguous` و`unresolvable` في الناتج. لا تشغّل `--apply` إذا كان الغموض يخص حسابات تتحرك بينها أموال اليوم.

## 7. تعبئة على دفعات مع حاجز

على Staging أولًا، وبعد الموافقة، على نافذة تشغيل متفق عليها. السكربت دفعات من 100 ويمتنع عن تعديل الرصيد والمبلغ والحالة. الكتابة عبر مجموعة Mongo الأصلية حتى لا يصطدم حارس الإلحاق في `AuditLog` و`Ledger`.

```powershell
node scripts/backfillFinancialTenantId.js --apply --checkpoint "$appRoot\backup\tenant-backfill-checkpoint.json"
```

إعادة التشغيل تكمل من الحاجز وتتخطى الصفوف التي أصبحت لها `tenantId`.

## 8. فحص التكرار قبل أي فهرس فريد

```powershell
node scripts/prepareAccountCodeTenantIndex.js
```

لا فهرس في هذه الخطوة. الفهرس اختياري وبعد صفر تكرار فقط:

```powershell
$env:ALLOW_ACCOUNT_CODE_TENANT_INDEX = 'true'
node scripts/prepareAccountCodeTenantIndex.js --apply
Remove-Item Env:ALLOW_ACCOUNT_CODE_TENANT_INDEX
```

## 9. تشغيل الأعلام ثم إيقافها بسرعة

```powershell
$env:FINANCIAL_TENANT_GUARD = 'true'
pm2 restart Ahram_Core_API --update-env
```

ابدأ بحسابات اختبار داخل المنظمة نفسها. راقب رفض `TENANT_UNRESOLVED` و`CROSS_TENANT_TRANSFER`.

## 10. توسيع تدريجي

بعد ساعة تشغيل نظيفة على حسابات الاختبار، أبقِ العلم لحركة أوسع. `FINANCIAL_IDEMPOTENCY_REQUIRED` لاحقًا بعد أن تصبح كل النماذج ترسل المفتاح. `FINANCIAL_IDEMPOTENCY_STRICT_BINDING` أخيرًا وبعد تصفير المفاتيح العالقة في الموبايل.

## 11. مطابقة قبل وبعد

نفّذ استعلامات `05-monitoring.md` قبل التعبئة وبعدها. مجموع القيود لكل تحويل داخلي يبقى صفرًا. رصيد الحساب يساوي أثر القيود منذ الرصيد الافتتاحي المعروف. لا يتغير `amount` ولا `status` بسبب التعبئة.

## 12. محفزات الرجوع الفوري

ارجع فورًا إذا: رصيد حساب لا يطابق دفتره، تحويل داخلي مجموعه لا يساوي صفرًا، خصم مكرر بنفس مفتاح ناجح، ارتفاع 503 `FINANCIAL_TRANSACTIONS_UNAVAILABLE` أو `REDIS_LOCK_FAILED`، أو رفض تحويل كان مقبولًا داخل المنظمة الواحدة.

## 13. الرجوع

```powershell
$previous = Get-Content "$appRoot\backup\previous-sha.txt"
git checkout $previous
pm2 restart Ahram_Core_API --update-env
Remove-Item Env:FINANCIAL_TENANT_GUARD -ErrorAction SilentlyContinue
Remove-Item Env:FINANCIAL_IDEMPOTENCY_REQUIRED -ErrorAction SilentlyContinue
Remove-Item Env:FINANCIAL_IDEMPOTENCY_STRICT_BINDING -ErrorAction SilentlyContinue
Remove-Item Env:FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH -ErrorAction SilentlyContinue
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

لا تحذف `Transaction` ولا `Ledger` ولا `AuditLog`. `tenantId` الزائد حقل اختياري. استعادة النسخة الاحتياطية هي رجوع البيانات، وتُجرَّب على Staging قبل أن تُعتبر خطة الرجوع جاهزة.
