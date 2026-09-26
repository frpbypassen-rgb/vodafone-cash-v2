# سلامة التحويل والمنظمة — Power Pay AL-Ahram

المراجعة على `main` عند `527c7821`. التعديل على الفرع `fix/financial-tenant-safety`. لا نشر، لا دمج، ولا اتصال بإنتاج.

## أسئلة السياسة المفتوحة — POLICY STOP

لا تُفعَّل القيود الجديدة إلا بعلم صريح. الأعلام التالية **مطفاة (OFF)** وتحافظ على السلوك الحالي:

| العلم | الافتراضي | ماذا يتغير عند تشغيله |
| --- | --- | --- |
| `FINANCIAL_TENANT_GUARD` | OFF | بحث `accountCode` وتحويل الرصيد الداخلي يُحصران في `tenantId` القادم من الخادم. اختلاف المنظمة أو غيابها يرفض العملية قبل الخصم. |
| `FINANCIAL_IDEMPOTENCY_REQUIRED` | OFF | الطلب بلا `Idempotency-Key` يُرفض. إن وُجد المفتاح يُحترم حتى والعلم مطفأ. |
| `FINANCIAL_IDEMPOTENCY_STRICT_BINDING` | OFF | بصمة تحويل تطبيق الموبايل (`TransferService`) تضم `tenantId` و`accountId`. لا تشغّله قبل انتهاء المفاتيح العالقة. |
| `FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` | OFF | يمنع خصم نقطة البيع والوكيل معًا إذا اختلف `tenantId`. |

### 1. تحويل الرصيد بين شركة ووكيل بحسابين مختلفي المنظمة

السلوك الحالي يسمح به. `executeBalanceTransfer` كان يستدعي `resolveAccountByCode` بلا نطاق منظمة، و`AccountCode.code` فريد عالميًا (`models/AccountCode.js`). في وضع `TENANT_MODE=single` (الافتراضي) دالة `adminAccountScope` في `utils/tenantScope.js` لا ترشّح بالمنظمة لأن صفوف الإنتاج قد تحمل `tenantId` تاريخيًا مختلفًا أو فارغًا.

**السؤال:** هل تحويل LYD بين `ClientCompany` و`User` (وكيل) مسموح عندما تختلف `tenantId` أو تكون إحداهما فارغة؟ إلى أن يُحسم، العلم `FINANCIAL_TENANT_GUARD` يبقى مطفأ.

### 2. الوكيل ونقطة البيع `SubAccount` عبر منظمتين

تحويل الويب (`controllers/clientTransactionController.js` مسار `isSubAccount`) وتحويل الموبايل (`src/Application/Services/TransferService.ts`) يخصمان **رصيد نقطة البيع ورصيد الوكيل/الشركة معًا**. هذا معنى الرصيد الحالي لعملية نقطة البيع، ولم يُغيَّر.

**السؤال:** إذا كانت نقطة البيع في منظمة والوكيل في أخرى، هل تُرفض العملية؟ العلم `FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` يبقى مطفأ.

### 3. إيداع/خصم الإدارة وخزينة المنفذ

`routes/clients.js` و`services/balanceAdjustmentService.js` وطلبات إيداع المنفذ (`services/executorDepositRequestService.js` ومسار `ReversalService`) لم يُعاد تعريف من يُخصم ومن يُضاف. الخزينة والمنفذ ليسا تحويل عميل-إلى-عميل.

**السؤال:** هل يحق للإدارة أو لخزينة المنفذ تحريك رصيد حساب في منظمة أخرى؟ المسار بقي كما هو.

### 4. قيد التحويل الخارجي ليس قيدًا مزدوجًا داخل الدفاتر

تحويل فودافون/الخارج يخصم محفظة العميل فقط. الطرف المقابل خارج المنظومة. لم نُضف حساب مقاصة حتى لا يتغير معنى الرصيد. القيد المزدوج المتوازن (المجموع = 0) هو تحويل الرصيد الداخلي بين حسابين.

## ما هي المنظمة في هذا المستودع؟

`Tenant` نموذج مستقل (`models/Tenant.js`): الاسم، `slug`، الحالة، مفتاح API. ليست الشركة `ClientCompany` ولا الوكيل `User.role=agent`.

`tenantId` موجود على `User` و`ClientCompany` و`SubAccount` و`Transaction` و`Ledger` و`JournalEvent` وغيرها.

يُستنتج على الخادم في `middlewares/tenantResolver.js` بالترتيب: ترويسة `x-tenant-id` فقط مع سر التوجيه أو تطابق جلسة، ثم `x-tenant-api-key`، ثم النطاق الفرعي في وضع `multi`، ثم `DEFAULT_TENANT_ID` / `DEFAULT_TENANT_SLUG`. الناتج `req.tenant` و`req.tenantId` و`req.session.tenantId`. جسم الطلب لا يُعتمد.

## محتويات المجلد

1. `01-review-and-inventory.md` — مسارات التحويل وجرد الخصم/الإضافة.
2. `02-problem-and-plan.md` — السبب، التنفيذ، الأثر، الرجوع.
3. `03-diagrams.md` — مخطط التدفق قبل وبعد.
4. `04-deployment-rollback.md` — خطة التشغيل على Windows PowerShell.
5. `05-monitoring.md` — استعلامات المطابقة.
6. `06-test-results.md` — أوامر الاختبار والعدّ، والفشل السابق على `main`.
7. `migration-dry-run-report.json` — ناتج التجربة على قاعدة اختبار مقلَّدة، وليس إنتاجًا.

التشغيل الحقيقي للتجربة الجافة يكون على Staging مستعاد من نسخة إنتاج حديثة:

```powershell
node scripts/backfillFinancialTenantId.js
```
