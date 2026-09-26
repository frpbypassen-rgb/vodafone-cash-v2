# المراقبة ومطابقة mongosh

شغّل على Staging أو على قراءة إنتاج ثانوية. لا تحديث في هذه الاستعلامات.

```javascript
// رصيد الحساب مقابل مجموع القيود. الفرق يجب أن يساوي الرصيد قبل أول قيد محفوظ.
db.ledgers.aggregate([
  { $group: { _id: { entityId: '$entityId', entityModel: '$entityModel' }, ledgerSum: { $sum: '$amount' } } }
])

// لكل تحويل رصيد داخلي: مجموع القيود لنفس transactionId يساوي صفرًا
db.ledgers.aggregate([
  { $match: { transactionId: /^BTR-/ } },
  { $group: { _id: '$transactionId', net: { $sum: '$amount' }, count: { $sum: 1 } } },
  { $match: { net: { $ne: 0 } } }
])

// مفاتيح منع تكرار مكررة — يجب أن تكون النتيجة فارغة
db.transactions.aggregate([
  { $match: { idempotencyKey: { $type: 'string' } } },
  { $group: { _id: '$idempotencyKey', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
])

// قيود تحويل داخلي بطرفي منظمة مختلفين
db.ledgers.aggregate([
  { $match: { transactionId: /^BTR-/, tenantId: { $type: 'objectId' } } },
  { $group: { _id: '$transactionId', tenants: { $addToSet: '$tenantId' } } },
  { $match: { 'tenants.1': { $exists: true } } }
])

// صفوف مالية بلا tenantId
['transactions', 'ledgers', 'journalevents', 'auditlogs'].forEach((name) => {
  const n = db.getCollection(name).countDocuments({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }] });
  print(name + ' missing tenantId: ' + n);
})
```

أسماء المجموعات عند Mongoose تكون عادة بالجمع الصغير: `transactions` و`ledgers` و`journalevents` و`auditlogs`. تأكد بـ `show collections` إذا اختلف الجمع.

`/health/ready` يجب أن يبقى `ok` أثناء النشر. الأعلام المعروضة فيه معلوماتية ولا تُسقط الجاهزية وحدها.
