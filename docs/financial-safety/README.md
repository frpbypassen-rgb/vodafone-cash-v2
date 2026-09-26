# سلامة التحويل والمنظمة — Power Pay AL-Ahram

المراجعة على `main` عند `527c7821`. التعديل على الفرع `fix/financial-tenant-safety`. لا نشر، لا دمج، ولا اتصال بإنتاج.

## قرار المشغّل

المنظومة منظمة واحدة: أهرام باي. `TENANT_MODE=single` هو الوضع الصحيح. الشركات والوكلاء كلهم داخلها.

| البند | القرار |
| --- | --- |
| 1. تحويل رصيد بين شركة ووكيل | **مسموح** بكود الحساب، حتى لو اختلف `tenantId` المخزّن أو كان فارغًا. |
| 2. خصم نقطة البيع والوكيل/الشركة معًا | **يبقى كما هو.** لا يُرفض في وضع `single`. |
| 3. الإدارة والخزينة والمنفذ | **يحركون أي حساب.** المسارات لم تُقيَّد. |
| 4. حساب مقاصة للتحويل الخارجي | **خارج النطاق.** لا يُنفَّذ في هذا الطلب. التحويل الخارجي يبقى خصمًا من طرف واحد. ممكن لاحقًا بقرار جديد. |

`FINANCIAL_TENANT_GUARD` و`FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` يبقيان مطفأين. هما حماية مستقبلية لوضع `TENANT_MODE=multi` فقط. تشغيلهما مع `single` لا يرفض تحويل شركة↔وكيل: العلم لا يُطبَّق إلا في `multi`. صف بلا `tenantId` يُعامَل كـ `DEFAULT_TENANT_ID` عند المقارنة في وضع `multi`.

لا تُفعَّل القيود الجديدة إلا بعلم صريح. الأعلام التالية **مطفاة (OFF)**:

| العلم | الافتراضي | ماذا يتغير عند تشغيله |
| --- | --- | --- |
| `FINANCIAL_TENANT_GUARD` | OFF | لا أثر في `TENANT_MODE=single`. في `multi` فقط: البحث والتحويل الداخلي يُحصران في منظمة الخادم. |
| `FINANCIAL_IDEMPOTENCY_ENABLED` | OFF | الخادم يتجاهل `Idempotency-Key` على تحويل الويب وتحويل الرصيد الداخلي. النموذج يرسل المفتاح لكن بلا أثر. |
| `FINANCIAL_IDEMPOTENCY_REQUIRED` | OFF | يتطلب المفتاح. تشغيله يفعّل المنع أيضًا. |
| `FINANCIAL_IDEMPOTENCY_STRICT_BINDING` | OFF | بصمة تحويل تطبيق الموبايل (`TransferService`) تضم `tenantId` و`accountId`. لا تشغّله قبل انتهاء المفاتيح العالقة. |
| `FINANCIAL_AUDIT_IN_TRANSACTION` | OFF | تدقيق تحويل الويب والرصيد الداخلي يبقى خارج جلسة Mongo، ويُفك قفل السلسلة داخل `logAction` قبل `commit` كما في `main`. |
| `FINANCIAL_REDIS_FAIL_CLOSED` | OFF | لا قفل محفظة جديد، ولا رفض لتحويل ويب/رصيد داخلي إذا غاب Redis. قفل الموبايل القديم يبقى كما هو. |
| `FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH` | OFF | لا أثر في `single`. في `multi` فقط يمنع خصم نقطة البيع والوكيل معًا إذا بقيت المنظمتان مختلفتين بعد معاملة الصف الفارغ كالمنظمة الافتراضية. |

### 4. حساب المقاصة — خارج النطاق

قرار المشغّل: لا يُبنى حساب مقاصة في هذا الطلب. تحويل فودافون/الخارج يبقى خصم محفظة العميل فقط. القيد الذي مجموعه صفر هو تحويل الرصيد الداخلي بين حسابين. أي مقاصة لاحقة تحتاج قرارًا جديدًا لأنها تغيّر معنى الرصيد.

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
7. `07-active-without-flags.md` — ما الذي يبقى فعالًا وكل الأعلام مطفأة، وخطر كل بند.
8. `08-final-verification.md` — Redis وMongo وAuditLog والتجربة الجافة واختبارات الأعلام المطفأة.
9. `FINAL_REPORT.md` — التقرير النهائي: ما ثبُت هنا وما يبقى على المشغّل.
10. `migration-dry-run-report.json` و`account-code-index-scan.json` و`reconciliation-test.json` — ناتج قاعدة اختبار مقلَّدة، وليس إنتاجًا.

التشغيل الحقيقي للتجربة الجافة يكون على Staging مستعاد من نسخة إنتاج حديثة:

```powershell
node scripts/backfillFinancialTenantId.js
```
