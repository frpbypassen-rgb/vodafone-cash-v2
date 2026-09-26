# ما الذي يتغير وكل الأعلام الجديدة غير معرّفة؟

المقارنة مع `main` عند `527c7821`. «كل الأعلام مطفأة» يعني عدم تعريف:

`FINANCIAL_TENANT_GUARD` و`FINANCIAL_IDEMPOTENCY_ENABLED` و`FINANCIAL_IDEMPOTENCY_REQUIRED` و`FINANCIAL_IDEMPOTENCY_STRICT_BINDING` و`FINANCIAL_AUDIT_IN_TRANSACTION` و`FINANCIAL_REDIS_FAIL_CLOSED` و`FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` و`ALLOW_ACCOUNT_CODE_TENANT_INDEX`.

عنوان الطلب السابق «دون تغيير سلوك الإنتاج» ليس دقيقًا. الصفوف أدناه هي السلوك الفعلي في أول نشر.

## جدول السلوك

| التغيير | فعال بلا أعلام؟ | خطر الحركة الحية | يُغلَّف بعلم في أول نشر؟ |
| --- | --- | --- | --- |
| عزل المنظمة: رفض بحث/تحويل عبر `tenantId` | لا | لا رفض جديد. البحث العالمي يبقى. | نعم. `FINANCIAL_TENANT_GUARD` افتراضي OFF. |
| منع تكرار عند وجود `Idempotency-Key` (إعادة النتيجة أو 409) | لا | النموذج يرسل المفتاح، والخادم يتجاهله. لا 409 ولا قفل جديد. إعادة الإرسال ما زالت تخصم كما في `main`. | نعم. `FINANCIAL_IDEMPOTENCY_ENABLED` افتراضي OFF. `FINANCIAL_IDEMPOTENCY_REQUIRED` يفعّل المنع ويرفض غياب المفتاح. |
| نموذج الويب يرسل `Idempotency-Key` | نعم، الترويسة فقط | لا أثر على الرصيد ما دام العلم مطفأ. لا وسيط يرفض الترويسة. | لا. الإرسال المسبق يسمح بتشغيل العلم لاحقًا دون نشر واجهة ثانية. |
| قفل محفظة جديد على تحويل الويب والرصيد الداخلي، ورفض 503 إذا غاب Redis | لا | تحويل الويب والرصيد الداخلي على `main` لا يستدعيان `acquireLock`. رفض جديد كان سيوقف الحركة إذا كان Redis غائبًا أو سقط بعد الإقلاع. | نعم. `FINANCIAL_REDIS_FAIL_CLOSED` افتراضي OFF: لا قفل محفظة جديد ولا رفض. |
| قفل Redis في تحويل الموبايل (`TransferService.createTransfer` و`executeBalanceTransferIdempotent`) | نعم، وهو قديم | على `main` أصلًا: `acquireLock` وفي الإنتاج (`distributedStateRequired`) يرمي `REDIS_NOT_CONFIGURED` أو `REDIS_LOCK_FAILED` فيصبح الرد 429 `LOCK_TIMEOUT`. هذا الفرع لا يضيف رفضًا على هذا المسار. | لا تغيير. لا تُطفأ حماية كانت موجودة. |
| رفض غياب جلسة Mongo على تحويل الويب والرصيد الداخلي والموبايل | نعم، وهو قديم | `requiresMongoTransactions()` في `services/walletService.js` كان يرفض قبل الخصم على `main` عندما `NODE_ENV=production` أو `MONGO_TRANSACTIONS_REQUIRED=true`، ما لم يكن مسار الطوارئ مفعّلًا. هذا الفرع لا يوسّع الشرط. | لا. الإبقاء مطلوب حتى لا يُفتح مسار تعويض غير ذري في الإنتاج. |
| تدقيق تحويل الويب/الرصيد الداخلي داخل جلسة Mongo، و`required: true`، وقفل السلسلة يُفك بعد `commit` | لا | لو بقي داخل الجلسة، فشل `logAction` (ومنها قفل Redis) يُفسد المعاملة ويرفض تحويلًا كان ينجح على `main` مع تدقيق مفقود. | نعم. `FINANCIAL_AUDIT_IN_TRANSACTION` افتراضي OFF. التدقيق يبقى خارج الجلسة وقبل `commit`، والقفل يُفك داخل `logAction` كما في `main`. |
| `AuditLog` ملحق فقط في الإنتاج (منع update/delete عبر Mongoose) | نعم | لا يمس الرصيد. يفشل أي تعديل Mongoose على السجل في الإنتاج. البحث في المستودع لم يجد كاتبًا شرعيًا يعدّل الصف. | لا. لا يوجد مسار حي يعتمد على التعديل. التفاصيل في القسم التالي. |
| توسيع حجب الأسرار في التدقيق من لاحقة المفتاح إلى أي موضع يحتوي `password` أو `otp` أو `pin` أو `token` أو `secret` | نعم | لا يرفض تحويلًا. قد يُخفي من نص التدقيق حقلًا اسمه يحتوي هذه الكلمات حتى لو لم يكن سرًا. | لا. الحجب أوسع ولا يغيّر المبلغ. `tenantId` خارج `calculateHash` حتى تبقى السلسلة القديمة قابلة للتحقق. |
| ختم `tenantId` الاختياري على `Transaction` و`Ledger` و`JournalEvent` و`AuditLog` الجديدة | نعم | حقل يتجاهله الكود القديم. لا رفض إذا غابت المنظمة والعلم `FINANCIAL_TENANT_GUARD` مطفأ. | لا. الإضافة متوافقة مع الاتجاهين. |
| `ordered: true` عند `create` لمستندات متعددة داخل جلسة | نعم | لا يغيّر المعنى. يوافق Mongoose 9 حتى لا تفشل الكتابة المتعددة داخل الجلسة. | لا. |
| فشل تحويل الرصيد الداخلي في الإنتاج لا يحذف `Transaction`/`Ledger` تعويضًا | نعم، على مسار الفشل فقط | النجاح لا يتغير. في الإنتاج كان الشرط `requiresMongoTransactions` يمنع الاعتماد على الحذف أصلًا إذا بدأت الجلسة. إذا وقع خصم بلا جلسة يُرجَع 503 بدل الحذف. | لا. الحذف التعويضي للدفتر ممنوع في الإنتاج. |
| حقول إضافية في `/health/ready` | نعم | شرط `status` لم يتغير. الحقول للعرض فقط. | لا. |
| فهرس فريد `tenantId+code` | لا | لا يُنشأ عند الإقلاع. `autoIndex` معطّل في `config/database.js`. | نعم. السكربت `prepareAccountCodeTenantIndex.js` لا يكتب إلا مع `--apply` و`ALLOW_ACCOUNT_CODE_TENANT_INDEX=true` وبعد صفر تكرار. |

## AuditLog — نتيجة البحث

بُحث في المسارات والخدمات والمتحكمات والسكربتات ومهام cron وأدوات السلسلة ومركز الأمان عن: `updateOne` و`updateMany` و`findOneAndUpdate` و`save` على مستند موجود و`deleteOne` و`deleteMany` و`findOneAndDelete` و`bulkWrite` وفهرس TTL على `AuditLog`.

| الموضع | ماذا يفعل | هل يكسر الإلحاق؟ |
| --- | --- | --- |
| `services/auditService.js` | `new AuditLog` ثم `save` لمستند جديد فقط | لا |
| `routes/auditLog.js` | `find` و`countDocuments` | لا |
| `scripts/verifyAuditChain.js` | `find` للتحقق | لا |
| `services/securityCommandCenterService.js` | `find` | لا |
| `services/adminReportService.js` و`liveOperationsService.js` و`businessPortalService.js` | `find` | لا |
| `routes/mobileApi.js` | استيراد غير مستخدم، بلا كتابة | لا |
| `scripts/migrateTenantIsolation.js` | لا يضم `AuditLog` في قائمة النماذج | لا |
| `scripts/backfillFinancialTenantId.js` | `collection.updateOne` على السائق الأصلي لختم `tenantId` فقط، ويتجاوز خطافات Mongoose عمدًا | لا يمنع التعبئة |
| `scripts/factoryReset.js` | `dropCollection('auditlogs')` عبر السائق الأصلي. أداة تدمير كاملة وليست مسار تشغيل | يتجاوز الخطافات. لا يُشغَّل في النشر |
| فهارس TTL | لا يوجد `expireAfterSeconds` على `AuditLog` | لا |

لا كاتب شرعي يعدّل صف تدقيق أثناء الخدمة. الإلحاق يبقى بلا علم. `bulkWrite` لا يمر على خطافات Mongoose؛ لا مستدعٍ له على هذا النموذج.

## Redis

`initRedis` في `config/redis.js` يرمي عند الإقلاع إذا `NODE_ENV=production` و`REDIS_URL` ناقص أو الاتصال فشل، ثم `app.js` يخرج. هذا قديم. لا يثبت أن Redis ما زال حيًا بعد الإقلاع، ولا يثبت أن بيئة التشغيل تضع `NODE_ENV=production`.

لذلك قفل المحفظة الجديد ورفضه مطفآن. فحص المشغّل في `04-deployment-rollback.md` قسم «3ب». لا يُستخدم اسم المتغير `$pid`.

## MongoDB

الرفض قبل الخصم إذا كانت المعاملات مطلوبة والجلسة غير متاحة موجود على `main` في `controllers/clientTransactionController.js` و`services/balanceTransferService.js` و`src/Application/Services/TransferService.ts` عبر `requiresMongoTransactions()`. أمر `mongosh` للتحقق من `hello.setName` في القسم 3ب من خطة النشر. لا رفض جديد على إعداد replica set العامل.
