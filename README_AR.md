# حزمة تسليم Backend Mobile API لتطبيق Flutter

هذه الحزمة مخصصة فقط لتحديث مسارات `/api/mobile` التي يحتاجها تطبيق Flutter. لا ترفع باقي تغييرات المشروع عشوائياً.

## الهدف

- تثبيت عقد API واضح لتطبيق Flutter.
- إصلاح مشاكل تسجيل الدخول، نوع الحساب، وتجديد التوكن.
- تجهيز بيانات الرئيسية للعميل.
- تأمين طلب التحويل الجديد ضد التكرار المالي.
- حماية الإيصالات من كشف روابط Telegram المباشرة.
- توحيد شكل الأخطاء حتى لا تظهر أخطاء خام داخل التطبيق.

## الملفات المطلوب رفعها

انسخ محتويات هذه الحزمة فوق نفس المسارات في مشروع الباك إند:

- `routes/mobileApi.js`
- `controllers/auth/authController.js`
- `services/authService.js`
- `services/securityService.js`
- `services/transferService.js`
- `services/auditService.js`
- `repositories/userRepository.js`
- `repositories/settingsRepository.js`
- `mappers/mobileAuthMapper.js`
- `mappers/mobileErrorMapper.js`
- `middlewares/correlationId.js`
- `middlewares/requireIdempotencyKey.js`
- `middlewares/jwtAuth.js`
- `validators/mobileValidators.js`
- `utils/rateHelper.js`
- `utils/logger.js`
- `models/Transaction.js`
- `models/User.js`
- `models/ClientEmployee.js`
- `models/Employee.js`
- `models/ClientBot.js`
- `models/Settings.js`
- `models/Ledger.js`
- `models/AuditLog.js`

ملفات الاختبار المرفقة داخل `tests/` لل verification ولا يلزم رفعها للإنتاج، لكنها مهمة جداً قبل اعتماد النشر.

## شروط قبل الرفع

1. خذ نسخة احتياطية من الملفات القديمة قبل الاستبدال.
2. تأكد أن `app.js` مركب المسار كالتالي:

```js
app.use('/api/mobile', require('./routes/mobileApi'));
```

3. تأكد أن متغيرات البيئة موجودة وقوية:

```env
JWT_SECRET=<secret at least 32 chars>
JWT_REFRESH_SECRET=<secret at least 32 chars>
ADMIN_BOT_TOKEN=<required for receipt upload/proxy when used>
CLIENT_BOT_TOKEN=<optional fallback for receipts>
```

4. تأكد أن هذه الحزم موجودة في `package.json` أو مثبتة:

```bash
npm install express-rate-limit express-validator
```

## اختبارات قبل تشغيل السيرفر

شغل هذه الأوامر بعد نسخ الملفات:

```powershell
node --check routes\mobileApi.js
node --check services\transferService.js
node --check controllers\auth\authController.js
node --check validators\mobileValidators.js
npm test -- --runInBand --detectOpenHandles
```

النتيجة المقبولة حالياً:

- اختبارات Auth ناجحة.
- اختبارات Transfer ناجحة.
- اختبارات Receipt Security ناجحة.
- لا يوجد فشل في الاختبارات.
- وجود بعض `describe.skip` مقبول فقط للميزات غير المكتملة بعد مثل Transactions و Executor full flow.

## اختبارات Staging الآمنة بدون معاملة مالية

بعد النشر على staging، اختبر فقط:

```http
POST /api/mobile/login
GET /api/mobile/client/home
POST /api/mobile/client/exchange-rate
POST /api/mobile/refresh-token
GET /api/mobile/executor/live-tasks
```

لا تختبر:

```http
POST /api/mobile/client/new-transfer
```

إلا بعد موافقة صريحة على تفاصيل معاملة اختبار صغيرة.

## العقد المتوقع لتطبيق Flutter

### Login

`POST /api/mobile/login`

يجب أن يرجع:

```json
{
  "success": true,
  "token": "...",
  "refreshToken": "...",
  "expiresIn": 3600,
  "refreshExpiresIn": 2592000,
  "id": "...",
  "accountType": "client_user",
  "name": "...",
  "balance": 0,
  "exchangeRate": 6.2,
  "isOpen": true,
  "serverTime": "...",
  "context": {}
}
```

القيم الرسمية لـ `accountType`:

- `client_user`
- `client_company`
- `executor`

### Client Home

`GET /api/mobile/client/home`

يجب أن يرجع:

```json
{
  "success": true,
  "balance": 0,
  "exchangeRate": 6.2,
  "isOpen": true,
  "serverTime": "..."
}
```

### Exchange Rate Compatibility

`POST /api/mobile/client/exchange-rate`

يرجع نفس حقول الرئيسية خلال فترة التوافق:

```json
{
  "success": true,
  "balance": 0,
  "exchangeRate": 6.2,
  "isOpen": true,
  "serverTime": "..."
}
```

### New Transfer

`POST /api/mobile/client/new-transfer`

إلزامي إرسال:

```http
Idempotency-Key: <uuid-v4>
Authorization: Bearer <token>
```

Body:

```json
{
  "transferType": "vodafone",
  "amount": 100,
  "number": "01012345678",
  "name": "اختياري حسب النوع",
  "notes": "اختياري"
}
```

القيم الرسمية لـ `transferType`:

- `vodafone`
- `post_account`
- `post_card`

ممنوع الاعتماد على قيم عربية مثل `كاش` داخل API.

## ما تم تأمينه

- رفض أي تحويل بدون `Idempotency-Key`.
- رفض أي `Idempotency-Key` ليس UUID.
- نفس المفتاح مع نفس البيانات يرجع `DUPLICATE_REPLAYED` دون خصم جديد.
- نفس المفتاح مع بيانات مختلفة يرجع `IDEMPOTENCY_CONFLICT`.
- لا يتم قبول `costLYD` من Flutter.
- لا يتم السماح للمنفذ باستدعاء مسار تحويل العميل.
- لا يتم تسجيل `number`, `notes`, `idempotencyKey` في audit/log الخاص بإنشاء التحويل.
- لا يتم إرجاع Telegram URL مباشر للإيصالات.
- رابط الإيصال المؤقت يحتاج توكن، مرتبط بنفس المستخدم، ويستخدم مرة واحدة فقط.

## Rollback

لو ظهر خطأ بعد النشر:

1. أوقف السيرفر أو اعمل maintenance مؤقت.
2. أعد الملفات القديمة من النسخة الاحتياطية.
3. أعد تشغيل السيرفر.
4. لا تغير قاعدة البيانات يدوياً.

التغييرات على موديل `Transaction` إضافية وليست حذفاً للبيانات:

- `idempotencyFingerprint`
- `idempotencyResponse`

## ملاحظات مهمة لفريق Flutter

هذه الحزمة لا تجعل كل المشروع مكتملاً. هي تغلق نطاق الربط الحالي المهم لتطبيق Flutter:

- Auth
- Client Home
- Transfer
- Receipt Proxy
- Error Envelope

المراحل التالية التي ما زالت تحتاج API منفصل:

- سجل العمليات وتفاصيل العملية.
- تدفق المنفذ الكامل.
- التسجيل من داخل التطبيق.
- متجر الكروت أو نقاط البيع، إذا تم اعتمادها لاحقاً.
