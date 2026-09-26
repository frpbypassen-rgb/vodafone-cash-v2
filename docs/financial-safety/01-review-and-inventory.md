# مراجعة المسارات والجرد

الأرقام من `main` `527c7821` قبل هذا الفرع. بعد التعديل انتقلت بعض الأسطر؛ المعنى هو نفسه.

## ماذا تعني المنظمة؟

- النموذج: `models/Tenant.js`.
- الحقل `tenantId` على حسابات `User` / `ClientCompany` / `SubAccount` وعلى `Transaction` و`Ledger` و`JournalEvent`.
- الحل من الجلسة يتم في `middlewares/tenantResolver.js` ويُخزَّن في `req.tenantId`. لا يُقرأ `req.body.tenantId`.
- الوضع الافتراضي `TENANT_MODE` هو `single`. عندها `utils/tenantScope.js` (`adminAccountScope`) لا يرشّح أدلة الإدارة، حتى لا تختفي شركات تاريخية.

## مسارات التحويل

### 1. تحويل الويب الخارجي (فودافون وغيره)

- الواجهة: `public/js/client-workspace.js`، `views/client/dashboard.ejs`، `views/client/partials/company_portal_scripts.ejs` → `POST /client/transfer`.
- المسار: `routes/clientPortal.js` → `controllers/clientTransactionController.js` الدالة `postTransfer`.
- يخصم محفظة العميل أو الشركة أو الوكيل، وفي نقطة البيع يخصم الاثنين.
- ينشئ `Transaction` و`Ledger`. لا ينشئ `JournalEvent` على هذا المسار.
- جلسة Mongo تُستخدم عند توفر replica set. عند `MONGO_TRANSACTIONS_REQUIRED` يتوقف قبل الخصم إذا تعذرت الجلسة.
- التدقيق كان يُكتب قبل `commit` وخارج الجلسة، وقفل السلسلة يُفك داخل `logAction` قبل اكتمال المعاملة الخارجية.

### 2. تحويل الرصيد الداخلي

- `POST /client/balance-transfer` و`/lookup`.
- `executeBalanceTransfer` في `services/balanceTransferService.js`.
- البحث كان عالميًا عبر `resolveAccountByCode` بلا `tenantId`.
- خصم المصدر، إضافة الهدف، مستندان `Transaction` (`-D` و`-C`)، وقيدان `Ledger`. لا `JournalEvent` لهذا المسار (لم نُضِف نوع حدث جديد حتى لا يتغير الدفتر).
- الويب لم يكن يرسل `Idempotency-Key`. الموبايل كان يمر عبر `executeBalanceTransferIdempotent`.

### 3. تطبيق الموبايل

- `routes/mobileApi.js` → `services/transferService.js` → `src/Application/Services/TransferService.ts` `createTransfer`.
- يخصم ثم `Transaction` + `Ledger` + `JournalEvent` (`MoneyWithdrawn`).
- `tenantId` كان يُؤخذ من `req.tenant` على المعاملة فقط، لا على القيد والحدث دائمًا.
- مفتاح منع التكرار موجود للموبايل ومربوط ببصمة المستخدم والحمولة، بدون `tenantId` ما لم يُفعَّل العلم الجديد.
- الإلغاء: `cancelTransfer` و`ReversalService.reverseTransaction` ينشئان قيود `REFUND` وأحداث `TransferReversed` ولا يحذفان القيد الأصلي داخل جلسة ناجحة.

### 4. إيداع وخصم الإدارة

- `routes/clients.js` حوالي 512 و658: `updateBalanceWithLedger` ثم `Transaction.create` داخل جلسة عندما تتوفر.
- إلغاء التسوية: `services/balanceAdjustmentService.js` `voidBalanceAdjustment` ينشئ `REVERSAL` ويرفض الإلغاء الثاني (`ADJUSTMENT_ALREADY_VOIDED`).

### 5. المنفذ

- طلب إيداع: `services/executorDepositRequestService.js` و`routes/executors.js` ينشئ `Transaction` بحالة `deposit_pending` بلا تحريك رصيد العميل حتى الاعتماد.
- إكمال المهمة وتحريك دفاتر المنفذ مسار تشغيلي منفصل. لم يُغيَّر معناه.

### 6. واجهة التاجر

- `routes/merchantApi.js` يخصم وينشئ `Transaction` و`Ledger`. خارج نطاق عزل المنظمة في هذا الفرع حتى لا يتغير عقد التاجر.

## جرد الكتابة المالية (قبل التعديل)

الجلسة = نعم تعني أن الكتابة تمر بـ `session` عندما تنجح `startTransaction`. «مشروط» يعني المسار البديل بدون جلسة ما زال موجودًا خارج الإنتاج.

| الموقع | العملية | داخل جلسة Mongo؟ |
| --- | --- | --- |
| `services/walletService.js` `updateBalanceWithLedger` | خصم/إضافة + `Ledger.save` | نعم في المسار الرئيسي. المسار البديل بدون جلسة يُمنع عندما `requiresMongoTransactions()` |
| `services/balanceTransferService.js` ~201-252 | `$inc` للطرفين ثم `Transaction.create` و`Ledger.create` | نعم إن وُجد replica set. بديل غير إنتاجي كان يحذف القيد والمعاملة عند الفشل |
| `controllers/clientTransactionController.js` `postTransfer` | `$inc` + `new Ledger` + `new Transaction` | نعم. التعويض بالحذف فقط عند غياب الجلسة وخارج `MONGO_TRANSACTIONS_REQUIRED` |
| `src/Application/Services/TransferService.ts` `createTransfer` | الخصم + Ledger + JournalEvent + Transaction | نعم في الاختبار والإنتاج عند توفر المعاملات. `NODE_ENV=test` يعتبر الجلسة متاحة في هذه الفئة |
| `src/Application/Services/ReversalService.ts` | إضافة رصيد + Ledger `REFUND` + JournalEvent `TransferReversed` + تحديث حالة المعاملة | نعم. المسار بلا جلسة يُمنع في الإنتاج |
| `services/balanceAdjustmentService.js` | `updateBalanceWithLedger` نوع `REVERSAL` | نعم عبر `runWithOptionalTransaction` |
| `routes/clients.js` إيداع/خصم | `updateBalanceWithLedger` + Transaction | نعم |
| `routes/merchantApi.js` ~321-375 | خصم + Transaction + Ledger | مشروط بالجلسة |
| `services/auditService.js` `logAction` | `AuditLog.save` | الجلسة اختيارية. القفل كان يُفك في `finally` قبل commit الخارجي |
| `controllers/clientWorkspaceController.js` ~379 | تسوية عميل وكيل عبر `updateBalanceWithLedger` | حسب `walletService` |

`AuditLog` لم يكن عليه حارس الإلحاق الذي على `Ledger` (`utils/financialRecordImmutability.js`). `calculateHash` لا يضم `tenantId`، وبقي كذلك حتى تبقى السجلات القديمة قابلة للتحقق.
