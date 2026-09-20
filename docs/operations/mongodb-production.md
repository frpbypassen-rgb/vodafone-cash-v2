# تشغيل MongoDB للإنتاج

عمليات الرصيد والتحويلات تعتمد على معاملات MongoDB الذرية. لذلك يجب أن تكون قاعدة الإنتاج Replica Set أو Sharded Cluster. لا تستخدم MongoDB Standalone مع `MONGO_TRANSACTIONS_REQUIRED=true`.

## فحص الخادم

من مجلد المشروع شغّل:

```powershell
npm run check:mongo-transactions -- .env
```

يجب أن تظهر:

```text
Topology: replica-set:rs0
Read-only transaction probe: PASSED
```

إذا ظهرت `standalone` فلا تبدأ التطبيق المالي قبل إكمال الخطوات التالية.

## Windows MongoDB الموجود كخدمة

1. اعرض مسار إعداد الخدمة:

```powershell
Get-CimInstance Win32_Service -Filter "Name='MongoDB'" |
  Select-Object Name, State, PathName
```

2. افتح ملف `mongod.cfg` المشار إليه في `PathName` وأضف تحت المستوى الرئيسي:

```yaml
replication:
  replSetName: rs0
```

لا تحذف `storage.dbPath` ولا تغيّر مجلد البيانات.

3. أعد تشغيل خدمة MongoDB:

```powershell
Restart-Service MongoDB
```

4. فعّل المجموعة مرة واحدة فقط:

```powershell
mongosh --host 127.0.0.1:27017 --eval "try { rs.status() } catch (e) { rs.initiate({_id:'rs0', members:[{_id:0, host:'127.0.0.1:27017'}]}) }"
```

5. اجعل `MONGO_URI` في `.env` يشير إلى المجموعة:

```dotenv
MONGO_URI=mongodb://127.0.0.1:27017/vodafone_cash_system?replicaSet=rs0
MONGO_TRANSACTIONS_REQUIRED=true
```

6. أعد الفحص قبل إعادة تشغيل التطبيق:

```powershell
npm run check:mongo-transactions -- .env
```

## Docker Compose

ملفات Compose تضبط داخل حاوية التطبيق عنوان Mongo الداخلي:

```text
mongodb://mongo_db:27017/vodafone_cash_system?replicaSet=rs0
```

لذلك لا تستخدم `127.0.0.1` بين الحاويات. شغّل:

```powershell
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=100 mongo_rs_init ahram_core_prod
```

## مؤشرات النجاح

```powershell
curl.exe -sS https://ahrampay.com/health/ready
```

يجب أن تكون `status` هي `ok` و`db` هي `connected`. إذا كان MongoDB غير متاح، يبقى التطبيق في وضع آمن ولا ينفذ عمليات مالية جزئية.

## أداء الويب بعد الاستعادة (جلسات + أجهزة الأمان)

بعد استعادة Redis أو تنظيف فهارس Mongo، بطء البوابات غالباً يأتي من كتابة Mongo على كل طلب وليس من منطق الصفحات. الإصلاحات في الكود تخفّض ذلك تلقائياً، وابنِ هذه الفهارس مرة إن لم تكن موجودة (الإنتاج يعطّل `autoIndex`):

```javascript
db.securitydevices.createIndex(
  { principalType: 1, principalId: 1, status: 1 },
  { name: 'uniq_active_security_device_per_account', unique: true, partialFilterExpression: { status: 'active' } }
)
db.securitydevices.createIndex(
  { status: 1, lastSeenAt: -1 },
  { name: 'security_device_lastSeenAt' }
)
db.transactions.createIndex({ status: 1, createdAt: -1 }, { name: 'adminDashboard_status_createdAt' })
db.transactions.createIndex({ status: 1, completedAt: -1 }, { name: 'adminDashboard_status_completedAt' })
```

`connect-mongo` ينشئ فهرس TTL على `sessions.expires`. لا تحذف `uniq_active_security_device_per_account` عند كل إعادة تشغيل.

### PM2

أبقِ `Ahram_Core_API` على عملية واحدة (`instances: 1`) ما دام Socket.IO والـ cron داخل نفس العملية. Redis يبقى إلزامياً (`REDIS_REQUIRED=true`). لا ترفع عدد العمليات حتى ينخفض حمل كتابة Mongo (الجلسات + `lastSeenAt`). بعد الاستقرار يمكن تجربة عمليتين فقط إذا كان المعالج هو العائق، مع الإبقاء على Redis.

اختياري في `.env`:

```dotenv
SESSION_TOUCH_AFTER_SECONDS=120
SECURITY_STATE_CACHE_MS=15000
SECURITY_DEVICE_LAST_SEEN_MS=60000
SECURITY_DEVICE_RECHECK_MS=30000
```
