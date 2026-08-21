# تشغيل بيئة اختبار Merchant API

## الهدف

توفير بيئة آمنة للشركة المتكاملة لاختبار `balance` و`transfer` و`status` دون أي وصول إلى أرصدة، مفاتيح، منفذين، أو رسائل الإنتاج.

الرابط المخصص هو:

```text
https://sandbox-api.ahrampay.com/api/v1/merchant
```

## قواعد غير قابلة للتجاوز

1. استخدم قاعدة MongoDB مستقلة اسمها `ahram_pay_sandbox` فقط.
2. لا تنسخ بيانات العملاء أو الشركات أو الأرصدة من الإنتاج إلى Sandbox.
3. يجب أن تعمل قاعدة Sandbox كـ Replica Set وأن ينجح `npm run check:mongo-transactions`.
4. تبقى خدمات WhatChimp وFirebase وTelegram ومزودي التنفيذ الخارجية معطلة.
5. لا تسلّم مفتاح الاختبار في بريد أو مستند عام؛ يسلّم عبر قناة سرية للشركة فقط.

## إعداد الخادم

```powershell
cd C:\Users\Administrator\Desktop\vodafone-cash-v2
git pull --ff-only origin main
Copy-Item .env.staging.example .env.staging
notepad .env.staging
```

أنشئ أربعة أسرار مختلفة قبل التشغيل:

```powershell
1..5 | ForEach-Object { node -e "console.log(require('crypto').randomBytes(48).toString('hex'))" }
```

ضع القيم في `.env.staging`، وأهمها `MONGO_URI` لقاعدة الاختبار فقط و`PUBLIC_APP_URL=https://sandbox-api.ahrampay.com`.

شغّل البيئة:

```powershell
pm2 start ecosystem.config.js --only Ahram_Staging_API --env staging
pm2 save
pm2 status
```

## قاعدة بيانات Sandbox

يجب ألا تستخدم نفس MongoDB الإنتاجية. استخدم مثيل MongoDB منفصلاً أو Cluster منفصلاً في Atlas، ثم اجعل الرابط يحتوي على اسم قاعدة الاختبار واسم Replica Set، مثلاً:

```text
mongodb://sandbox-db-1:27017/ahram_pay_sandbox?replicaSet=rs0
```

## النطاق والشهادة

1. أضف سجل DNS من نوع `A`: `sandbox-api.ahrampay.com` إلى عنوان IP الخادم.
2. أضف شهادة TLS صحيحة للنطاق.
3. اضبط الـ reverse proxy لتمرير النطاق إلى `http://127.0.0.1:3100` فقط.
4. لا تفتح المنفذ `3100` للإنترنت مباشرة؛ وصول الإنترنت يكون عبر HTTPS فقط.

## إنشاء شركة الاختبار ومفتاح API

بعد تشغيل الخدمة، من الخادم:

```powershell
$env:DOTENV_CONFIG_PATH = ".env.staging"
$env:NODE_ENV = "staging"
node scripts/seedStagingMerchant.js --name "اسم الشركة" --balance 50000
```

يعرض الأمر مفتاح API مرة واحدة. لتدويره لاحقاً:

```powershell
node scripts/seedStagingMerchant.js --name "اسم الشركة" --balance 50000 --rotate-key
```

## اختبار الاستلام

```powershell
curl.exe -sS "https://sandbox-api.ahrampay.com/api/v1/merchant/balance" -H "x-api-key: TEST_KEY"
```

بعد نجاح `/balance` يمكن للشركة اختبار `POST /transfer` و`GET /status/{reference_id}` وفق [وثيقة التكامل](API-Integration-Guide-AR.md). لا يمنح Sandbox أي بيانات أو رصيد حقيقي.
