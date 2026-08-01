# خطة تنفيذ Backend - تثبيت أسعار الصرف حسب مستوى العميل ونوع الخدمة لتطبيق Flutter

هذا الملف موجه لموديل/مطور الباك إند فقط. المطلوب تنفيذ تعديل محدود لكنه حساس داخل Mobile API حتى يستطيع تطبيق Flutter عرض سعر الصرف الصحيح لكل نوع تحويل بدون تخمين وبدون نقل أي منطق مالي حقيقي إلى التطبيق.

## 1. الهدف النهائي

تطبيق Flutter لا يحتاج أن يعرض للعميل رقم المستوى مثل `Tier 1` أو `Tier 2`، لكنه يحتاج أن يعرف برمجياً سعر الصرف الصحيح الذي يخص العميل حسب:

1. مستوى العميل في النظام.
2. نوع خدمة التحويل المختارة.

المطلوب من الباك إند أن يرسل للموبايل حقولاً واضحة وثابتة:

```json
{
  "tier": 2,
  "tierLabel": "مستوى 2",
  "baseExchangeRate": 6.45,
  "exchangeRate": 6.45,
  "serviceRates": {
    "vodafone": 6.45,
    "post_account": 6.40,
    "post_card": 6.30
  }
}
```

## 2. الحقائق المثبتة من الكود الحالي

هذه الحقائق ليست افتراضات:

1. إعدادات النظام تحتوي حالياً على 3 مستويات فقط في:
   - `models/Settings.js`
   - الحقول: `rateLevel1`, `rateLevel2`, `rateLevel3`

2. دالة تحديد سعر المستوى موجودة في:
   - `utils/rateHelper.js`
   - الدالة: `getRateForTier(tier, settings)`

3. منطق فرق السعر حسب نوع الخدمة موجود فعلياً في:
   - `src/Application/Services/TransferService.ts`
   - حالياً:
     - `vodafone`: السعر الأساسي للمستوى
     - `post_account`: السعر الأساسي ناقص `0.05`
     - `post_card`: السعر الأساسي ناقص `0.15`

4. معنى "9 أسعار" في النظام الحالي:
   - 3 مستويات عملاء × 3 أنواع خدمات = 9 أسعار خدمة فعالة.
   - لا يوجد حالياً 9 حقول مستقلة في `Settings`.

5. مخرجات Mobile API الحالية ترجع غالباً `exchangeRate` فقط، ولا ترجع `serviceRates` بشكل موحد في `login/home/exchange-rate`.

## 3. نطاق العمل المسموح

المطلوب تعديل Mobile API فقط، تحديداً:

1. `POST /api/mobile/login`
2. `GET /api/mobile/client/home`
3. `POST /api/mobile/client/exchange-rate`

ويجب تحديث الاختبارات والتوثيق الخاص بهذه المسارات.

## 4. خارج النطاق

ممنوع في هذه الخطة:

1. تغيير قاعدة البيانات أو إضافة Migration.
2. تغيير منطق الخصم أو تنفيذ التحويل.
3. تغيير قيم أسعار الصرف أو سياسة الإدارة.
4. تغيير Web routes.
5. تغيير صفحات الويب أو لوحة الإدارة.
6. جعل Flutter يرسل `tier` أو `exchangeRate` أو `serviceRates` للباك إند.
7. الاعتماد على أي قيمة قادمة من العميل في التسعير المالي.
8. حذف `exchangeRate` القديم من الردود.

## 5. التصميم المطلوب

### 5.1 إنشاء/توسيع Rate Helper مركزي

الملف:

```text
utils/rateHelper.js
```

المطلوب توسيعه بدل تكرار الحساب في أكثر من مكان.

أضف دوال واضحة مثل:

```js
const normalizeTier = (tier) => {
  const parsed = Number(tier);
  if (parsed === 2 || parsed === 3) return parsed;
  return 1;
};

const normalizeRate = (rate) => {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(2));
};

const getServiceRatesForBaseRate = (baseExchangeRate) => {
  const base = normalizeRate(baseExchangeRate);
  return {
    vodafone: base,
    post_account: normalizeRate(base - 0.05),
    post_card: normalizeRate(base - 0.15)
  };
};

const buildMobileRateContract = (tier, settings) => {
  const normalizedTier = normalizeTier(tier);
  const baseExchangeRate = normalizeRate(getRateForTier(normalizedTier, settings));
  return {
    tier: normalizedTier,
    tierLabel: `مستوى ${normalizedTier}`,
    baseExchangeRate,
    exchangeRate: baseExchangeRate,
    serviceRates: getServiceRatesForBaseRate(baseExchangeRate)
  };
};
```

مهم:

- لا تكسر الدالة الحالية `getRateForTier`.
- صدّر الدوال الجديدة مع القديمة:

```js
module.exports = {
  getRateForTier,
  normalizeTier,
  getServiceRatesForBaseRate,
  buildMobileRateContract
};
```

### 5.2 قاعدة `exchangeRate`

حقل `exchangeRate` يجب أن يظل موجوداً كما هو للتوافق مع Flutter الحالي.

القيمة المقترحة:

```text
exchangeRate = serviceRates.vodafone = baseExchangeRate
```

لأن `vodafone` هو نوع التحويل الافتراضي والأقدم.

### 5.3 قاعدة `serviceRates`

`serviceRates` يجب أن يحتوي فقط على الأنواع المعتمدة للموبايل:

```json
{
  "vodafone": 6.45,
  "post_account": 6.40,
  "post_card": 6.30
}
```

ممنوع إضافة خدمات الويب الأخرى هنا مثل خدمات الفواتير أو الكروت أو أي خدمات غير مدعومة في Flutter الحالي.

## 6. تعديلات الملفات بالتفصيل

### 6.1 `utils/rateHelper.js`

نفذ الدوال المذكورة في قسم التصميم.

معايير القبول:

1. `getRateForTier(1, settings)` لا يتغير سلوكه.
2. `buildMobileRateContract(2, settings)` يرجع:

```json
{
  "tier": 2,
  "tierLabel": "مستوى 2",
  "baseExchangeRate": 6.45,
  "exchangeRate": 6.45,
  "serviceRates": {
    "vodafone": 6.45,
    "post_account": 6.40,
    "post_card": 6.30
  }
}
```

### 6.2 `services/authService.js`

الملف يستخدم حالياً:

```js
const { getRateForTier } = require('../utils/rateHelper');
```

المطلوب:

1. استبدل أو وسّع الاستيراد:

```js
const { buildMobileRateContract } = require('../utils/rateHelper');
```

مع الاحتفاظ بـ `getRateForTier` فقط إذا ظل مستخدماً في نفس الملف.

2. بعد تحديد `tier` وجلب `settings`، ابن عقد السعر:

```js
const rateContract = buildMobileRateContract(tier, settings);
```

3. في نتيجة login أضف الحقول:

```js
tier: rateContract.tier,
tierLabel: rateContract.tierLabel,
baseExchangeRate: rateContract.baseExchangeRate,
exchangeRate: rateContract.exchangeRate,
serviceRates: rateContract.serviceRates,
```

4. لا تعرض أي إعدادات خام من `settings`.
5. لا تغير `token`, `refreshToken`, `accountType`, `context`.

### 6.3 `mappers/mobileAuthMapper.js`

المابر حالياً يتحقق من `exchangeRate` فقط.

المطلوب:

1. تعديل توثيق JSDoc ليشمل:
   - `tier`
   - `tierLabel`
   - `baseExchangeRate`
   - `serviceRates`

2. داخل `toLoginResponse` أضف الحقول مع تحقق صارم:

```js
tier: requireNumber(tier, 'tier'),
tierLabel: tierLabel ? String(tierLabel) : `مستوى ${Number(tier)}`,
baseExchangeRate: requireNumber(baseExchangeRate, 'baseExchangeRate'),
exchangeRate: requireNumber(exchangeRate, 'exchangeRate'),
serviceRates: requireServiceRates(serviceRates),
```

3. أضف دالة تحقق جديدة:

```js
const requireServiceRates = (value) => {
  if (!value || typeof value !== 'object') throw malformedAuthDto('serviceRates');
  return {
    vodafone: requireNumber(value.vodafone, 'serviceRates.vodafone'),
    post_account: requireNumber(value.post_account, 'serviceRates.post_account'),
    post_card: requireNumber(value.post_card, 'serviceRates.post_card')
  };
};
```

4. ممنوع تمرير أي keys إضافية داخل `serviceRates`.
5. ممنوع جعل `serviceRates` اختيارية في `login` بعد هذا التعديل.

### 6.4 `routes/mobileApi.js` - مسار `GET /client/home`

الموقع الحالي تقريباً حول:

```text
router.get('/client/home', authenticateJWT, async (req, res) => { ... })
```

المطلوب:

1. استيراد:

```js
const { buildMobileRateContract } = require('../utils/rateHelper');
```

مع الحفاظ على `getRateForTier` فقط لو مستخدم في مكان آخر.

2. بعد تحديد `tier` و`balance` و`settings`:

```js
const rateContract = buildMobileRateContract(tier, settings);
```

3. اجعل الرد:

```js
return res.json({
  success: true,
  balance: Number(balance),
  ...rateContract,
  isOpen: !(settings && settings.isManualClosed),
  serverTime: new Date().toISOString()
});
```

4. تأكد أن `exchangeRate` ما زال موجوداً في الرد.
5. لا تضف أي raw settings.

### 6.5 `routes/mobileApi.js` - مسار `POST /client/exchange-rate`

نفس قواعد `client/home` بالضبط.

الرد النهائي يجب أن يكون:

```json
{
  "success": true,
  "balance": 500,
  "tier": 2,
  "tierLabel": "مستوى 2",
  "baseExchangeRate": 6.45,
  "exchangeRate": 6.45,
  "serviceRates": {
    "vodafone": 6.45,
    "post_account": 6.40,
    "post_card": 6.30
  },
  "isOpen": true,
  "serverTime": "2026-06-15T..."
}
```

### 6.6 `src/Application/Services/TransferService.ts`

هذا الملف يحتوي بالفعل على منطق:

```ts
if (transferType === 'post_account') finalRate = currentRate - 0.05;
else if (transferType === 'post_card') finalRate = currentRate - 0.15;
```

المطلوب في هذه الخطة:

1. لا تغير منطق التحويل المالي إلا إذا كان هناك اختبار يثبت تعارضاً.
2. إن أمكن، استخدم نفس helper المركزي الجديد حتى لا يتكرر منطق فرق السعر.
3. لو استخدام helper من JS داخل TS سيعمل تعقيداً أو يكسر build، لا تنقله الآن؛ فقط أضف اختباراً يثبت أن القيم المطابقة:
   - `vodafone = base`
   - `post_account = base - 0.05`
   - `post_card = base - 0.15`

الأولوية هنا لعدم كسر مسار التحويل.

## 7. تحديث التوثيق

حدث الملفات المناسبة إن كانت موجودة:

1. `docs/Flutter-Mobile-API-Contract.md`
2. `docs/API-Reference.md`
3. أي Swagger/JSDoc داخل `routes/mobileApi.js`

يجب أن يتوثق في:

1. Login Response.
2. Client Home Response.
3. Exchange Rate Response.

## 8. الاختبارات المطلوبة

لا يعتبر التعديل مقبولاً بدون اختبارات.

### 8.1 اختبارات `utils/rateHelper.js`

أنشئ أو حدّث اختبار مناسب، مثال:

```text
tests/rateHelper.test.js
```

الحالات المطلوبة:

1. `buildMobileRateContract(1, settings)`:
   - `baseExchangeRate = 6.40`
   - `serviceRates.vodafone = 6.40`
   - `serviceRates.post_account = 6.35`
   - `serviceRates.post_card = 6.25`

2. `buildMobileRateContract(2, settings)`:
   - `baseExchangeRate = 6.45`
   - `serviceRates.vodafone = 6.45`
   - `serviceRates.post_account = 6.40`
   - `serviceRates.post_card = 6.30`

3. `buildMobileRateContract(3, settings)`:
   - `baseExchangeRate = 6.50`
   - `serviceRates.vodafone = 6.50`
   - `serviceRates.post_account = 6.45`
   - `serviceRates.post_card = 6.35`

4. أي tier غير صالح يرجع tier 1.

5. عدم وجود settings يرجع fallback آمن حسب سلوك `getRateForTier`.

### 8.2 اختبارات Login Contract

حدّث:

```text
tests/mobileAuthContract.test.js
```

أضف توقعات صريحة:

```js
expect(res.body.tier).toBeDefined();
expect(res.body.baseExchangeRate).toBeDefined();
expect(res.body.exchangeRate).toBe(res.body.serviceRates.vodafone);
expect(res.body.serviceRates).toEqual({
  vodafone: expect.any(Number),
  post_account: expect.any(Number),
  post_card: expect.any(Number)
});
```

واختبر حساب عميل tier 1 وحساب شركة tier 2 أو 3 إن كان موجوداً في mock.

### 8.3 اختبارات Client Home

حدّث أو أضف في:

```text
tests/transferFlow.test.js
```

أو ملف contract منفصل.

المطلوب:

1. `GET /client/home` يرجع `serviceRates`.
2. `exchangeRate = serviceRates.vodafone`.
3. `post_account` و`post_card` محسوبان من نفس `baseExchangeRate`.
4. لا يرجع `rateLevel1/rateLevel2/rateLevel3` كحقول خام.

### 8.4 اختبارات Exchange Rate Endpoint

أضف أو حدّث اختبار:

```text
POST /api/mobile/client/exchange-rate
```

المطلوب:

1. يرجع نفس شكل `client/home`.
2. يرجع `balance`.
3. يرجع `tier/baseExchangeRate/exchangeRate/serviceRates`.
4. يمنع executor من الوصول كما هو حالياً.

### 8.5 اختبار عدم تسريب Raw Fields

حدّث:

```text
tests/mobileNoRawFields.test.js
```

تأكد أن الردود لا تحتوي على:

```text
rateLevel1
rateLevel2
rateLevel3
settings
webPassword
password
```

السماح فقط بـ:

```text
tier
tierLabel
baseExchangeRate
exchangeRate
serviceRates
```

## 9. أوامر التحقق الإلزامية

من جذر الباك إند:

```powershell
npm test -- --runInBand
```

ثم فحص سريع لعدم ترك منطق متكرر أو حقول خام في الردود:

```powershell
rg -n "rateLevel1|rateLevel2|rateLevel3" routes controllers services mappers src tests docs
```

ظهور `rateLevel*` داخل الموديلات أو الاختبارات أو helper مقبول، لكن ممنوع ظهوره كحقل Response في Mobile API.

## 10. معايير القبول النهائية

التعديل يعتبر مكتمل فقط إذا تحقق الآتي:

1. `POST /api/mobile/login` يرجع:
   - `tier`
   - `tierLabel`
   - `baseExchangeRate`
   - `exchangeRate`
   - `serviceRates`

2. `GET /api/mobile/client/home` يرجع نفس حقول السعر.

3. `POST /api/mobile/client/exchange-rate` يرجع نفس حقول السعر.

4. `exchangeRate` لم يتم حذفه ولم يتغير معناه التوافقي.

5. `serviceRates` تحتوي فقط:
   - `vodafone`
   - `post_account`
   - `post_card`

6. لا يوجد اعتماد على أي قيمة يرسلها Flutter لتحديد السعر.

7. لا يوجد تسريب لـ `rateLevel1/2/3` في أي response للموبايل.

8. منطق التحويل الحقيقي لا ينكسر.

9. كل الاختبارات تنجح.

10. يتم تحديث التوثيق الرسمي للعقد.

## 11. شكل الرد النهائي المطلوب من الموديل المنفذ

بعد التنفيذ، يجب أن يرد بالآتي فقط:

1. الملفات التي تم تعديلها.
2. ملخص التغيير في كل ملف.
3. أمثلة response حقيقية أو من الاختبار لـ:
   - login
   - client/home
   - client/exchange-rate
4. نتيجة:

```powershell
npm test -- --runInBand
```

5. أي نقطة مؤجلة إن وجدت، مع سبب واضح.

ممنوع أن يقول "تم" فقط بدون نتائج اختبارات وأمثلة Response.
