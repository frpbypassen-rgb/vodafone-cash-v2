# مخطط حركة المال

## قبل التعديل

```mermaid
flowchart TD
  web["نموذج الويب /client/transfer أو /balance-transfer"] --> ctrl["المتحكم"]
  mobile["تطبيق الموبايل"] --> ts["TransferService"]
  ctrl --> lookup["resolveAccountByCode بلا منظمة"]
  lookup --> any["أي حساب بنفس الكود في كل المنظمات"]
  ctrl --> debit["خصم الرصيد"]
  debit --> tx["Transaction و Ledger"]
  tx --> audit["AuditLog خارج الجلسة ثم commit"]
  ts --> debit2["خصم"]
  debit2 --> books["Transaction و Ledger و JournalEvent"]
  books --> audit2["AuditLog بعد commit"]
```

إعادة إرسال نموذج الويب بلا مفتاح يمكن أن تخصم مرة ثانية. بحث الكود لا يتوقف عند حد المنظمة.

## بعد التعديل والأعلام مطفأة

```mermaid
flowchart TD
  form["النموذج يولد Idempotency-Key ويبقيه حتى النتيجة"] --> guard["resolveStampTenant من req.tenantId فقط"]
  guard --> key{"المفتاح موجود؟"}
  key -->|لا| current["السلوك الحالي: لا رفض"]
  key -->|نعم ونفس البصمة| replay["إرجاع النتيجة المخزنة بلا خصم"]
  key -->|نعم وبصمة مختلفة| conflict["409 بلا خصم"]
  key -->|جديد| lock["قفل Redis إن كان مطلوبًا وإلا ذاكرة العملية"]
  lock --> mongo{"جلسة Mongo متاحة أو غير مطلوبة؟"}
  mongo -->|مطلوبة وغير متاحة| stop["503 قبل الخصم"]
  lock -->|فشل Redis في الإنتاج| stop2["503 قبل الخصم"]
  mongo -->|نعم| txn["معاملة واحدة: خصم وإضافة وTransaction وLedger وتدقيق"]
  txn --> commit["commit ثم فك قفل سلسلة التدقيق"]
```

عند `FINANCIAL_TENANT_GUARD=true` تُضاف بوابة قبل الخصم: منظمة الطلب يجب أن تطابق حساب الخصم، وهدف تحويل الرصيد يجب أن يكون في المنظمة نفسها. غير ذلك 403/503 والرصيد لا يتغير.

إلغاء العملية ينشئ قيد `REFUND` أو `REVERSAL` ولا يعدّل القيد الأصلي. الإلغاء الثاني لا يضيف رصيدًا مرة أخرى.
