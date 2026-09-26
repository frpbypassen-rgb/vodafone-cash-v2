# التحقق النهائي قبل قرار المشغّل

لا دمج ولا نشر. البند 4 (حساب مقاصة للتحويل الخارجي) **خارج النطاق**: لا يُبنى في الطلب #76. تحويل الخارج يبقى خصمًا من طرف العميل. أي مقاصة لاحقة قرار جديد لأنها تغيّر معنى الرصيد.

البنود 1–3 محسومة: منظومة واحدة، شركة↔وكيل مسموح، خصم نقطة البيع مع الرئيسي يبقى، الإدارة والخزينة والمنفذ يحركون أي حساب. علما العزل يبقيان مطفأين ولا يُطبَّقان إلا مع `TENANT_MODE=multi`.

## 1. Redis وجلسة Mongo

لا رفض جديد على تحويل ويب أو رصيد داخلي إذا غاب Redis أو تعذرت الجلسة بما يخالف `main`.

| المسار | ماذا يحدث والأعلام مطفأة | مقارنة بـ `main` |
| --- | --- | --- |
| تحويل ويب ورصيد داخلي وRedis غائب | `FINANCIAL_REDIS_FAIL_CLOSED` غير معرّف: لا قفل محفظة جديد ولا 503. | `main` لم يكن يقفل هذين المسارين. |
| تحويل الموبايل وRedis غائب في الإنتاج | `acquireLock` يرمي ويصبح الرد 429 `LOCK_TIMEOUT`. | نفس `main`. |
| جلسة Mongo غير متاحة والإنتاج يطلب المعاملات | 503 `FINANCIAL_TRANSACTIONS_UNAVAILABLE` قبل الخصم. | نفس `requiresMongoTransactions()` على `main`. |

الرفض الجديد لقفل المحفظة لا يعمل إلا مع `FINANCIAL_REDIS_FAIL_CLOSED=true`. لا تشغّله قبل الفحص.

على جهاز Windows، من مجلد التطبيق، ومن دون المتغير `$pid`:

```powershell
$appRoot = 'C:\Ahram\vodafone-cash-v2'
Set-Location $appRoot
Select-String -Path .env -Pattern '^(NODE_ENV|TENANT_MODE|MONGO_URI|MONGO_TRANSACTIONS_REQUIRED|REDIS_URL|REDIS_URI|REDIS_REQUIRED|REDIS_ENABLED|FINANCIAL_)='
node -e "require('dotenv').config(); const url=process.env.REDIS_URL||process.env.REDIS_URI; if(!url){ console.log('REDIS_URL missing'); process.exit(2);} const Redis=require('ioredis'); const client=new Redis(url,{maxRetriesPerRequest:1,connectTimeout:3000,lazyConnect:true}); client.connect().then(()=>client.ping()).then((value)=>{ console.log('REDIS_PING', value); return client.quit(); }).catch((error)=>{ console.error(error.message); process.exit(1); });"
mongosh $env:MONGO_URI --quiet --eval "const hello=db.adminCommand({hello:1}); const capable=Boolean(hello.setName)||hello.msg==='isdbgrid'; print('setName='+(hello.setName||'')); print('msg='+(hello.msg||'')); print('transactionsCapable='+capable);"
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

`REDIS_PING PONG` يعني Redis يجيب. `transactionsCapable=true` يعني replica set أو mongos. `/health/ready` يفحص Redis فقط إذا كان `REDIS_REQUIRED=true`، لذلك أمر `PING` هو الفحص المباشر.

## 2. AuditLog ملحق فقط

بُحث في المسارات والخدمات والمتحكمات والسكربتات وcron و`verifyAuditChain` ومركز الأمان عن `updateOne` و`updateMany` و`findOneAndUpdate` و`save` على مستند موجود و`deleteOne` و`deleteMany` و`findOneAndDelete` و`bulkWrite` وTTL.

الكتابة الحية الوحيدة هي `new AuditLog().save()` في `services/auditService.js`. القراءة في `routes/auditLog.js` و`verifyAuditChain.js` و`securityCommandCenterService.js` والتقارير. `migrateTenantIsolation.js` لا يضم النموذج. التعبئة تستخدم `collection.updateOne` على السائق الأصلي لختم `tenantId` فقط. `factoryReset.js` يسقط المجموعة بأداة تدمير وليست مسار تشغيل. لا `expireAfterSeconds` على النموذج. لا مستدعٍ لـ `bulkWrite`. الإلحاق في الإنتاج لا يكسر كاتبًا شرعيًا.

## 3. التجربة الجافة

على قاعدة اختبار مقلَّدة، ليست إنتاجًا ولا Staging. الملف `migration-dry-run-report.json`، الوضع `dry-run`، و`modified=0`:

| المجموعة | confident | ambiguous | unresolvable |
| --- | --- | --- | --- |
| Transaction | 1 | 1 | 1 |
| Ledger | 1 | 1 | 0 |
| JournalEvent | 0 | 0 | 1 |
| AuditLog | 1 | 0 | 1 |

فحص الفهرس `account-code-index-scan.json`: `mode=scan`، `indexCreated=false`، تكرار `tenantId+code` = 0، والفهرس الفريد العالمي على `code` لم يُحذف ولم يُستبدل.

أمر Staging المستعادة من نسخة إنتاج حديثة:

```powershell
$env:MONGO_URI = '<سلسلة Staging المستعادة>'
node scripts/backfillFinancialTenantId.js
node scripts/prepareAccountCodeTenantIndex.js
```

لا `--apply` قبل قراءة الناتج. الفهرس الفريد المركّب لا يُنشأ إلا بعد صفر تكرار ومع:

```powershell
$env:ALLOW_ACCOUNT_CODE_TENANT_INDEX = 'true'
node scripts/prepareAccountCodeTenantIndex.js --apply
Remove-Item Env:ALLOW_ACCOUNT_CODE_TENANT_INDEX
```

## 4. الأعلام كلها مطفأة

اختبارات `all financial flags off` مع `TENANT_MODE=single` نجحت: شركة بلا `tenantId` إلى وكيل بمنظمة مخزنة مختلفة (والمفتاح يُتجاهل فيُخصم مرة ثانية كما اليوم)، إيداع ثم خصم عبر `updateBalanceWithLedger`، خصم نقطة البيع والوكيل معًا رغم اختلاف `tenantId`، `fundExternalExecutor` يخفّض رصيد المجموعة ويزيد الموظف، والإلغاء يرد مرة واحدة فقط.

ما يبقى فعالًا بلا أعلام، بلا رفض لتحويل مشروع، في `07-active-without-flags.md`: إلحاق التدقيق، حجب الأسرار الأوسع، ختم `tenantId` الاختياري، وإرسال النموذج للمفتاح بينما الخادم يتجاهله.

## 5. المجموعة الكاملة

`npx jest --forceExit --runInBand` على Node 22.14.0: 185 مجموعة (183 ناجحة، 2 فاشلة)، 1155 اختبارًا (1153 ناجحة، 2 فاشلة).

`main` `527c7821`: 183 مجموعة (181 ناجحة، 2 فاشلة)، 1123 اختبارًا (1121 ناجحة، 2 فاشلة).

الفرق 25 اختبارًا ناجحًا عن `main` (1123 اختبارًا). الفشلان نفسهما: `tests/mobileConsolidation.test.js` و`tests/mobileAuthContract.test.js`. `npm run lint` و`npm run typecheck` و`npm run check:architecture` ناجحة. التقرير الجامع: `FINAL_REPORT.md`.
