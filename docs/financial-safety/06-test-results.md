# نتائج الاختبارات

هذه النتائج من بيئة الفحص على الفرع `fix/financial-tenant-safety` (Node.js 22.14.0). نجاحها ليس موافقة نشر.

## الاختبارات الجديدة

الأمر:

```powershell
npx jest tests/financialTenantSafety.test.js --runInBand --forceExit
```

النتيجة بعد تغليف الأعلام وقرار المنظومة الواحدة: 17 اختبارًا ناجحًا، 0 فاشل. الاختباران الإضافيان يثبتان أن غياب Redis لا يرفض التحويل ما دام `FINANCIAL_REDIS_FAIL_CLOSED` مطفأ، وأن `Idempotency-Key` يُتجاهل ما دام `FINANCIAL_IDEMPOTENCY_ENABLED` مطفأ (خصمان، وصفر مستندات بهذا المفتاح). اختبارات المنع ورفض Redis تشغّل العلم داخل الاختبار فقط.

تغطي: منظمتين منفصلتين، رفض البحث عبر المنظمة مع تجاهل `tenantId` القادم من العميل، رفض التحويل عبر المنظمة دون تغيير رصيد، تحويل داخل المنظمة بقيد مزدوج مجموعه صفر ومطابقة الرصيد للقيد، إعادة نفس `Idempotency-Key` دون خصم ثانٍ، نفس المفتاح مع طلب مختلف يعيد 409، فشل كتابة `Transaction` أو `Ledger` يرجع الخصم، غياب معاملات MongoDB يمنع الخصم، فشل Redis عند `REDIS_REQUIRED` و`FINANCIAL_REDIS_FAIL_CLOSED` يمنع الخصم، وغياب Redis بلا هذا العلم لا يمنع الخصم، 36 طلبًا متزامنًا (24 متطابقًا و12 متعارضًا) تنتج خصمًا واحدًا، الإلغاء مرتين لا يرد المبلغ مرتين، `tenantId` خارج حساب سلسلة `AuditLog`، وسجلات قديمة بلا `tenantId`.

## المجموعة الكاملة

الأمر (نفس أسرار CI التجريبية، وليست أسرار إنتاج):

```powershell
npx jest --forceExit --runInBand
```

النتيجة على هذا الفرع (Node 22.14.0): 184 مجموعة، 182 ناجحة و2 فاشلة. الاختبارات: 1140، منها 1138 ناجحة و2 فاشلة.

نفس الأمر على `main` عند `527c7821`: 183 مجموعة، 181 ناجحة و2 فاشلة. الاختبارات: 1123، منها 1121 ناجحة و2 فاشلة.

الفرق: مجموعة واحدة و17 اختبارًا، وكلها ناجحة. صفر فشل جديد. منها اختبار يثبت أن `TENANT_MODE=single` مع العلمين مشغّلين ما زال يحوّل من شركة بلا `tenantId` إلى وكيل بـ `tenantId` مختلف.

نفس الفشلين:

| الاختبار | النتيجة على main | النتيجة على الفرع |
| --- | --- | --- |
| `tests/mobileConsolidation.test.js` — تسجيل دخول المنفذ يتوقع 200 ويصل 500 | فاشل | فاشل (سابق) |
| `tests/mobileAuthContract.test.js` — T014 & T015 يتجاوز 5000ms | فاشل | فاشل (سابق) |

على `main` لهذين الملفين فقط: 2 فاشلة، 28 ناجحة، من أصل 30. لم يُضف فشل جديد.

`npm run lint` و`npm run typecheck` و`npm run check:architecture` نجحت على الفرع.

## فحص CI المعروف سابقًا

على `main` تفشل هذه الفحوصات بمعزل عن هذا العمل، كما هو موثّق في الطلب:

- Unit Tests على Node 22.x
- Security Audit: `npm audit --omit=dev --audit-level=high` يخرج بالرمز 1. الثغرات الظاهرة محليًا: `js-yaml` و`multer` (عالية) و`uuid` عبر `firebase-admin` (متوسطة). `mongodb-memory-server` اعتماد تطوير فقط ولا يدخل `npm audit --omit=dev`.
- Pipeline Summary يتوقف لأن Unit Tests 20.x تُلغى عندما تفشل 22.x

## تجربة التعبئة الجافة على قاعدة اختبار

ليست قاعدة إنتاج ولا Staging. الشكل يحاكي صفوفًا بلا `tenantId` وصفوفًا غامضة.

الأمر داخل الاختبار: `runBackfill({ apply: false })`. أمر المشغّل على Staging المستعادة من نسخة إنتاج حديثة:

```powershell
$env:MONGO_URI = '<سلسلة Staging المستعادة>'
node scripts/backfillFinancialTenantId.js
```

النتيجة الجافة على قاعدة الاختبار (`docs/financial-safety/migration-dry-run-report.json`):

| المجموعة | confident | ambiguous | unresolvable | modified |
| --- | --- | --- | --- | --- |
| Transaction | 1 | 1 | 1 | 0 |
| Ledger | 1 | 1 | 0 | 0 |
| JournalEvent | 0 | 0 | 1 | 0 |
| AuditLog | 1 | 0 | 1 | 0 |

بعد `--apply` على قاعدة الاختبار فقط: `LEG-OK-1` أخذ منظمة الشركة الواثقة، و`LEG-AMB-1` و`LEG-NO-1` بقيا بلا `tenantId`. الرصيد والمبلغ والحالة لم تتغير. فهرس `accountCode` الفريد المركّب لم يُنشأ (`runPrepare` في وضع `scan`).

يجب أن يعيد المشغّل التجربة الجافة على Staging قبل أي `--apply`. أرقام الجدول أعلاه ليست أرقام الإنتاج.
