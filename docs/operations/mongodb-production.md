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
