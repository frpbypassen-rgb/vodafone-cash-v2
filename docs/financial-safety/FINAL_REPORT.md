# التقرير النهائي — PR #76

مسودة فقط. لا دمج، لا نشر، لا ترحيل على قاعدة حقيقية، لا فهرس فريد، ولا تفعيل أي علم في القيم الافتراضية.

كل بند أدناه إما **VERIFIED** (اختبار شُغّل في هذه البيئة) أو **OPERATOR-TO-RUN** (يحتاج وصول إنتاج أو Staging). لا أرقام إنتاج في هذا الملف.

## قرارات المشغّل

1. لا حساب مقاصة في هذا الطلب. التحويل الخارجي يبقى خصمًا من طرف واحد. المقاصة مشروع محاسبة لاحق.
2. المنظومة منظمة واحدة. `TENANT_MODE=single` هو الوضع الصحيح لأهرام باي.
3. تحويل الشركة↔الوكيل بكود الحساب يبقى مسموحًا كما هو.
4. الخزينة والإدارة والمنفذ يحركون الحسابات حسب الصلاحيات الحالية. المسارات لم تُعاد توجيهها.
5. حواجز عزل المنظمات المتعددة تبقى مطفأة افتراضيًا ولا تُفعَّل في الإنتاج. `FINANCIAL_TENANT_GUARD` و`FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` بلا أثر في وضع `single` حتى لو ضُبطا على `true`.
6. لا دمج ولا نشر من هذا العمل.

العنوان السابق الذي يوحي بأن سلوك الإنتاج لا يتغير إطلاقًا غير دقيق. حركة التحويل المشروع لا تتغير والأعلام مطفأة. ما يبقى فعالًا بلا أعلام: إلحاق `AuditLog` في الإنتاج، وتوسيع حجب الأسرار، وختم `tenantId` الاختياري. التفاصيل في `07-active-without-flags.md`.

## Redis وRedlock

### كيف يُقرأ الإعداد — VERIFIED (قراءة الكود)

`config/redis.js` دالة `initRedis`:

- العنوان من `REDIS_URL` أو `REDIS_URI`. لا قيمة افتراضية لعنوان.
- `REDIS_ENABLED` بقيمة `0` / `false` / `no` / `off` يوقف Redis ويستخدم ذاكرة العملية، إلا إذا كان `distributedStateRequired()` صحيحًا فيرمي عند الإقلاع: لا يُعطَّل Redis حين يكون مطلوبًا.
- بلا عنوان وRedis غير مطلوب: `MemoryCache` و`isRedis()` ترجع `false`.
- بلا عنوان وRedis مطلوب: رمي، ثم `app.js` عند فشل `Promise.all([connectDB(), initRedis()])` يستدعي `process.exit(1)` (حوالي السطر 545).
- فشل الاتصال والعنوان موجود: نفس القاعدة. المطلوب يرمي، وغير المطلوب يسقط إلى الذاكرة.
- `isRedis()` تبقى `true` بعد انقطاع لاحق. الإقلاع الناجح لا يثبت أن Redis ما زال حيًا.

`config/runtimeScale.js` دالة `distributedStateRequired`: صحيحة إذا `NODE_ENV=production`، أو `REDIS_REQUIRED` بقيمة صادقة، أو `CLUSTER_MODE` صادق، أو `APP_INSTANCE_COUNT` / `WEB_CONCURRENCY` / `PM2_INSTANCES` أكبر من 1.

`services/lockService.js` دالة `acquireLock`: إذا كان Redis مطلوبًا ولم يُمرَّر `allowMemoryFallback`، غياب Redis يرمي `REDIS_NOT_CONFIGURED` وفشل Redlock يرمي `REDIS_LOCK_FAILED`. هذا مسار قديم على الموبايل.

`/health/ready` في `app.js` يفحص Redis فقط عندما `REDIS_REQUIRED` صادق: `redisReady = !redisRequired || isRedis()`. الجاهزية وحدها لا تثبت أن Redis يعمل.

### ماذا يحدث لأشكال إعداد الإنتاج — VERIFIED (منطق الكود، بلا اتصال إنتاج)

| الشكل | عند الإقلاع | تحويل ويب / رصيد داخلي والأعلام مطفأة |
| --- | --- | --- |
| `NODE_ENV=production` وعنوان Redis يعمل | يتصل. `isRedis()` صحيحة | يكمل. لا قفل محفظة جديد |
| `NODE_ENV=production` بلا عنوان أو الاتصال يفشل | العملية تخرج. هذا سلوك `main` | العملية لا تخدم طلبات |
| Redis مطلوب (`REDIS_REQUIRED` أو أكثر من نسخة) بلا عنوان | نفس الخروج | لا خدمة |
| ليس إنتاجًا وRedis غير مطلوب وبلا عنوان | ذاكرة العملية | يكمل |
| Redis سقط بعد إقلاع ناجح | العملية تبقى. `isRedis()` قد تبقى صحيحة | تحويل الويب يكمل لأن `FINANCIAL_REDIS_FAIL_CLOSED` مطفأ. قفل الموبايل القديم قد يرفض |

الرفض الجديد قبل الخصم (قفل `wallet:${accountId}` ورمز `REDIS_LOCK_FAILED` بحالة 503) موجود فقط إذا `FINANCIAL_REDIS_FAIL_CLOSED` صادق **و** `distributedStateRequired()`. الافتراضي OFF. إذا الإنتاج بلا Redis حي بعد الإقلاع، أول نشر لا يوقف تحويل الويب ولا الرصيد الداخلي.

### فحص إنتاج للقراءة فقط — OPERATOR-TO-RUN

المجلد: `C:\Users\Administrator\Desktop\vodafone-cash-v2`. إذا اختلف المسار الفعلي فاستبدله. لا تطبع قيم `URI` أو `URL` أو `SECRET` أو `PASSWORD` أو `KEY`. لا تستخدم اسم المتغير `$pid`.

```powershell
$appRoot = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
Set-Location $appRoot
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '^\s*([A-Za-z0-9_]+)=(.*)$') { return }
    $name = $Matches[1]
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    $secret = $name -match 'URI|URL|SECRET|PASSWORD|KEY|TOKEN|DSN'
    if ($secret) {
        if ([string]::IsNullOrEmpty($value)) { '{0}=ABSENT' -f $name } else { '{0}=SET length={1}' -f $name, $value.Length }
    } elseif ($name -match '^(NODE_ENV|TENANT_MODE|REDIS_REQUIRED|REDIS_ENABLED|MONGO_TRANSACTIONS_REQUIRED|PORT|DEFAULT_TENANT_SLUG)$' -or $name -like 'FINANCIAL_*' -or $name -eq 'ALLOW_ACCOUNT_CODE_TENANT_INDEX') {
        '{0}={1}' -f $name, $value
    }
}
node -e "require('dotenv').config(); const url=process.env.REDIS_URL||process.env.REDIS_URI; if(!url){ console.log('REDIS_UNREACHABLE'); process.exit(2);} const Redis=require('ioredis'); const client=new Redis(url,{maxRetriesPerRequest:1,connectTimeout:3000,lazyConnect:true,retryStrategy:()=>null}); client.on('error',()=>{}); client.connect().then(()=>client.ping()).then((value)=>{ console.log('REDIS_PING', value); return client.quit(); }).catch(()=>{ console.log('REDIS_UNREACHABLE'); process.exit(1); });"
```

المخرجات المسموحة: `NODE_ENV=...` و`TENANT_MODE=...` و`REDIS_REQUIRED=...` و`REDIS_URL=SET length=N` أو `ABSENT` و`REDIS_PING PONG` أو `REDIS_UNREACHABLE`. لا رسالة خطأ من العميل (قد تحتوي العنوان).

### إثبات قبل الخصم — VERIFIED

على `MongoMemoryReplSet` في `tests/financialTenantSafety.test.js`:

- `REDIS_REQUIRED=true` و`FINANCIAL_REDIS_FAIL_CLOSED=true`: التحويل يرمي `REDIS_LOCK_FAILED` بحالة 503، ورصيدا الطرفين كما كانا قبل الاستدعاء.
- `REDIS_REQUIRED=true` والعلم محذوف: تحويل بمبلغ 2 ينجح والرصيدان يتغيران بمقدار 2.
- العلم مطفأ هو الافتراضي. لا يُقلب في هذا الطلب.

## معاملات MongoDB

### تراجع منتصف العملية — VERIFIED

الخادم في الاختبار `MongoMemoryReplSet` بنسخة واحدة ومحرك `wiredTiger` (replica set حقيقي في الذاكرة، وليس `MongoMemoryServer` المستقل).

- فشل `Ledger.create` برمز `LEDGER_WRITE_FAILED`: الرصيدان يعودان، وعدد `Ledger` وعدد `AuditLog` كما كانا. التدقيق لم يُكتب لأن `logAction` يأتي بعد القيد، والعلم `FINANCIAL_AUDIT_IN_TRANSACTION` مطفأ (سلوك `main`: التدقيق خارج الجلسة).
- فشل `Transaction.create`: الرصيدان يعودان.
- `FINANCIAL_AUDIT_IN_TRANSACTION=true` داخل الاختبار فقط، ثم `AuditLog.save` ينجح داخل الجلسة ثم يرمي: الرصيد والقيد والتدقيق تعود كلها. هذا هو إثبات التراجع الكامل للتدقيق، وهو غير مفعّل في الافتراضي.

### Mongo مستقل بلا معاملات — VERIFIED

`requiresMongoTransactions()` في `services/walletService.js` صحيحة فقط إذا لم يكن مسار الطوارئ مفعّلًا، و(`NODE_ENV===production` أو `MONGO_TRANSACTIONS_REQUIRED=true`). هذا الشرط موجود على `main`. هذا الفرع لا يوسّعه.

اختبار «standalone MongoDB outside production»: `NODE_ENV=test` و`MONGO_TRANSACTIONS_REQUIRED` محذوف و`replSetGetStatus` يرجع `null`. التحويل بمبلغ 3 ينجح. إذن غياب replica set خارج الإنتاج لا يكسر التحويل.

إذا كان الإنتاج `NODE_ENV=production` أو `MONGO_TRANSACTIONS_REQUIRED=true` وMongo مستقل، الرفض قبل الخصم (`FINANCIAL_TRANSACTIONS_UNAVAILABLE` بحالة 503) سلوك `main` السابق، وليس رفضًا جديدًا. الاختبار «missing MongoDB transactions block the debit» يثبت هذا عندما العلم `MONGO_TRANSACTIONS_REQUIRED=true`.

### حالة replica set على الإنتاج — OPERATOR-TO-RUN

```powershell
Set-Location 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
mongosh $env:MONGO_URI --quiet --eval "const hello=db.adminCommand({hello:1}); const capable=Boolean(hello.setName)||hello.msg==='isdbgrid'; print('setName='+(hello.setName||'')); print('msg='+(hello.msg||'')); print('transactionsCapable='+capable);"
```

`transactionsCapable=true` يعني replica set أو `mongos`. لا تطبع سلسلة الاتصال.

## جرد من يكتب أو يحذف AuditLog

### VERIFIED (بحث المستودع + اختبار الإلحاق)

| الموضع | السطور | ماذا يفعل |
| --- | --- | --- |
| `services/auditService.js` | 173–174 | `new AuditLog` ثم `save` لمستند جديد فقط |
| `models/AuditLog.js` | 90 | `installAppendOnlyGuards` يمنع في `NODE_ENV=production` عمليات `updateOne` و`updateMany` و`findOneAndUpdate` و`replaceOne` و`deleteOne` و`deleteMany` و`findOneAndDelete` وحفظ مستند موجود |
| `scripts/backfillFinancialTenantId.js` | 152 | `Model.collection.updateOne` على السائق الأصلي، يختم `tenantId` فقط، ويتجاوز الخطافات. يعمل مع `--apply` فقط |
| `scripts/factoryReset.js` | 36 و65 | الاسم `auditlogs` ثم `dropCollection` عبر السائق الأصلي. أداة مسح كاملة وليست مسار طلب |
| `tests/financialRecordImmutability.test.js` | 45–47 | يتوقع أن `deleteMany` و`updateMany` يرميان `FINANCIAL_RECORD_IMMUTABLE` في الإنتاج |
| `tests/financialTenantSafety.test.js` | 670–671 | `AuditLog.create` لصفوف اختبار التعبئة فقط |
| `routes/auditLog.js` | قراءة | `find` و`countDocuments` |
| `scripts/verifyAuditChain.js` | قراءة | `find` |
| `services/securityCommandCenterService.js` | قراءة | `find` |
| `services/adminReportService.js` و`liveOperationsService.js` و`businessPortalService.js` | قراءة | `find` |
| `routes/mobileApi.js` | 18 | استيراد غير مستخدم، بلا كتابة |
| `scripts/migrateTenantIsolation.js` | تعليق | لا يضم `AuditLog` في قائمة النماذج |

لا `expireAfterSeconds` على `AuditLog`. لا مستدعٍ لـ `bulkWrite` على هذا النموذج. `bulkWrite` والسائق الأصلي يتجاوزان الخطافات؛ لا مسار خدمة يستخدمهما لتعديل صف تدقيق.

الإلحاق يبقى مفعّلًا في الإنتاج بلا علم. لا مسار حي يعتمد على تعديل صف. التعبئة تستخدم السائق الأصلي عمدًا حتى لا يمنعها الإلحاق. `factoryReset` أداة تدمير ولا تُشغَّل مع النشر.

`Transaction` ليس ملحقًا فقط، لأن تحديث الحالة مطلوب.

## التجربة الجافة للترحيل

### أوامر Staging — OPERATOR-TO-RUN

لا تُشغَّل على الإنتاج. `--drop` على Staging فقط. لم تُشغَّل هذه الأوامر هنا، ولا يوجد اتصال بقاعدة حقيقية.

```powershell
$appRoot = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
Set-Location $appRoot
mongodump --uri "$env:MONGO_URI" --archive="$appRoot\backup\pre-tenant-safety.archive" --gzip
mongorestore --uri "$env:STAGING_MONGO_URI" --archive="$appRoot\backup\pre-tenant-safety.archive" --gzip --drop
$env:MONGO_URI = '<سلسلة Staging المستعادة من نسخة إنتاج حديثة>'
node scripts/backfillFinancialTenantId.js
node scripts/prepareAccountCodeTenantIndex.js
```

السكربتان افتراضيًا لا يكتبان. التعبئة تطبع JSON فيه لكل مجموعة `Transaction` و`Ledger` و`JournalEvent` و`AuditLog`:

```text
mode: dry-run
unchangedFields: balance, amount, status
collections.<Name>.summary.confident
collections.<Name>.summary.ambiguous
collections.<Name>.summary.unresolvable
collections.<Name>.summary.modified   # يجب أن يبقى 0 في التجربة الجافة
```

الصف الغامض لا يُخمن ولا يُسند إلى المنظمة الافتراضية. `--apply` لا يُستخدم إلا بعد مراجعة الناتج، ومع `--checkpoint`. الفهرس `account_code_tenant_code_unique` لا يُنشأ إلا إذا اجتمعت: `--apply` و`ALLOW_ACCOUNT_CODE_TENANT_INDEX=true` وصفر تكرار. الفهرس الفريد الحالي على `code` لا يُحذف. لا يُنشأ الفهرس في هذا الطلب.

### ناتج القاعدة المقلَّدة — VERIFIED

ليست إنتاجًا ولا Staging. الملف `docs/financial-safety/migration-dry-run-report.json` من تشغيل الاختبار في 2026-09-26:

| المجموعة | confident | ambiguous | unresolvable | modified |
| --- | --- | --- | --- | --- |
| Transaction | 1 | 1 | 1 | 0 |
| Ledger | 1 | 1 | 0 | 0 |
| JournalEvent | 0 | 0 | 1 | 0 |
| AuditLog | 1 | 0 | 1 | 0 |

`mode` = `dry-run`. `unchangedFields` = `balance` و`amount` و`status`. الاختبار يؤكد أن رصيد الشركة ومبلغ العملية وحالتها لم يتغيرا بعد `--apply` على قاعدة الاختبار فقط.

`docs/financial-safety/account-code-index-scan.json`: `mode=scan` و`indexCreated=false` و`duplicates=0`. الفهرس العام الفريد على `code` لم يتغير.

## اختبارات والأعلام مطفأة — VERIFIED

`TENANT_MODE=single` وكل أعلام `FINANCIAL_*` و`REDIS_REQUIRED` و`MONGO_TRANSACTIONS_REQUIRED` محذوفة:

- شركة → وكيل: رصيد الشركة 400 يصبح 385 ثم 370 (المفتاح يُتجاهل فيُخصم مرة ثانية). الوكيل 20 يصبح 35 بعد الخصم الأول.
- وكيل → شركة: الوكيل 60 يصبح 51 والشركة 100 تصبح 109.
- الخزينة: `updateBalanceWithLedger` إيداع +30 ثم خصم −12. الرصيد 50 يصبح 68. قيدان مجموعهما 18.
- نقطة البيع والوكيل معًا رغم اختلاف `tenantId`: خصم 6 و5 داخل جلسة، مع قيدين.
- تمويل المنفذ: رصيد الموظف يصبح 25 ورصيد المجموعة ينقص. هذا المجمع خارج دفتر العميل.
- إلغاء عملية مكتملة: `costLYD` 8 يُرد مرة واحدة (10 تصبح 18). الاستدعاء الثاني `success=false` وقيد `REFUND` واحد.

## منع التكرار — VERIFIED

العلم `FINANCIAL_IDEMPOTENCY_ENABLED` يُضبط داخل الاختبار فقط. الافتراضي OFF، وفي الإنتاج اليوم إعادة الإرسال ما زالت تخصم. النموذج يرسل `Idempotency-Key` والخادم يتجاهله حتى يُشغَّل العلم.

- إعادة نفس المفتاح: `replayed=true` وخصم واحد ومستند واحد بالمفتاح.
- نفس المفتاح مع مبلغ مختلف: `IDEMPOTENCY_CONFLICT` بحالة 409 وبلا خصم ثانٍ.
- 24 طلبًا متطابقًا و12 متعارضًا على نفس المفتاح: مستند واحد، والفرق في الرصيد إما 3 أو 9.
- العلم محذوف: نفس المفتاح يُنفَّذ مرتين (خصم 1 ثم 1) وعدد المستندات بهذا المفتاح = 0.

## الإلغاء مرتين — VERIFIED

`reversalService.reverseTransaction` مرتين على عملية `completed` بـ `costLYD=20` ورصيد 80: الأولى تنجح والثانية `success=false`. الرصيد 100. قيد `REFUND` واحد. الاختبار المكرر والأعلام مطفأة (`costLYD=8`) بنفس النتيجة.

## انقطاع Redis وMongo في منتصف العملية — VERIFIED

- Redis: العلم `FINANCIAL_REDIS_FAIL_CLOSED` مع `REDIS_REQUIRED` يرفض قبل أي خصم. بلا العلم التحويل يكمل رغم `REDIS_REQUIRED` (لا عميل Redis في الاختبار، والقفل الجديد لا يُطلب).
- Mongo والمعاملات مطلوبة وأمر الإدارة يرجع `null`: رفض `FINANCIAL_TRANSACTIONS_UNAVAILABLE` قبل الخصم.
- فشل كتابة القيد أو العملية بعد بدء الخصم داخل الجلسة: الرصيد يعود.
- Mongo بلا معاملات خارج الإنتاج: التحويل يكمل (انظر أعلاه).

## المطابقة

### مجموعة الاختبار — VERIFIED

`docs/financial-safety/reconciliation-test.json` بعد `tests/financialTenantSafety.test.js`:

| الحقل | القيمة |
| --- | --- |
| النطاق | `User` + `ClientCompany` + `SubAccount` |
| openingWallet | 1900 |
| closingWallet | 3232 |
| balanceDelta | 1332 |
| seededCapital | 1297 |
| movement | 35 |
| openingLedger | 0 |
| closingLedger | 35 |
| ledgerDelta | 35 |
| drift | 0 |

المعادلة: `movement = balanceDelta - seededCapital` ثم `drift = movement - ledgerDelta`. رأس المال الافتتاحي هو رصيد الحساب عند إنشائه، لأن إنشاء الحساب لا يكتب قيدًا (كما في فتح الحساب). استُبعدت قيدا الاختبار الصناعيان `LEG-OK-1` (−1) و`MISSING-TX-SAFETY` (+5) لأنهما صُنعا لمصنّف التعبئة بلا حركة رصيد. `ExecutorGroup` و`Employee` مجمع منفصل لا يكتب `Ledger` للعميل، ولذلك خارج المجموع حتى لا يُختلق انحراف.

### إنتاج — OPERATOR-TO-RUN

قراءة فقط. لا تتوقع أن مجموع الأرصدة يساوي مجموع القيود إذا فُتحت حسابات برصيد قبل تغطية الدفتر. اطبع العدد والصافي، لا أسماء الحسابات.

```powershell
mongosh $env:MONGO_URI --quiet --eval @"
const specs = [
  ['users','User'],
  ['clientcompanies','ClientCompany'],
  ['subaccounts','SubAccount']
];
let mismatch = 0;
let net = 0;
for (const [coll, model] of specs) {
  const ledger = {};
  db.ledgers.aggregate([
    { `$match: { entityModel: model } },
    { `$group: { _id: '`$entityId', sum: { `$sum: '`$amount } } }
  ]).forEach((row) => { ledger[String(row._id)] = row.sum; });
  db.getCollection(coll).find({}, { balance: 1 }).forEach((doc) => {
    const gap = Number(doc.balance || 0) - Number(ledger[String(doc._id)] || 0);
    if (gap !== 0) { mismatch += 1; net += gap; }
  });
}
const broken = db.ledgers.aggregate([
  { `$match: { transactionId: /^BTR-/ } },
  { `$group: { _id: '`$transactionId', net: { `$sum: '`$amount } } },
  { `$match: { net: { `$ne: 0 } } },
  { `$count: 'n' }
]).toArray();
print('entityGaps=' + mismatch);
print('netGap=' + net);
print('internalTransfersNotZero=' + ((broken[0] && broken[0].n) || 0));
"@
```

استعلامات إضافية في `05-monitoring.md`. أرقام هذا القسم لا تُملأ من هنا.

## الاختباران الفاشلان على main — VERIFIED

أُعيد التشغيل على شجرة عمل منفصلة عند `527c782193433b9cd9c88d6f403d6f2eb1171817` مع ربط `node_modules` من المستودع. الملفان بلا فرق عن هذا الفرع (`git diff` فارغ).

الأمر: `npx jest tests/mobileConsolidation.test.js tests/mobileAuthContract.test.js --runInBand --forceExit`

النتيجة: مجموعتان فاشلتان، 2 اختبارات فاشلة، 28 ناجحة، من أصل 30. رمز الخروج 1.

| الاختبار | الفشل |
| --- | --- |
| `tests/mobileConsolidation.test.js` — Executor login signs executorGroupId and includes group info in context DTO | المتوقع 200 والواصل 500 |
| `tests/mobileAuthContract.test.js` — T014 & T015: POST /login should return official executor context only under context | تجاوز 5000ms |

مسار الدخول لم يُمس في هذا الفرع. `routes/mobileApi.js` تغيّر في خريطة أخطاء تحويل الرصيد فقط. الفشلان سابقان على `main` وليسا من هذا العمل.

## المجموعة الكاملة — VERIFIED

Node.js v22.14.0. `npx jest --forceExit --runInBand`:

- هذا الفرع: 184 مجموعة (182 ناجحة، 2 فاشلة). الاختبارات 1148 (1146 ناجحة، 2 فاشلة).
- `main` عند `527c7821` في القياس السابق على نفس الآلة: 183 مجموعة (181 ناجحة، 2 فاشلة). الاختبارات 1123 (1121 ناجحة، 2 فاشلة).
- الفرق: +25 اختبارًا ناجحًا. صفر فشل جديد.

`npm run lint` و`npm run typecheck` و`npm run check:architecture` خرجت بالرمز 0 في هذه الجولة.

لم يُفحص نموذج الويب في المتصفح. الترويسة `Idempotency-Key` تُرسل من الواجهة والخادم يتجاهلها حتى يُشغَّل العلم.

## قائمة الملفات

| الملف | سطر واحد |
| --- | --- |
| `app.js` | حقول أعلام معلوماتية في `/health/ready` دون تغيير شرط الجاهزية |
| `controllers/clientTransactionController.js` | ختم المنظمة ومنع التكرار وقفل المحفظة خلف الأعلام |
| `models/AccountCode.js` | `tenantId` اختياري وفهرس غير فريد |
| `models/AuditLog.js` | `tenantId` خارج الهاش، وحماية الإلحاق في الإنتاج |
| `services/financialSafety.js` | تعريف الأعلام، وكلها مطفأة، وعزل المنظمة بلا أثر في `single` |
| `services/accountCodeService.js` | حصر البحث بالمنظمة فقط عندما يكون الحارس فعالًا في `multi` |
| `services/balanceTransferService.js` | تحويل الرصيد: ختم، منع تكرار، قفل، تدقيق داخل الجلسة، وكلها خلف أعلام |
| `services/auditService.js` | حجب أسرار أوسع، و`holdLock`، و`tenantId` خارج `calculateHash` |
| `services/lockService.js` | `allowMemoryFallback` حتى لا يرفض المسار الجديد عند غياب Redis |
| `services/mobileWebParityService.js` | تمرير الطلب، والقفل محجوز مسبقًا لمسار الموبايل |
| `routes/mobileApi.js` | خريطة أخطاء تحويل الرصيد فقط |
| `src/Application/Services/TransferService.ts` | ختم `tenantId` وحارس المنظمة فقط إذا كان العلم فعالًا |
| `src/Application/Services/ReversalService.ts` | نسخ `tenantId` إلى قيد العكس |
| `public/js/client-workspace.js` | إرسال `Idempotency-Key` بلا أثر على الخادم حتى يُشغَّل العلم |
| `views/client/dashboard.ejs` | نفس الترويسة في لوحة العميل |
| `views/client/partials/company_portal_scripts.ejs` | نفس الترويسة في بوابة الشركة |
| `scripts/backfillFinancialTenantId.js` | تعبئة جافة افتراضيًا، ولا تكتب رصيدًا |
| `scripts/prepareAccountCodeTenantIndex.js` | فحص تكرار فقط إلا بشرطي `--apply` والعلم |
| `scripts/migrateTenantIsolation.js` | تحذير بعدم استخدامه على الدفتر أو التدقيق |
| `package.json` | سكربتا التعبئة والفحص، و`mongodb-memory-server` للاختبار فقط |
| `package-lock.json` | قفل اعتماد الاختبار |
| `tests/financialTenantSafety.test.js` | اختبارات العزل والذرية والمطابقة والأعلام المطفأة |
| `tests/financialRecordImmutability.test.js` | منع تعديل وحذف `AuditLog` في الإنتاج |
| `docs/financial-safety/*` | المراجعة بالعربية، ونواتج القاعدة المقلَّدة، وهذا التقرير |

## طرح تدريجي والرجوع

الأعلام تبقى غير معرّفة في أول نشر. لا تُنشأ الفهرس. لا `--apply` على التعبئة. لا `FINANCIAL_TENANT_GUARD` على أهرام باي.

ترتيب لاحق، كل خطوة بقرار منفصل وبعد فحص OPERATOR-TO-RUN:

1. `REDIS_PING PONG` ثم، إن رغبت، `FINANCIAL_REDIS_FAIL_CLOSED`.
2. `transactionsCapable=true` يبقى كما هو اليوم (`MONGO_TRANSACTIONS_REQUIRED=true` إن كان مضبوطًا أصلًا).
3. `FINANCIAL_IDEMPOTENCY_ENABLED` بعد التأكد أن الواجهة ترسل المفتاح. لا تشغّل `FINANCIAL_IDEMPOTENCY_REQUIRED` في نفس الخطوة.
4. `FINANCIAL_AUDIT_IN_TRANSACTION` بعد استقرار Redis، لأن قفل سلسلة التدقيق داخل الجلسة يرفض التحويل إذا فشل القفل.
5. التعبئة `--apply` على Staging أولًا. الفهرس المركب فقط بعد صفر تكرار.
6. حواجز `multi` لا تُشغَّل ما دامت المنظومة واحدة.

الرجوع على Windows بلا `git reset` وبلا force push. احفظ SHA قبل النشر، ثم أرجع بـ commit جديد:

```powershell
$appRoot = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
Set-Location $appRoot
git rev-parse HEAD | Tee-Object -FilePath "$appRoot\backup\previous-sha.txt"
# بعد النشر، للرجوع:
$previous = (Get-Content "$appRoot\backup\previous-sha.txt").Trim()
git revert --no-edit "$previous..HEAD"
pm2 restart Ahram_Core_API --update-env
```

إذا كان النشر commit واحدًا: `git revert --no-edit <sha-المنشور>`. احذف أي `FINANCIAL_*` أُضيف إلى البيئة إن وُجد. لا تحذف `Transaction` ولا `Ledger` ولا `AuditLog`. الحقل `tenantId` اختياري والكود القديم يتجاهله.

## تحقق بعد النشر — OPERATOR-TO-RUN

```powershell
$appRoot = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
Set-Location $appRoot
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3000/health/ready
$core = pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq 'Ahram_Core_API' } | Select-Object -First 1
$coreProcessId = $core.pid
$listen = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$listenProcessId = $listen.OwningProcess
"pm2=$coreProcessId listen=$listenProcessId match=$($coreProcessId -eq $listenProcessId)"
```

`/health` لا يفحص القاعدة. `/health/ready` يجب أن تكون `status=ok`. طابق معرّف عملية PM2 مع مستمع المنفذ 3000. ثم شغّل أمر المطابقة في القسم السابق. لا تطبع أسرارًا.
